import { randomUUID } from 'node:crypto';
import { getPool, many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { addDays, startOfWeek } from './dates.js';
import { familyToday, getFamily, pointsToCents } from './family.js';
import { addMoney, lockUser, moneyBalance } from './ledger.js';
import { audit } from './audit.js';
import { pointsEarnedBetween } from './gamification.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { chargeLoans } from './bank.js';
import { fmtMoney } from './currency.js';
import { whoText } from './kinship.js';
import { removePhotoFile } from './photos.js';
import { evaluateBadges } from './gamification.js';

/**
 * Interés semanal de una meta: tasa % del ahorro, redondeado al euro de arriba y con un mínimo de 1 €.
 * Se calcula con enteros (tasa en centésimas de punto) para que no haya errores de coma flotante.
 */
export function savingsInterestCents(principalCents: number, ratePercent: number): number {
  if (principalCents <= 0) return 0;
  const rateBp = Math.round(ratePercent * 100);
  const euros = Math.ceil((principalCents * rateBp) / 1_000_000);
  return Math.max(1, euros) * 100;
}

/**
 * Saldo de una meta: capital (lo que puso el hijo), interés (lo que han pagado los padres) y aportes
 * (el empujón de los padres y los premios de parientes). Interés y aportes se pierden si se saca el ahorro antes de llegar a la meta.
 */
export async function goalAmounts(db: Db, goalId: string) {
  const r = await one<{ balance: number; interest: number; earned: number; gifts: number; matched: number }>(
    db,
    `SELECT COALESCE(SUM(delta_cents),0)::int AS balance,
            COALESCE(SUM(delta_cents) FILTER (WHERE kind IN ('interest','interest_forfeit')),0)::int AS interest,
            COALESCE(SUM(delta_cents) FILTER (WHERE kind = 'interest'),0)::int AS earned,
            COALESCE(SUM(delta_cents) FILTER (WHERE kind IN ('goal_match','goal_gift','goal_reversal')),0)::int AS gifts,
            COALESCE(SUM(delta_cents) FILTER (WHERE kind = 'goal_match'),0)::int AS matched
       FROM money_ledger WHERE goal_id = $1 AND account = 'savings'`,
    [goalId],
  );
  return { balance: r!.balance, interest: r!.interest, gifts: r!.gifts, matched: r!.matched, principal: r!.balance - r!.interest - r!.gifts, earned: r!.earned };
}

/**
 * Media de lo ganado por semana en las últimas 4 semanas cerradas (lunes a domingo), en céntimos.
 * Solo cuentan las semanas desde que existe el hijo. Devuelve null si no hay datos (ninguna semana cerrada o nada ganado).
 */
export async function weeklyEarnedCents(db: Db, userId: string, now = new Date()): Promise<number | null> {
  const u = await one<{ family_id: string; created_at: Date }>(db, 'SELECT family_id, created_at FROM users WHERE id = $1', [userId]);
  if (!u) return null;
  const fam = await getFamily(db, u.family_id);
  const thisWeek = startOfWeek(familyToday(fam, now));
  const firstWeek = startOfWeek(familyToday(fam, u.created_at));
  let weeks = 0;
  let points = 0;
  for (let k = 1; k <= 4; k++) {
    const ws = addDays(thisWeek, -7 * k);
    if (ws < firstWeek) break;
    weeks++;
    points += Math.max(0, await pointsEarnedBetween(db, userId, ws, addDays(ws, 6), fam.timezone));
  }
  if (weeks === 0 || points <= 0) return null;
  const cents = Math.floor((points * fam.rate_cents) / (fam.rate_points * weeks));
  return cents > 0 ? cents : null;
}

export async function listGoals(db: Db, userId: string, now = new Date()) {
  const goals = await many(
    db,
    `SELECT g.*, (SELECT row_to_json(q) FROM (SELECT id, kind, status, created_at FROM goal_requests r WHERE r.goal_id = g.id AND r.status = 'pending') q) AS pending_request
       FROM savings_goals g WHERE g.user_id = $1 AND NOT g.archived ORDER BY (g.status <> 'active'), g.created_at`,
    [userId],
  );
  const weekly = goals.some((g) => g.status === 'active') ? await weeklyEarnedCents(db, userId, now) : null;
  return Promise.all(
    goals.map(async ({ photo_path, ...g }) => {
      const a = await goalAmounts(db, g.id);
      const left = Math.max(0, g.target_cents - a.balance);
      const contributions = await many(
        db,
        `SELECT l.id, l.kind, l.delta_cents AS cents, l.note, l.created_at, EXISTS (SELECT 1 FROM money_ledger x WHERE x.kind = 'goal_reversal' AND x.ref_id = l.id) AS reversed
           FROM money_ledger l WHERE l.goal_id = $1 AND l.account = 'savings' AND l.kind IN ('goal_match','goal_gift') ORDER BY l.created_at DESC, l.seq DESC LIMIT 5`,
        [g.id],
      );
      return {
        ...g, has_photo: !!photo_path, principal_cents: a.principal, interest_cents: a.interest, interest_earned_cents: a.earned, contributions_cents: a.gifts,
        matched_cents: a.matched, balance_cents: a.balance, reached: g.status === 'active' && a.balance >= g.target_cents, contributions,
        weekly_cents: g.status === 'active' ? weekly : null,
        weeks_left: g.status === 'active' && weekly && left > 0 ? Math.ceil(left / weekly) : null,
      };
    }),
  );
}

async function loadGoal(db: Db, familyId: string, goalId: string) {
  const g = await one(db, 'SELECT * FROM savings_goals WHERE id = $1 AND family_id = $2 AND NOT archived FOR UPDATE', [goalId, familyId]);
  if (!g) throw notFound('Meta no encontrada');
  return g;
}

function assertOwnerOrAdult(actor: AuthUser, g: { user_id: string }) {
  if (actor.role === 'child' && actor.id !== g.user_id) throw forbidden();
}

const hasPendingRequest = async (db: Db, goalId: string) => !!(await one(db, `SELECT 1 FROM goal_requests WHERE goal_id = $1 AND status = 'pending'`, [goalId]));

/** Meter dinero de la cuenta de dinero en una meta. */
export async function goalDeposit(actor: AuthUser, goalId: string, p: { cents: number; idempotencyKey?: string }) {
  if (!Number.isInteger(p.cents) || p.cents <= 0) throw badRequest('Importe no válido');
  return tx(async (db) => {
    const g = await loadGoal(db, actor.familyId, goalId);
    assertOwnerOrAdult(actor, g);
    if (g.status !== 'active') throw conflict('Esta meta ya está cerrada', 'goal_closed');
    if (await hasPendingRequest(db, goalId)) throw conflict('Esta meta tiene una petición esperando a un adulto', 'goal_pending');
    await lockUser(db, g.user_id);
    const key = p.idempotencyKey ? `gdep:${actor.familyId}:${goalId}:${p.idempotencyKey}` : null;
    if (key && (await one(db, 'SELECT 1 FROM money_ledger WHERE idempotency_key = $1', [`${key}:out`]))) return { duplicate: true, ...(await goalAmounts(db, goalId)) };
    if ((await moneyBalance(db, g.user_id)) < p.cents) throw conflict('No tienes tanto dinero en la cuenta', 'insufficient_balance');
    const a = await addMoney(db, { familyId: actor.familyId, userId: g.user_id, deltaCents: -p.cents, kind: 'transfer', refId: goalId, note: `Ahorro: ${g.title}`, createdBy: actor.id, idempotencyKey: key ? `${key}:out` : null });
    if (a.duplicate) return { duplicate: true, ...(await goalAmounts(db, goalId)) };
    const inn = await addMoney(db, { familyId: actor.familyId, userId: g.user_id, account: 'savings', goalId, deltaCents: p.cents, kind: 'transfer', refId: goalId, note: `Ahorro: ${g.title}`, createdBy: actor.id, idempotencyKey: key ? `${key}:in` : null });
    // El empujón de los padres (si hay regla) se suma a lo que ahorra el hijo.
    const fam0 = await getFamily(db, actor.familyId);
    await applyMatch(db, g, p.cents, inn.id ?? randomUUID(), fam0.currency);
    await audit(db, actor.familyId, actor.id, 'savings.deposit', 'savings_goal', goalId, { cents: p.cents, title: g.title, for: g.user_id });
    const fam = await getFamily(db, actor.familyId);
    await evaluateBadges(db, g.user_id, familyToday(fam), fam.timezone, 0);
    return { duplicate: false, entry_id: a.id ?? null, ...(await goalAmounts(db, goalId)) };
  });
}

/**
 * Sacar el ahorro antes de llegar a la meta: el capital vuelve a la cuenta de dinero y el interés
 * ganado se pierde (queda anotado como «interest_forfeit»).
 */
export async function goalWithdrawEarly(actor: AuthUser, goalId: string) {
  return tx(async (db) => {
    const g = await loadGoal(db, actor.familyId, goalId);
    assertOwnerOrAdult(actor, g);
    if (g.status !== 'active') throw conflict('Esta meta ya está cerrada', 'goal_closed');
    if (await hasPendingRequest(db, goalId)) throw conflict('Esta meta tiene una petición esperando a un adulto', 'goal_pending');
    await lockUser(db, g.user_id);
    const a = await goalAmounts(db, goalId);
    if (a.balance >= g.target_cents) throw conflict('Ya has llegado a la meta: usa «Canjear meta» o pide pasarlo a efectivo', 'goal_reached');
    if (a.balance <= 0) throw conflict('No hay nada que sacar', 'nothing_to_withdraw');
    await moveOut(db, actor, g, a, `gout:${randomUUID()}`, 'Ahorro sacado antes de la meta');
    await audit(db, actor.familyId, actor.id, 'savings.withdraw', 'savings_goal', goalId, { principal: a.principal, forfeited: a.interest + a.gifts, title: g.title, for: g.user_id });
    return { principal_cents: a.principal, forfeited_cents: a.interest + a.gifts };
  });
}

/** Capital a la cuenta de dinero; interés (si lo hay) perdido. Deja la meta a cero. */
async function moveOut(db: Db, actor: AuthUser, g: any, a: { principal: number; interest: number; gifts: number }, key: string, note: string) {
  if (a.principal > 0) {
    await addMoney(db, { familyId: actor.familyId, userId: g.user_id, account: 'savings', goalId: g.id, deltaCents: -a.principal, kind: 'transfer', refId: g.id, note, createdBy: actor.id, idempotencyKey: `${key}:p-out` });
    await addMoney(db, { familyId: actor.familyId, userId: g.user_id, deltaCents: a.principal, kind: 'transfer', refId: g.id, note, createdBy: actor.id, idempotencyKey: `${key}:p-in` });
  }
  // Interés y aportes de los padres y parientes se pierden al sacar el ahorro antes de llegar a la meta.
  if (a.interest + a.gifts > 0) {
    await addMoney(db, { familyId: actor.familyId, userId: g.user_id, account: 'savings', goalId: g.id, deltaCents: -(a.interest + a.gifts), kind: 'interest_forfeit', refId: g.id, note: `${a.gifts > 0 ? 'Interés y aportes perdidos' : 'Interés perdido'}: ${g.title}`, createdBy: actor.id, idempotencyKey: `${key}:i` });
  }
}

/** «Canjear meta» (se compra lo de la meta) o «pasar a efectivo» (con permiso y sin interés). */
export async function requestGoalAction(child: AuthUser, goalId: string, kind: 'redeem' | 'cashout') {
  if (child.role !== 'child') throw forbidden('Esto es solo para hijos');
  return tx(async (db) => {
    const g = await loadGoal(db, child.familyId, goalId);
    if (g.user_id !== child.id) throw forbidden();
    if (g.status !== 'active') throw conflict('Esta meta ya está cerrada', 'goal_closed');
    await lockUser(db, child.id);
    const a = await goalAmounts(db, goalId);
    if (a.balance < g.target_cents) throw conflict('Aún no has llegado a la meta. Si quieres, puedes sacar tu ahorro (perderás el interés)', 'goal_not_reached');
    if (await hasPendingRequest(db, goalId)) throw conflict('Ya hay una petición abierta para esta meta', 'already_pending');
    const req = await one(
      db,
      `INSERT INTO goal_requests(family_id, user_id, goal_id, goal_title, kind, balance_cents) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [child.familyId, child.id, goalId, g.title, kind, a.balance],
    );
    await audit(db, child.familyId, child.id, 'goal.request', 'goal_request', req.id, { kind, title: g.title, cents: a.balance });
    const cur = (await getFamily(db, child.familyId)).currency;
    const fmtEur = (c: number) => fmtMoney(c, cur);
    await notifyAdults(db, child.familyId, {
      event: 'goal_requested',
      title: kind === 'redeem' ? `${child.displayName} quiere canjear su meta «${g.title}»` : `${child.displayName} pide pasar a efectivo su meta «${g.title}»`,
      body: kind === 'redeem'
        ? `Tiene ${fmtEur(a.balance)} ahorrados. Pagad en la tienda con él o ella y marcad «Comprado» en Validar.`
        : `Tiene ${fmtEur(a.balance)} ahorrados; si lo aprobáis, pierde ${fmtEur(a.interest + a.gifts)} de interés y aportes.`,
      link: '/validar', dedupeKey: `goal-req:${req.id}`,
    });
    return { request: req };
  });
}

export async function cancelGoalRequest(child: AuthUser, id: string) {
  return tx(async (db) => {
    const r = await one(db, 'SELECT * FROM goal_requests WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, child.familyId]);
    if (!r) throw notFound('Petición no encontrada');
    if (r.user_id !== child.id) throw forbidden();
    if (r.status === 'cancelled') return { request: r, duplicate: true };
    if (r.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    const upd = await one(db, `UPDATE goal_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 RETURNING *`, [id]);
    return { request: upd, duplicate: false };
  });
}

/**
 * Un adulto resuelve la petición de una meta.
 * - redeem: «Comprado» con el precio real. Lo que sobra vuelve a la cuenta de dinero; lo que falta se descuenta
 *   (la cuenta puede quedar en negativo, igual que con el préstamo).
 * - cashout: el capital pasa a la cuenta de dinero y el interés se pierde.
 */
export async function decideGoalRequest(adult: AuthUser, id: string, o: { approve: boolean; priceCents?: number; note?: string }) {
  return tx(async (db) => {
    const r = await one(db, 'SELECT * FROM goal_requests WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, adult.familyId]);
    if (!r) throw notFound('Petición no encontrada');
    const want = o.approve ? 'approved' : 'rejected';
    if (r.status === want) return { request: r, duplicate: true };
    if (r.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    const note = o.note?.trim() ?? '';
    const cur = (await getFamily(db, adult.familyId)).currency;
    if (!o.approve) {
      const upd = await one(db, `UPDATE goal_requests SET status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`, [id, note, adult.id]);
      await audit(db, adult.familyId, adult.id, 'goal.reject', 'goal_request', id, { note, for: r.user_id });
      await notify(db, { userId: r.user_id, event: 'goal_decided', title: `${adult.displayName} no ha aceptado tu petición para «${r.goal_title}»`, body: note, link: '/mesada', dedupeKey: `goal-rejected:${id}` });
      return { request: upd, duplicate: false };
    }
    const g = await loadGoal(db, adult.familyId, r.goal_id);
    await lockUser(db, r.user_id);
    const a = await goalAmounts(db, r.goal_id);
    const fmtEur = (c: number) => fmtMoney(c, cur);
    if (r.kind === 'redeem') {
      const price = o.priceCents;
      if (!Number.isInteger(price) || price! <= 0 || price! > 100000000) throw badRequest('Indica el precio real de la compra');
      const settle = a.balance - price!;
      await addMoney(db, { familyId: adult.familyId, userId: r.user_id, account: 'savings', goalId: g.id, deltaCents: -a.balance, kind: 'goal_redeem', refId: id, note: `Meta comprada: ${g.title}`, createdBy: adult.id, idempotencyKey: `gred:${id}:out` });
      if (settle !== 0) {
        await addMoney(db, { familyId: adult.familyId, userId: r.user_id, deltaCents: settle, kind: 'goal_redeem', refId: id, note: settle > 0 ? `Sobra de «${g.title}»` : `Falta para «${g.title}»`, createdBy: adult.id, idempotencyKey: `gred:${id}:settle` });
      }
      await db.query(`UPDATE savings_goals SET status = 'bought', price_cents = $2, closed_at = now() WHERE id = $1`, [g.id, price]);
      const upd = await one(
        db,
        `UPDATE goal_requests SET status = 'approved', price_cents = $2, settle_cents = $3, decision_note = $4, decided_by = $5, decided_at = now() WHERE id = $1 RETURNING *`,
        [id, price, settle, note, adult.id],
      );
      await audit(db, adult.familyId, adult.id, 'goal.redeem', 'goal_request', id, { title: g.title, saved: a.balance, price, settle, for: r.user_id });
      await notify(db, {
        userId: r.user_id, event: 'goal_decided', title: `¡«${g.title}» comprada!`,
        body: settle > 0 ? `Sobraron ${fmtEur(settle)} y vuelven a tu cuenta de dinero.` : settle < 0 ? `Faltaron ${fmtEur(-settle)}: se descuentan de tu cuenta de dinero.` : 'Justo lo que tenías ahorrado.',
        link: '/mesada', dedupeKey: `goal-approved:${id}`,
      });
      return { request: upd, duplicate: false, settle_cents: settle };
    }
    await moveOut(db, adult, g, a, `gcash:${id}`, `Meta pasada a efectivo: ${g.title}`);
    await db.query(`UPDATE savings_goals SET status = 'cashed_out', closed_at = now() WHERE id = $1`, [g.id]);
    const upd = await one(
      db,
      `UPDATE goal_requests SET status = 'approved', settle_cents = $2, forfeited_cents = $3, decision_note = $4, decided_by = $5, decided_at = now() WHERE id = $1 RETURNING *`,
      [id, a.principal, a.interest + a.gifts, note, adult.id],
    );
    await audit(db, adult.familyId, adult.id, 'goal.cashout', 'goal_request', id, { title: g.title, principal: a.principal, forfeited: a.interest + a.gifts, for: r.user_id });
    await notify(db, {
      userId: r.user_id, event: 'goal_decided', title: `«${g.title}» pasada a tu cuenta de dinero`,
      body: `${fmtEur(a.principal)} vuelven a tu cuenta${a.interest + a.gifts ? ` y pierdes ${fmtEur(a.interest + a.gifts)} de interés y aportes` : ''}.`, link: '/mesada', dedupeKey: `goal-approved:${id}`,
    });
    return { request: upd, duplicate: false };
  });
}

export async function listGoalRequests(db: Db, familyId: string, o: { userId?: string; status?: string }) {
  return many(
    db,
    `SELECT r.*, u.display_name, u.avatar, u.color, g.target_cents FROM goal_requests r JOIN users u ON u.id = r.user_id JOIN savings_goals g ON g.id = r.goal_id
      WHERE r.family_id = $1 AND ($2::uuid IS NULL OR r.user_id = $2) AND ($3::text IS NULL OR r.status = $3) ORDER BY r.created_at DESC LIMIT 100`,
    [familyId, o.userId ?? null, o.status ?? null],
  );
}

/**
 * Interés de la semana (lunes): cada meta abierta con capital paga `savingsInterestCents` sobre el capital
 * que tenía al empezar la semana. Sigue ganando aunque ya haya llegado a la meta, hasta que se canjee.
 * Idempotente por meta y semana.
 */
export async function accrueSavingsInterest(db: Db, familyId: string, now = new Date()) {
  const fam = await getFamily(db, familyId);
  if (!fam.bank_savings_enabled) return 0;
  const weekStart = startOfWeek(familyToday(fam, now));
  const goals = await many<{ id: string; user_id: string; title: string }>(db, `SELECT id, user_id, title FROM savings_goals WHERE family_id = $1 AND status = 'active' AND NOT archived`, [familyId]);
  let paid = 0;
  for (const g of goals) {
    paid += await tx(async (c) => {
      const cur = await one(c, `SELECT status FROM savings_goals WHERE id = $1 FOR UPDATE`, [g.id]);
      if (cur?.status !== 'active') return 0;
      // Capital que tenía al empezar la semana (sin intereses): lo que se ingresó antes de ese día en la zona de la familia.
      const p = await one<{ n: number }>(
        c,
        `SELECT COALESCE(SUM(delta_cents),0)::int AS n FROM money_ledger
          WHERE goal_id = $1 AND account = 'savings' AND kind NOT IN ('interest','interest_forfeit','goal_match','goal_gift','goal_reversal') AND (created_at AT TIME ZONE $3)::date < $2`,
        [g.id, weekStart, fam.timezone],
      );
      if (!p || p.n <= 0 || (await goalAmounts(c, g.id)).balance <= 0) return 0;
      const interest = savingsInterestCents(p.n, fam.bank_savings_rate_percent);
      const r = await addMoney(c, { familyId, userId: g.user_id, account: 'savings', goalId: g.id, deltaCents: interest, kind: 'interest', refId: g.id, note: `Interés de la semana: ${g.title}`, idempotencyKey: `interest:${g.id}:${weekStart}` });
      if (r.duplicate) return 0;
      await notify(c, { userId: g.user_id, event: 'savings_interest', title: `«${g.title}» ha ganado ${fmtMoney(interest, fam.currency)} de interés`, body: 'Lo pagan tus padres. Se suma a tu meta.', link: '/mesada', dedupeKey: `interest:${g.id}:${weekStart}` });
      return 1;
    });
  }
  return paid;
}

/** Trabajo del lunes (se puede llamar a menudo: cada parte es idempotente). */
export async function runWeeklyBank(db: Db, familyId: string, now = new Date()) {
  const interest = await accrueSavingsInterest(db, familyId, now);
  const charges = await chargeLoans(familyId, now);
  return { interest, charges };
}


/* ---------- I19: meta visible (propuesta, ahorro automático, aporte de los padres y de parientes, foto) ---------- */

const MAX_OPEN_GOALS = 6;
const GIFT_MAX_RELATIVE = 50_000; // por aporte de un pariente
const GIFT_MAX_RELATIVE_DAY = 100_000; // por pariente y 24 h
const GIFT_MAX_ADULT = 1_000_000;

const goalWho = (u: AuthUser) => whoText(u.displayName, u.relationship, u.relationshipLabel);

/**
 * Crea una meta. El hijo la PROPONE (queda «por aprobar» y avisa a los adultos); un adulto la crea ya activa.
 * Los parientes no crean metas.
 */
export async function createGoal(actor: AuthUser, p: { userId: string; title: string; targetCents: number; emoji?: string | null }) {
  return tx(async (db) => {
    const child = await one(db, `SELECT id, display_name FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active`, [p.userId, actor.familyId]);
    if (!child) throw notFound('Miembro no encontrado');
    if (actor.role === 'child' && actor.id !== p.userId) throw forbidden();
    if (actor.role === 'adult' && actor.isRelative) throw forbidden();
    const open = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM savings_goals WHERE user_id = $1 AND NOT archived AND status IN ('proposed','active')`, [p.userId]))!.n;
    if (open >= MAX_OPEN_GOALS) throw conflict(`Ya hay ${MAX_OPEN_GOALS} metas abiertas. Cierra alguna antes de crear otra.`, 'too_many_goals');
    const childMade = actor.role === 'child';
    const g = await one(
      db,
      `INSERT INTO savings_goals(family_id, user_id, title, target_cents, emoji, status, proposed_by, proposed_title, proposed_target_cents, decided_by, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$3,$4,$8,$9) RETURNING *`,
      [actor.familyId, p.userId, p.title, p.targetCents, p.emoji || null, childMade ? 'proposed' : 'active', actor.id, childMade ? null : actor.id, childMade ? null : new Date()],
    );
    await audit(db, actor.familyId, actor.id, childMade ? 'goal.propose' : 'goal.create', 'savings_goal', g.id, { title: p.title, targetCents: p.targetCents, for: p.userId });
    if (childMade) {
      const cur = (await getFamily(db, actor.familyId)).currency;
      await notifyAdults(db, actor.familyId, {
        event: 'goal_proposed', title: `${actor.displayName} propone una meta de ahorro: «${p.title}»`,
        body: `Cuesta ${fmtMoney(p.targetCents, cur)}. Apruébala, ajústala o recházala en Validar.`, link: '/validar', dedupeKey: `goal-prop:${g.id}`,
      });
    }
    return g;
  });
}

