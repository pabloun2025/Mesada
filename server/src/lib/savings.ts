import { randomUUID } from 'node:crypto';
import { many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { startOfWeek } from './dates.js';
import { familyToday, getFamily } from './family.js';
import { addMoney, lockUser, moneyBalance } from './ledger.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { chargeLoans, fmtEur } from './bank.js';
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

/** Saldo de una meta: capital (lo que puso el hijo) e interés (lo que han pagado los padres). */
export async function goalAmounts(db: Db, goalId: string) {
  const r = await one<{ balance: number; interest: number; earned: number }>(
    db,
    `SELECT COALESCE(SUM(delta_cents),0)::int AS balance,
            COALESCE(SUM(delta_cents) FILTER (WHERE kind IN ('interest','interest_forfeit')),0)::int AS interest,
            COALESCE(SUM(delta_cents) FILTER (WHERE kind = 'interest'),0)::int AS earned
       FROM money_ledger WHERE goal_id = $1 AND account = 'savings'`,
    [goalId],
  );
  return { balance: r!.balance, interest: r!.interest, principal: r!.balance - r!.interest, earned: r!.earned };
}

export async function listGoals(db: Db, userId: string) {
  const goals = await many(
    db,
    `SELECT g.*, (SELECT row_to_json(q) FROM (SELECT id, kind, status, created_at FROM goal_requests r WHERE r.goal_id = g.id AND r.status = 'pending') q) AS pending_request
       FROM savings_goals g WHERE g.user_id = $1 AND NOT g.archived ORDER BY (g.status <> 'active'), g.created_at`,
    [userId],
  );
  return Promise.all(
    goals.map(async (g) => {
      const a = await goalAmounts(db, g.id);
      return { ...g, principal_cents: a.principal, interest_cents: a.interest, interest_earned_cents: a.earned, balance_cents: a.balance, reached: g.status === 'active' && a.balance >= g.target_cents };
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
    await addMoney(db, { familyId: actor.familyId, userId: g.user_id, account: 'savings', goalId, deltaCents: p.cents, kind: 'transfer', refId: goalId, note: `Ahorro: ${g.title}`, createdBy: actor.id, idempotencyKey: key ? `${key}:in` : null });
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
    await audit(db, actor.familyId, actor.id, 'savings.withdraw', 'savings_goal', goalId, { principal: a.principal, forfeited: a.interest, title: g.title, for: g.user_id });
    return { principal_cents: a.principal, forfeited_cents: a.interest };
  });
}

/** Capital a la cuenta de dinero; interés (si lo hay) perdido. Deja la meta a cero. */
async function moveOut(db: Db, actor: AuthUser, g: any, a: { principal: number; interest: number }, key: string, note: string) {
  if (a.principal > 0) {
    await addMoney(db, { familyId: actor.familyId, userId: g.user_id, account: 'savings', goalId: g.id, deltaCents: -a.principal, kind: 'transfer', refId: g.id, note, createdBy: actor.id, idempotencyKey: `${key}:p-out` });
    await addMoney(db, { familyId: actor.familyId, userId: g.user_id, deltaCents: a.principal, kind: 'transfer', refId: g.id, note, createdBy: actor.id, idempotencyKey: `${key}:p-in` });
  }
  if (a.interest > 0) {
    await addMoney(db, { familyId: actor.familyId, userId: g.user_id, account: 'savings', goalId: g.id, deltaCents: -a.interest, kind: 'interest_forfeit', refId: g.id, note: `Interés perdido: ${g.title}`, createdBy: actor.id, idempotencyKey: `${key}:i` });
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
    await notifyAdults(db, child.familyId, {
      event: 'goal_requested',
      title: kind === 'redeem' ? `${child.displayName} quiere canjear su meta «${g.title}»` : `${child.displayName} pide pasar a efectivo su meta «${g.title}»`,
      body: kind === 'redeem'
        ? `Tiene ${fmtEur(a.balance)} ahorrados. Pagad en la tienda con él o ella y marcad «Comprado» en Validar.`
        : `Tiene ${fmtEur(a.balance)} ahorrados; si lo aprobáis, pierde ${fmtEur(a.interest)} de interés.`,
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
    if (!o.approve) {
      const upd = await one(db, `UPDATE goal_requests SET status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`, [id, note, adult.id]);
      await audit(db, adult.familyId, adult.id, 'goal.reject', 'goal_request', id, { note, for: r.user_id });
      await notify(db, { userId: r.user_id, event: 'goal_decided', title: `${adult.displayName} no ha aceptado tu petición para «${r.goal_title}»`, body: note, link: '/mesada', dedupeKey: `goal-rejected:${id}` });
      return { request: upd, duplicate: false };
    }
    const g = await loadGoal(db, adult.familyId, r.goal_id);
    await lockUser(db, r.user_id);
    const a = await goalAmounts(db, r.goal_id);
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
      [id, a.principal, a.interest, note, adult.id],
    );
    await audit(db, adult.familyId, adult.id, 'goal.cashout', 'goal_request', id, { title: g.title, principal: a.principal, forfeited: a.interest, for: r.user_id });
    await notify(db, {
      userId: r.user_id, event: 'goal_decided', title: `«${g.title}» pasada a tu cuenta de dinero`,
      body: `${fmtEur(a.principal)} vuelven a tu cuenta${a.interest ? ` y pierdes ${fmtEur(a.interest)} de interés` : ''}.`, link: '/mesada', dedupeKey: `goal-approved:${id}`,
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
          WHERE goal_id = $1 AND account = 'savings' AND kind NOT IN ('interest','interest_forfeit') AND (created_at AT TIME ZONE $3)::date < $2`,
        [g.id, weekStart, fam.timezone],
      );
      if (!p || p.n <= 0 || (await goalAmounts(c, g.id)).balance <= 0) return 0;
      const interest = savingsInterestCents(p.n, fam.bank_savings_rate_percent);
      const r = await addMoney(c, { familyId, userId: g.user_id, account: 'savings', goalId: g.id, deltaCents: interest, kind: 'interest', refId: g.id, note: `Interés de la semana: ${g.title}`, idempotencyKey: `interest:${g.id}:${weekStart}` });
      if (r.duplicate) return 0;
      await notify(c, { userId: g.user_id, event: 'savings_interest', title: `«${g.title}» ha ganado ${fmtEur(interest)} de interés`, body: 'Lo pagan tus padres. Se suma a tu meta.', link: '/mesada', dedupeKey: `interest:${g.id}:${weekStart}` });
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