/** Un adulto aprueba (pudiendo ajustar nombre, precio o emoji) o rechaza (con motivo) la meta propuesta por un hijo. */
export async function decideGoalProposal(adult: AuthUser, id: string, o: { approve: boolean; title?: string; targetCents?: number; emoji?: string | null; note?: string }) {
  return tx(async (db) => {
    const g = await one(db, 'SELECT * FROM savings_goals WHERE id = $1 AND family_id = $2 AND NOT archived FOR UPDATE', [id, adult.familyId]);
    if (!g) throw notFound('Meta no encontrada');
    const want = o.approve ? 'active' : 'rejected';
    if (g.status === want && g.decided_by) return { goal: g, duplicate: true };
    if (g.status !== 'proposed') throw conflict('Esta meta ya está resuelta', 'already_decided');
    const note = o.note?.trim() ?? '';
    const cur = (await getFamily(db, adult.familyId)).currency;
    if (!o.approve) {
      if (!note) throw badRequest('Cuéntale al niño por qué no (motivo obligatorio)', 'reason_required');
      const upd = await one(db, `UPDATE savings_goals SET status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now(), closed_at = now() WHERE id = $1 RETURNING *`, [id, note, adult.id]);
      await audit(db, adult.familyId, adult.id, 'goal.reject_proposal', 'savings_goal', id, { title: g.title, note, for: g.user_id });
      await notify(db, { userId: g.user_id, event: 'goal_decided', title: `${goalWho(adult)} no ha aprobado tu meta «${g.title}»`, body: note, link: '/mesada', dedupeKey: `goal-proposal-rejected:${id}` });
      return { goal: upd, duplicate: false };
    }
    const title = o.title?.trim() || g.title;
    const target = o.targetCents ?? g.target_cents;
    const upd = await one(
      db,
      `UPDATE savings_goals SET status = 'active', title = $2, target_cents = $3, emoji = COALESCE($4, emoji), decision_note = $5, decided_by = $6, decided_at = now() WHERE id = $1 RETURNING *`,
      [id, title, target, o.emoji === undefined ? null : o.emoji || null, note, adult.id],
    );
    const changed = title !== g.title || target !== g.target_cents;
    await audit(db, adult.familyId, adult.id, 'goal.approve_proposal', 'savings_goal', id, { title, targetCents: target, adjusted: changed, for: g.user_id });
    await notify(db, {
      userId: g.user_id, event: 'goal_decided', title: `${goalWho(adult)} ha aprobado tu meta «${title}»`,
      body: changed ? `La ha ajustado: «${title}» cuesta ${fmtMoney(target, cur)}.${note ? ` ${note}` : ''}` : note, link: '/mesada', dedupeKey: `goal-proposal-approved:${id}`,
    });
    return { goal: upd, duplicate: false };
  });
}

/** Propuestas de metas y cambios de ahorro automático esperando a un adulto. */
export async function listGoalProposals(db: Db, familyId: string) {
  const proposals = await many(
    db,
    `SELECT g.id, g.user_id, g.title, g.target_cents, g.emoji, (g.photo_path IS NOT NULL) AS has_photo, g.created_at, u.display_name, u.avatar, u.color
       FROM savings_goals g JOIN users u ON u.id = g.user_id WHERE g.family_id = $1 AND g.status = 'proposed' AND NOT g.archived ORDER BY g.created_at`,
    [familyId],
  );
  const autoRequests = await many(
    db,
    `SELECT g.id, g.user_id, g.title, g.auto_percent, g.auto_pending_percent, g.created_at, u.display_name, u.avatar, u.color
       FROM savings_goals g JOIN users u ON u.id = g.user_id WHERE g.family_id = $1 AND g.status = 'active' AND NOT g.archived AND g.auto_pending_percent IS NOT NULL ORDER BY g.created_at`,
    [familyId],
  );
  return { proposals, autoRequests };
}

/**
 * Ahorro automático: % de cada cierre que va solo a la meta. Lo que pide el hijo espera la aprobación de un adulto
 * (quitarlo o bajarlo a 0 lo hace al momento); un adulto lo fija directamente. Entre todas las metas de un hijo, 100 % como máximo.
 */
export async function setAutoSave(actor: AuthUser, goalId: string, percent: number) {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) throw badRequest('El porcentaje debe estar entre 0 y 100');
  return tx(async (db) => {
    const g = await loadGoal(db, actor.familyId, goalId);
    assertOwnerOrAdult(actor, g);
    if (actor.role === 'adult' && actor.isRelative) throw forbidden();
    if (g.status !== 'active') throw conflict('Esta meta no está activa', 'goal_closed');
    const others = (await one<{ n: number }>(db, `SELECT COALESCE(SUM(auto_percent),0)::int AS n FROM savings_goals WHERE user_id = $1 AND status = 'active' AND NOT archived AND id <> $2`, [g.user_id, goalId]))!.n;
    if (others + percent > 100) throw conflict(`Entre todas las metas no se puede pasar del 100 %. A las demás ya van un ${others} %.`, 'auto_over_100');
    const mine = actor.role === 'child';
    if (mine && percent > 0 && percent !== g.auto_percent) {
      await db.query('UPDATE savings_goals SET auto_pending_percent = $2 WHERE id = $1', [goalId, percent]);
      await audit(db, actor.familyId, actor.id, 'goal.auto_request', 'savings_goal', goalId, { percent, title: g.title, for: g.user_id });
      await notifyAdults(db, actor.familyId, {
        event: 'goal_proposed', title: `${actor.displayName} quiere ahorrar el ${percent} % de cada cierre para «${g.title}»`,
        body: 'Lo apruebas o lo rechazas en Validar.', link: '/validar', dedupeKey: `goal-auto:${goalId}:${randomUUID()}`,
      });
      return { auto_percent: g.auto_percent, auto_pending_percent: percent };
    }
    await db.query('UPDATE savings_goals SET auto_percent = $2, auto_pending_percent = NULL WHERE id = $1', [goalId, percent]);
    await audit(db, actor.familyId, actor.id, 'goal.auto_set', 'savings_goal', goalId, { percent, title: g.title, for: g.user_id });
    if (!mine) await notify(db, { userId: g.user_id, event: 'goal_decided', title: percent ? `${goalWho(actor)} ha puesto el ahorro automático de «${g.title}» al ${percent} %` : `${goalWho(actor)} ha quitado el ahorro automático de «${g.title}»`, link: '/mesada', dedupeKey: `goal-auto-set:${goalId}:${randomUUID()}` });
    return { auto_percent: percent, auto_pending_percent: null };
  });
}

export async function decideAutoSave(adult: AuthUser, goalId: string, approve: boolean) {
  return tx(async (db) => {
    const g = await loadGoal(db, adult.familyId, goalId);
    if (g.auto_pending_percent == null) throw conflict('No hay ninguna petición de ahorro automático para esta meta', 'already_decided');
    const pct = g.auto_pending_percent as number;
    if (approve) {
      const others = (await one<{ n: number }>(db, `SELECT COALESCE(SUM(auto_percent),0)::int AS n FROM savings_goals WHERE user_id = $1 AND status = 'active' AND NOT archived AND id <> $2`, [g.user_id, goalId]))!.n;
      if (others + pct > 100) throw conflict('Entre todas las metas se pasaría del 100 %', 'auto_over_100');
      await db.query('UPDATE savings_goals SET auto_percent = $2, auto_pending_percent = NULL WHERE id = $1', [goalId, pct]);
    } else {
      await db.query('UPDATE savings_goals SET auto_pending_percent = NULL WHERE id = $1', [goalId]);
    }
    await audit(db, adult.familyId, adult.id, approve ? 'goal.auto_approve' : 'goal.auto_reject', 'savings_goal', goalId, { percent: pct, title: g.title, for: g.user_id });
    await notify(db, {
      userId: g.user_id, event: 'goal_decided', title: approve ? `${goalWho(adult)} ha aprobado tu ahorro automático del ${pct} % para «${g.title}»` : `${goalWho(adult)} no ha aprobado tu ahorro automático para «${g.title}»`,
      link: '/mesada', dedupeKey: `goal-auto-decided:${goalId}:${randomUUID()}`,
    });
    return { ok: true, auto_percent: approve ? pct : g.auto_percent };
  });
}

/**
 * Regla del aporte de los padres: «give» por cada «per» que ahorra el hijo (p. ej. 1 € por cada 4 €), hasta un tope total.
 * `null` la quita. Solo adultos completos.
 */
export async function setMatchRule(adult: AuthUser, goalId: string, rule: { perCents: number; givesCents: number; capCents: number } | null) {
  if (rule && (rule.givesCents > rule.perCents)) throw badRequest('El aporte no puede ser mayor que lo que ahorra el niño');
  return tx(async (db) => {
    const g = await loadGoal(db, adult.familyId, goalId);
    if (g.status !== 'active') throw conflict('Esta meta no está activa', 'goal_closed');
    await db.query('UPDATE savings_goals SET match_per_cents = $2, match_gives_cents = $3, match_cap_cents = $4 WHERE id = $1', [goalId, rule?.perCents ?? null, rule?.givesCents ?? null, rule?.capCents ?? null]);
    await audit(db, adult.familyId, adult.id, 'goal.match_rule', 'savings_goal', goalId, { rule, title: g.title, for: g.user_id });
    if (rule) {
      const cur = (await getFamily(db, adult.familyId)).currency;
      await notify(db, {
        userId: g.user_id, event: 'goal_match', title: `${goalWho(adult)} pondrá ${fmtMoney(rule.givesCents, cur)} por cada ${fmtMoney(rule.perCents, cur)} que ahorres en «${g.title}»`,
        body: `Hasta ${fmtMoney(rule.capCents, cur)} en total.`, link: '/mesada', dedupeKey: `goal-match-rule:${goalId}:${randomUUID()}`,
      });
    }
    return { ok: true };
  });
}

/** Suma el aporte de los padres a un ahorro del hijo, si la meta tiene regla y queda tope. Idempotente por ahorro de origen. */
export async function applyMatch(db: Db, g: { id: string; user_id: string; family_id: string; title: string; match_per_cents: number | null; match_gives_cents: number | null; match_cap_cents: number | null }, savedCents: number, sourceId: string, currency: string) {
  if (!g.match_per_cents || !g.match_gives_cents || !g.match_cap_cents) return 0;
  const a = await goalAmounts(db, g.id);
  const give = Math.min(Math.floor(savedCents / g.match_per_cents) * g.match_gives_cents, Math.max(0, g.match_cap_cents - a.matched));
  if (give <= 0) return 0;
  const r = await addMoney(db, { familyId: g.family_id, userId: g.user_id, account: 'savings', goalId: g.id, deltaCents: give, kind: 'goal_match', refId: g.id, note: `Aporte de tus padres: ${g.title}`, idempotencyKey: `gmatch:${sourceId}` });
  if (r.duplicate) return 0;
  await notify(db, { userId: g.user_id, event: 'goal_match', title: `Tus padres han añadido ${fmtMoney(give, currency)} a «${g.title}»`, body: 'Es su empujón por lo que has ahorrado.', link: '/mesada', dedupeKey: `gmatch:${sourceId}` });
  return give;
}

/** En un cierre, el % configurado de lo cobrado va solo a cada meta (la que ya llegó al precio no recibe más). */
export async function applyAutoSave(db: Db, familyId: string, userId: string, settlementId: string, cents: number, currency: string, adultId: string) {
  if (cents <= 0) return 0;
  const goals = await many(db, `SELECT * FROM savings_goals WHERE user_id = $1 AND status = 'active' AND NOT archived AND auto_percent > 0 ORDER BY created_at`, [userId]);
  let total = 0;
  for (const g of goals) {
    if (await hasPendingRequest(db, g.id)) continue;
    const a = await goalAmounts(db, g.id);
    if (a.balance >= g.target_cents) continue;
    const amt = Math.min(Math.floor((cents * g.auto_percent) / 100), Math.max(0, (await moneyBalance(db, userId)) ));
    if (amt <= 0) continue;
    const out = await addMoney(db, { familyId, userId, deltaCents: -amt, kind: 'goal_auto', refId: g.id, note: `Ahorro automático: ${g.title}`, createdBy: adultId, idempotencyKey: `gauto:${settlementId}:${g.id}:out` });
    if (out.duplicate) continue;
    const inn = await addMoney(db, { familyId, userId, account: 'savings', goalId: g.id, deltaCents: amt, kind: 'transfer', refId: g.id, note: `Ahorro automático: ${g.title}`, createdBy: adultId, idempotencyKey: `gauto:${settlementId}:${g.id}:in` });
    total += amt;
    await audit(db, familyId, adultId, 'savings.auto', 'savings_goal', g.id, { cents: amt, percent: g.auto_percent, title: g.title, for: userId });
    await notify(db, { userId, event: 'goal_auto', title: `Ahorro automático: ${fmtMoney(amt, currency)} a «${g.title}»`, body: `Es el ${g.auto_percent} % de este cierre.`, link: '/mesada', dedupeKey: `gauto:${settlementId}:${g.id}` });
    await applyMatch(db, g as any, amt, inn.id ?? randomUUID(), currency);
  }
  return total;
}

/**
 * Aporte puntual a una meta: lo da un adulto o un pariente (un premio, un empujón). No sale de la cuenta del niño:
 * lo ponen ellos en la vida real, igual que el interés. Queda en el libro con su autor y se puede revertir con un asiento contrario.
 */
export async function giveGoalGift(actor: AuthUser, goalId: string, p: { cents: number; message?: string; idempotencyKey?: string }) {
  if (actor.role !== 'adult') throw forbidden('Solo los adultos y parientes pueden hacer aportes');
  if (!Number.isInteger(p.cents) || p.cents <= 0) throw badRequest('Importe no válido');
  const max = actor.isRelative ? GIFT_MAX_RELATIVE : GIFT_MAX_ADULT;
  const fam = await getFamily(getPool(), actor.familyId);
  if (p.cents > max) throw badRequest(`Como máximo puedes aportar ${fmtMoney(max, fam.currency)} de una vez`, 'gift_too_big');
  return tx(async (db) => {
    const g = await loadGoal(db, actor.familyId, goalId);
    if (g.status !== 'active') throw conflict('Esta meta no está activa', 'goal_closed');
    if (await hasPendingRequest(db, goalId)) throw conflict('Esta meta tiene una petición esperando a un adulto', 'goal_pending');
    const key = p.idempotencyKey ? `ggift:${actor.id}:${goalId}:${p.idempotencyKey}` : null;
    if (key && (await one(db, 'SELECT 1 FROM money_ledger WHERE idempotency_key = $1', [key]))) return { duplicate: true, ...(await goalAmounts(db, goalId)) };
    if (actor.isRelative) {
      const day = (await one<{ n: number }>(db, `SELECT COALESCE(SUM(delta_cents),0)::int AS n FROM money_ledger WHERE created_by = $1 AND kind = 'goal_gift' AND created_at > now() - interval '24 hours'`, [actor.id]))!.n;
      if (day + p.cents > GIFT_MAX_RELATIVE_DAY) throw conflict(`En un día puedes aportar hasta ${fmtMoney(GIFT_MAX_RELATIVE_DAY, fam.currency)}`, 'gift_day_limit');
    }
    const msg = p.message?.trim().slice(0, 140) ?? '';
    const who = goalWho(actor);
    const r = await addMoney(db, { familyId: actor.familyId, userId: g.user_id, account: 'savings', goalId, deltaCents: p.cents, kind: 'goal_gift', refId: goalId, note: `Aporte de ${who}${msg ? `: ${msg}` : ''}`, createdBy: actor.id, idempotencyKey: key });
    await audit(db, actor.familyId, actor.id, 'goal.gift', 'savings_goal', goalId, { cents: p.cents, title: g.title, message: msg || undefined, for: g.user_id });
    await notify(db, {
      userId: g.user_id, event: 'goal_gift', title: `${who} ha puesto ${fmtMoney(p.cents, fam.currency)} en tu meta «${g.title}»`, body: msg, link: '/mesada', dedupeKey: r.id ? `ggift:${r.id}` : null,
    });
    if (actor.isRelative) {
      await notifyAdults(db, actor.familyId, { event: 'relative_activity', title: `${who} ha aportado ${fmtMoney(p.cents, fam.currency)} a «${g.title}» de ${(await one(db, 'SELECT display_name FROM users WHERE id = $1', [g.user_id]))!.display_name}`, body: msg, link: '/mesada', dedupeKey: r.id ? `ggift-adults:${r.id}` : null });
    }
    return { duplicate: r.duplicate, entry_id: r.id ?? null, ...(await goalAmounts(db, goalId)) };
  });
}

/** Deshace un aporte (de padres o de un pariente) con un asiento contrario: el libro no se edita nunca. */
export async function reverseContribution(adult: AuthUser, goalId: string, entryId: string) {
  return tx(async (db) => {
    const g = await loadGoal(db, adult.familyId, goalId);
    await lockUser(db, g.user_id);
    const e = await one(db, `SELECT * FROM money_ledger WHERE id = $1 AND goal_id = $2 AND account = 'savings' AND kind IN ('goal_gift','goal_match')`, [entryId, goalId]);
    if (!e) throw notFound('Aporte no encontrado');
    if (await one(db, `SELECT 1 FROM money_ledger WHERE idempotency_key = $1`, [`grev:${e.id}`])) return { duplicate: true };
    const a = await goalAmounts(db, goalId);
    if (g.status !== 'active') throw conflict('Esta meta ya está cerrada', 'goal_closed');
    if (a.balance < e.delta_cents) throw conflict('La meta ya no tiene ese dinero', 'insufficient_balance');
    const r = await addMoney(db, { familyId: adult.familyId, userId: g.user_id, account: 'savings', goalId, deltaCents: -e.delta_cents, kind: 'goal_reversal', refId: e.id, note: `Aporte anulado: ${e.note}`, createdBy: adult.id, idempotencyKey: `grev:${e.id}` });
    if (r.duplicate) return { duplicate: true };
    await audit(db, adult.familyId, adult.id, 'goal.contribution_reverse', 'savings_goal', goalId, { cents: e.delta_cents, kind: e.kind, for: g.user_id });
    const cur = (await getFamily(db, adult.familyId)).currency;
    await notify(db, { userId: g.user_id, event: 'goal_decided', title: `Se ha anulado un aporte de ${fmtMoney(e.delta_cents, cur)} en «${g.title}»`, link: '/mesada', dedupeKey: `grev:${e.id}` });
    return { duplicate: false };
  });
}

/** Guarda la foto de la meta (ya procesada). La anterior se borra. La foto de una meta activa no caduca (D59). */
export async function setGoalPhoto(actor: AuthUser, goalId: string, photoPath: string) {
  return tx(async (db) => {
    const g = await loadGoal(db, actor.familyId, goalId);
    assertOwnerOrAdult(actor, g);
    if (actor.role === 'adult' && actor.isRelative) throw forbidden();
    if (!['proposed', 'active'].includes(g.status)) throw conflict('Esta meta ya está cerrada', 'goal_closed');
    await db.query('UPDATE savings_goals SET photo_path = $2 WHERE id = $1', [goalId, photoPath]);
    removePhotoFile(g.photo_path);
    return { ok: true };
  });
}

/** Un adulto cambia nombre, precio o emoji de una meta ya activa; el hijo recibe un aviso con lo nuevo. */
export async function updateGoal(adult: AuthUser, goalId: string, o: { title?: string; targetCents?: number; emoji?: string | null }) {
  return tx(async (db) => {
    const g = await loadGoal(db, adult.familyId, goalId);
    if (g.status !== 'active') throw conflict('Solo se pueden cambiar metas activas', 'goal_closed');
    const title = o.title?.trim() || g.title;
    const target = o.targetCents ?? g.target_cents;
    const emoji = o.emoji === undefined ? g.emoji : o.emoji || null;
    if (title === g.title && target === g.target_cents && emoji === g.emoji) return { goal: g, changed: false };
    const upd = await one(db, 'UPDATE savings_goals SET title = $2, target_cents = $3, emoji = $4 WHERE id = $1 RETURNING *', [goalId, title, target, emoji]);
    await audit(db, adult.familyId, adult.id, 'goal.update', 'savings_goal', goalId, { before: { title: g.title, targetCents: g.target_cents }, after: { title, targetCents: target }, for: g.user_id });
    const cur = (await getFamily(db, adult.familyId)).currency;
    await notify(db, {
      userId: g.user_id, event: 'goal_decided', title: `${goalWho(adult)} ha cambiado tu meta «${g.title}»`,
      body: `Ahora es «${title}» y cuesta ${fmtMoney(target, cur)}.`, link: '/mesada', dedupeKey: `goal-update:${goalId}:${randomUUID()}`,
    });
    return { goal: upd, changed: true };
  });
}

/**
 * Cancelar una meta (el hijo la suya, o un adulto cualquiera). Si tenía dinero, lo ahorrado vuelve a la cuenta de dinero
 * del banco; interés y aportes se pierden, igual que al sacar el ahorro antes de tiempo, para que cancelar no sea un atajo.
 */
export async function cancelGoal(actor: AuthUser, goalId: string, reason?: string) {
  return tx(async (db) => {
    const g = await loadGoal(db, actor.familyId, goalId);
    assertOwnerOrAdult(actor, g);
    if (await hasPendingRequest(db, goalId)) throw conflict('Esta meta tiene una petición esperando a un adulto. Resuélvela antes de cancelarla', 'goal_pending');
    await lockUser(db, g.user_id);
    const a = await goalAmounts(db, goalId);
    if (a.balance > 0) await moveOut(db, actor, g, a, `gcancel:${goalId}`, `Meta cancelada: ${g.title}`);
    await db.query(`UPDATE savings_goals SET archived = true, closed_at = COALESCE(closed_at, now()) WHERE id = $1`, [goalId]);
    const returned = Math.max(0, a.balance > 0 ? a.principal : 0);
    const forfeited = a.balance > 0 ? a.interest + a.gifts : 0;
    await audit(db, actor.familyId, actor.id, 'goal.cancel', 'savings_goal', goalId, { title: g.title, returned, forfeited, reason: reason?.trim() || null, for: g.user_id });
    if (actor.id !== g.user_id) {
      const cur = (await getFamily(db, actor.familyId)).currency;
      const why = reason?.trim() ? ` Motivo: ${reason.trim()}` : '';
      await notify(db, {
        userId: g.user_id, event: 'goal_decided', title: `${goalWho(actor)} ha cancelado tu meta «${g.title}»`,
        body: (returned > 0 ? `Tus ${fmtMoney(returned, cur)} ahorrados han vuelto a Mi banco.` : 'No tenía dinero ahorrado.') + why,
        link: '/mesada', dedupeKey: `goal-cancel:${goalId}`,
      });
    }
    return { returned_cents: returned, forfeited_cents: forfeited };
  });
}
