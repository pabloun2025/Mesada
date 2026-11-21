import { createHash } from 'node:crypto';
import { getPool, many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { centsToPoints, familyToday, getFamily, pointsToCents, type Family } from './family.js';
import { addMoney, addPoints, lockUser, moneyBalance, pointsBalance } from './ledger.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { addDays, startOfWeek } from './dates.js';
import { capStatus, weeklyCapCents } from './cap.js';

export const fmtEur = (c: number) => `${(c / 100).toFixed(2).replace('.', ',')} €`;

const NO_CAP = 'Pon un tope semanal en Ajustes';

/** Número de cuenta de juguete, siempre el mismo para el mismo usuario y cuenta («ES00 DIPL 1234 5678»). */
export function accountNumber(userId: string, account: 'money' | 'points'): string {
  const h = createHash('sha256').update(`${account}:${userId}`).digest();
  const n = (h.readUInt32BE(0) % 100000000).toString().padStart(8, '0');
  return `ES00 DIPL ${n.slice(0, 4)} ${n.slice(4)}`;
}

function requireChild(u: AuthUser) {
  if (u.role !== 'child') throw forbidden('Esto es solo para hijos');
}

function disabled(what: string) {
  return conflict(`${what} está desactivado en los ajustes de la familia`, 'feature_disabled');
}

/** Máximo de puntos cuyo valor no pasa de `cents` (el valor se redondea hacia abajo). */
export function maxPointsForCents(fam: Pick<Family, 'rate_points' | 'rate_cents'>, cents: number) {
  if (fam.rate_cents === 0) return 0;
  return Math.ceil(((cents + 1) * fam.rate_points) / fam.rate_cents) - 1;
}

// ---------------------------------------------------------------------------------------------
// Canje: puntos → dinero, al momento y sin pedir permiso. Gasta del tope de la semana.
// ---------------------------------------------------------------------------------------------

export async function exchangePoints(child: AuthUser, p: { points: number; idempotencyKey?: string }) {
  requireChild(child);
  if (!Number.isInteger(p.points) || p.points <= 0) throw badRequest('Puntos no válidos');
  return tx(async (db) => {
    const fam = await getFamily(db, child.familyId);
    if (!fam.bank_exchange_enabled) throw disabled('El canje de puntos');
    await lockUser(db, child.id);
    const key = p.idempotencyKey ? `exch:${child.id}:${p.idempotencyKey}` : null;
    if (key) {
      const dup = await one(db, 'SELECT * FROM cap_uses WHERE idempotency_key = $1', [key]);
      if (dup) return { exchange: dup, duplicate: true };
    }
    if (p.points < fam.bank_exchange_min_points) throw badRequest(`El mínimo para canjear son ${fam.bank_exchange_min_points} puntos`, 'below_minimum');
    const balance = await pointsBalance(db, child.id);
    if (p.points > balance) throw conflict(`Solo tienes ${Math.max(0, balance)} puntos`, 'insufficient_balance');
    const cents = pointsToCents(fam, p.points);
    if (cents <= 0) throw badRequest('Esos puntos no llegan a un céntimo');
    const cap = await capStatus(db, fam, child.id, familyToday(fam));
    if (cap.remaining !== null && cents > cap.remaining) {
      throw conflict(`Esta semana solo puedes cambiar ${fmtEur(cap.remaining)} más`, 'cap_reached');
    }
    const ex = await one(
      db,
      `INSERT INTO cap_uses(family_id, user_id, kind, cap_week, points, cents, idempotency_key) VALUES ($1,$2,'exchange',$3,$4,$5,$6) RETURNING *`,
      [child.familyId, child.id, cap.weekStart, p.points, cents, key],
    );
    await addPoints(db, { familyId: child.familyId, userId: child.id, delta: -p.points, kind: 'exchange', refId: ex.id, note: 'Canje de puntos', createdBy: child.id, idempotencyKey: `exch-pts:${ex.id}` });
    await addMoney(db, { familyId: child.familyId, userId: child.id, deltaCents: cents, kind: 'exchange', refId: ex.id, note: `Canje de ${p.points} puntos`, createdBy: child.id, idempotencyKey: `exch-eur:${ex.id}` });
    await audit(db, child.familyId, child.id, 'bank.exchange', 'cap_use', ex.id, { points: p.points, cents });
    await notifyAdults(db, child.familyId, { event: 'points_exchanged', title: `${child.displayName} ha cambiado ${p.points} puntos por ${fmtEur(cents)}`, body: '', link: '/mesada', dedupeKey: `exchange:${ex.id}` });
    return { exchange: ex, duplicate: false };
  });
}

// ---------------------------------------------------------------------------------------------
// Adelanto: puntos ya ganados por encima del tope de esta semana, a cuenta del tope de la siguiente.
// ---------------------------------------------------------------------------------------------

/** Lo máximo que se puede adelantar ahora (0 si no se puede) y por qué no. */
export async function advanceRoom(db: Db, fam: Family, userId: string, today: string) {
  const cap = await capStatus(db, fam, userId, today);
  if (!fam.bank_advance_enabled) return { max: 0, cap, nextWeek: addDays(cap.weekStart, 7), reason: 'El adelanto está desactivado' };
  const nextWeek = addDays(cap.weekStart, 7);
  if (cap.weeklyCap == null) return { max: 0, cap, nextWeek, reason: NO_CAP };
  // Mientras pueda canjear (al menos el mínimo) esta semana, el adelanto no hace falta.
  const minCents = pointsToCents(fam, fam.bank_exchange_min_points);
  if ((cap.remaining ?? 0) >= Math.max(1, minCents)) return { max: 0, cap, nextWeek, reason: `Aún puedes canjear ${fmtEur(cap.remaining!)} esta semana` };
  const already = (await one<{ n: number }>(db, `SELECT COALESCE(SUM(cents),0)::int AS n FROM cap_uses WHERE user_id = $1 AND kind = 'advance' AND cap_week = $2`, [userId, nextWeek]))!.n;
  const max = Math.max(0, Math.floor((cap.weeklyCap * fam.bank_advance_percent) / 100) - already);
  if (max <= 0) return { max: 0, cap, nextWeek, reason: 'Ya has adelantado todo lo que se puede de la semana que viene' };
  const bal = await pointsBalance(db, userId);
  const affordable = Math.min(max, pointsToCents(fam, Math.max(0, bal)));
  if (affordable <= 0) return { max: 0, cap, nextWeek, reason: 'No tienes puntos para adelantar' };
  return { max: affordable, cap, nextWeek, reason: null as string | null };
}

export async function takeAdvance(child: AuthUser, p: { cents: number; idempotencyKey?: string }) {
  requireChild(child);
  if (!Number.isInteger(p.cents) || p.cents <= 0) throw badRequest('Importe no válido');
  return tx(async (db) => {
    const fam = await getFamily(db, child.familyId);
    if (!fam.bank_advance_enabled) throw disabled('El adelanto');
    if (weeklyCapCents(fam) == null) throw conflict(NO_CAP, 'no_cap');
    await lockUser(db, child.id);
    const key = p.idempotencyKey ? `adv:${child.id}:${p.idempotencyKey}` : null;
    if (key) {
      const dup = await one(db, 'SELECT * FROM cap_uses WHERE idempotency_key = $1', [key]);
      if (dup) return { advance: dup, duplicate: true };
    }
    const room = await advanceRoom(db, fam, child.id, familyToday(fam));
    if (room.reason) throw conflict(room.reason, 'advance_unavailable');
    if (p.cents > room.max) throw conflict(`Como mucho puedes adelantar ${fmtEur(room.max)}`, 'advance_too_big');
    const points = centsToPoints(fam, p.cents);
    const adv = await one(
      db,
      `INSERT INTO cap_uses(family_id, user_id, kind, cap_week, points, cents, idempotency_key) VALUES ($1,$2,'advance',$3,$4,$5,$6) RETURNING *`,
      [child.familyId, child.id, room.nextWeek, points, p.cents, key],
    );
    await addPoints(db, { familyId: child.familyId, userId: child.id, delta: -points, kind: 'advance', refId: adv.id, note: 'Adelanto', createdBy: child.id, idempotencyKey: `adv-pts:${adv.id}` });
    await addMoney(db, { familyId: child.familyId, userId: child.id, deltaCents: p.cents, kind: 'advance', refId: adv.id, note: 'Adelanto de la semana que viene', createdBy: child.id, idempotencyKey: `adv-eur:${adv.id}` });
    await audit(db, child.familyId, child.id, 'bank.advance', 'cap_use', adv.id, { points, cents: p.cents, nextWeek: room.nextWeek });
    await notifyAdults(db, child.familyId, {
      event: 'advance_taken', title: `${child.displayName} ha adelantado ${fmtEur(p.cents)}`,
      body: `Su tope de la semana que viene baja ${fmtEur(p.cents)}.`, link: '/mesada', dedupeKey: `advance:${adv.id}`,
    });
    return { advance: adv, duplicate: false };
  });
}

// ---------------------------------------------------------------------------------------------
// Retiro: las peticiones de dinero (payout_requests kind 'money') llevan límite semanal y saldo no negativo.
// ---------------------------------------------------------------------------------------------

export async function withdrawalsThisWeek(db: Db, fam: Family, userId: string, today: string) {
  const start = startOfWeek(today);
  const r = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM payout_requests
      WHERE user_id = $1 AND kind = 'money' AND status IN ('pending','approved')
        AND (created_at AT TIME ZONE $4)::date BETWEEN $2 AND $3`,
    [userId, start, addDays(start, 6), fam.timezone],
  );
  return r!.n;
}

/** Reglas del retiro; el que pide ya tiene la fila del usuario bloqueada. */
export async function assertCanWithdraw(db: Db, fam: Family, userId: string) {
  if (!fam.bank_withdraw_enabled) throw disabled('Retirar dinero');
  if ((await moneyBalance(db, userId)) < 0) throw conflict('Tu cuenta de dinero está en negativo. Hasta que vuelva a positivo no puedes retirar', 'negative_balance');
  const n = await withdrawalsThisWeek(db, fam, userId, familyToday(fam));
  if (n >= fam.bank_withdraw_per_week) throw conflict(`Ya has hecho ${n} ${n === 1 ? 'retiro' : 'retiros'} esta semana. Vuelve el lunes`, 'withdraw_limit');
}

// ---------------------------------------------------------------------------------------------
// Préstamo
// ---------------------------------------------------------------------------------------------

/** Cuota número `seq` (1..weeks): reparto entero y la última se lleva el resto. */
export function installmentCents(amount: number, weeks: number, seq: number) {
  const base = Math.floor(amount / weeks);
  return seq < weeks ? base : amount - base * (weeks - 1);
}

export async function requestLoan(child: AuthUser, p: { amountCents: number; weeks: number; note?: string; idempotencyKey?: string }) {
  requireChild(child);
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw badRequest('Importe no válido');
  if (!Number.isInteger(p.weeks) || p.weeks <= 0) throw badRequest('Semanas no válidas');
  return tx(async (db) => {
    const fam = await getFamily(db, child.familyId);
    if (!fam.bank_loan_enabled) throw disabled('El préstamo');
    const weekly = weeklyCapCents(fam);
    if (weekly == null) throw conflict(NO_CAP, 'no_cap');
    await lockUser(db, child.id);
    const idem = p.idempotencyKey ? `${child.id}:${p.idempotencyKey}` : null;
    if (idem) {
      const dup = await one(db, 'SELECT * FROM loans WHERE idempotency_key = $1', [idem]);
      if (dup) return { loan: dup, duplicate: true };
    }
    if (p.weeks > fam.bank_loan_max_weeks) throw badRequest(`Como mucho, ${fam.bank_loan_max_weeks} semanas`, 'too_many_weeks');
    const max = Math.floor((weekly * fam.bank_loan_max_percent) / 100);
    if (p.amountCents > max) throw badRequest(`Como mucho puedes pedir ${fmtEur(max)}`, 'loan_too_big');
    if (await one(db, `SELECT 1 FROM loans WHERE user_id = $1 AND status IN ('pending','active')`, [child.id])) {
      throw conflict('Ya tienes un préstamo. Termina de pagarlo antes de pedir otro', 'loan_open');
    }
    if ((await moneyBalance(db, child.id)) < 0) throw conflict('Tu cuenta de dinero está en negativo. Hasta que vuelva a positivo no puedes pedir un préstamo', 'negative_balance');
    const loan = await one(
      db,
      `INSERT INTO loans(family_id, user_id, amount_cents, weeks, interest_points, note, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [child.familyId, child.id, p.amountCents, p.weeks, fam.bank_loan_interest_points, p.note?.trim() ?? '', idem],
    );
    await audit(db, child.familyId, child.id, 'loan.request', 'loan', loan.id, { cents: p.amountCents, weeks: p.weeks });
    await notifyAdults(db, child.familyId, {
      event: 'loan_requested', title: `${child.displayName} pide un préstamo de ${fmtEur(p.amountCents)}`,
      body: `A devolver en ${p.weeks} ${p.weeks === 1 ? 'semana' : 'semanas'}.${p.note?.trim() ? ` «${p.note.trim()}»` : ''}`, link: '/validar', dedupeKey: `loan-req:${loan.id}`,
    });
    return { loan, duplicate: false };
  });
}

export async function cancelLoan(child: AuthUser, id: string) {
  return tx(async (db) => {
    const l = await one(db, 'SELECT * FROM loans WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, child.familyId]);
    if (!l) throw notFound('Préstamo no encontrado');
    if (l.user_id !== child.id) throw forbidden();
    if (l.status === 'cancelled') return { loan: l, duplicate: true };
    if (l.status !== 'pending') throw conflict('Este préstamo ya está resuelto', 'already_decided');
    const upd = await one(db, `UPDATE loans SET status = 'cancelled', decided_at = now() WHERE id = $1 RETURNING *`, [id]);
    await audit(db, child.familyId, child.id, 'loan.cancel', 'loan', id, {});
    return { loan: upd, duplicate: false };
  });
}

export async function decideLoan(adult: AuthUser, id: string, o: { approve: boolean; note?: string }) {
  return tx(async (db) => {
    const l = await one(db, 'SELECT * FROM loans WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, adult.familyId]);
    if (!l) throw notFound('Préstamo no encontrado');
    const want = o.approve ? 'active' : 'rejected';
    if (l.status === want || (o.approve && ['active', 'paid'].includes(l.status))) return { loan: l, duplicate: true };
    if (l.status !== 'pending') throw conflict('Este préstamo ya está resuelto', 'already_decided');
    const fam = await getFamily(db, adult.familyId);
    const note = o.note?.trim() ?? '';
    await lockUser(db, l.user_id);
    if (!o.approve) {
      const upd = await one(db, `UPDATE loans SET status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`, [id, note, adult.id]);
      await audit(db, adult.familyId, adult.id, 'loan.reject', 'loan', id, { note });
      await notify(db, { userId: l.user_id, event: 'loan_decided', title: `${adult.displayName} no ha aceptado tu préstamo de ${fmtEur(l.amount_cents)}`, body: note, link: '/mesada', dedupeKey: `loan-rejected:${id}` });
      return { loan: upd, duplicate: false };
    }
    if (!fam.bank_loan_enabled) throw disabled('El préstamo');
    if ((await moneyBalance(db, l.user_id)) < 0) throw conflict('Su cuenta de dinero está en negativo: no se le puede prestar', 'negative_balance');
    // La primera cuota se cobra el lunes siguiente al día de la aprobación.
    const firstWeek = addDays(startOfWeek(familyToday(fam)), 7);
    const upd = await one(
      db,
      `UPDATE loans SET status = 'active', first_charge_week = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE id = $1 RETURNING *`,
      [id, firstWeek, note, adult.id],
    );
    await addMoney(db, { familyId: adult.familyId, userId: l.user_id, deltaCents: l.amount_cents, kind: 'loan', refId: id, note: 'Préstamo', createdBy: adult.id, idempotencyKey: `loan:${id}` });
    await audit(db, adult.familyId, adult.id, 'loan.approve', 'loan', id, { cents: l.amount_cents, weeks: l.weeks });
    const first = installmentCents(l.amount_cents, l.weeks, 1);
    await notify(db, {
      userId: l.user_id, event: 'loan_decided', title: `${adult.displayName} ha aprobado tu préstamo de ${fmtEur(l.amount_cents)}`,
      body: `Cada lunes se descuentan ${fmtEur(first)}${l.interest_points ? ` y ${l.interest_points} puntos de interés` : ''}, durante ${l.weeks} ${l.weeks === 1 ? 'semana' : 'semanas'}. Empieza el ${firstWeek}.${note ? ` ${note}` : ''}`,
      link: '/mesada', dedupeKey: `loan-approved:${id}`,
    });
    return { loan: upd, duplicate: false };
  });
}

/** Préstamos de un hijo (o de la familia) con las cuotas que quedan y la próxima fecha de cobro. */
export async function listLoans(db: Db, familyId: string, o: { userId?: string; status?: string[] }) {
  const rows = await many(
    db,
    `SELECT l.*, u.display_name, u.avatar, u.color,
            COALESCE((SELECT SUM(c.cents) FROM loan_charges c WHERE c.loan_id = l.id),0)::int AS repaid_cents,
            COALESCE((SELECT SUM(c.interest_points) FROM loan_charges c WHERE c.loan_id = l.id),0)::int AS interest_paid_points
       FROM loans l JOIN users u ON u.id = l.user_id
      WHERE l.family_id = $1 AND ($2::uuid IS NULL OR l.user_id = $2) AND ($3::text[] IS NULL OR l.status = ANY($3))
      ORDER BY l.created_at DESC LIMIT 50`,
    [familyId, o.userId ?? null, o.status ?? null],
  );
  return rows.map((l) => {
    const remaining = l.status === 'active' ? l.weeks - l.installments_paid : 0;
    return {
      ...l,
      remaining_installments: remaining,
      remaining_cents: l.status === 'active' ? l.amount_cents - l.repaid_cents : 0,
      installment_cents: installmentCents(l.amount_cents, l.weeks, Math.min(l.weeks, l.installments_paid + 1)),
      next_charge_week: l.status === 'active' && l.first_charge_week ? addDays(l.first_charge_week, 7 * l.installments_paid) : null,
    };
  });
}

/** Cobra las cuotas vencidas (un lunes por cuota, con recuperación si el servidor estuvo parado). */
export async function chargeLoans(familyId: string, now = new Date()) {
  const loans = await many(getPool(), `SELECT id FROM loans WHERE family_id = $1 AND status = 'active'`, [familyId]);
  let charged = 0;
  for (const { id } of loans) {
    charged += await tx(async (db) => {
      const l = await one(db, 'SELECT * FROM loans WHERE id = $1 FOR UPDATE', [id]);
      if (!l || l.status !== 'active') return 0;
      const fam = await getFamily(db, familyId);
      const thisWeek = startOfWeek(familyToday(fam, now));
      await lockUser(db, l.user_id);
      let n = 0;
      let paid = l.installments_paid as number;
      while (paid < l.weeks && addDays(l.first_charge_week, 7 * paid) <= thisWeek) {
        const seq = paid + 1;
        const weekStart = addDays(l.first_charge_week, 7 * paid);
        const cents = installmentCents(l.amount_cents, l.weeks, seq);
        const ins = await db.query(
          `INSERT INTO loan_charges(loan_id, family_id, user_id, seq, week_start, cents, interest_points) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,
          [id, familyId, l.user_id, seq, weekStart, cents, l.interest_points],
        );
        paid = seq;
        if (ins.rowCount === 0) continue; // ya cobrada
        // Los saldos pueden quedar en negativo: es la deuda, que se paga con lo próximo que entre.
        await addMoney(db, { familyId, userId: l.user_id, deltaCents: -cents, kind: 'loan_repayment', refId: id, note: `Cuota ${seq} de ${l.weeks} del préstamo`, idempotencyKey: `loan-pay:${id}:${seq}` });
        if (l.interest_points > 0) {
          await addPoints(db, { familyId, userId: l.user_id, delta: -l.interest_points, kind: 'loan_interest', refId: id, note: `Interés del préstamo (cuota ${seq})`, idempotencyKey: `loan-int:${id}:${seq}` });
        }
        n++;
        await notify(db, {
          userId: l.user_id, event: 'loan_charged', title: `Cuota ${seq} de ${l.weeks} del préstamo`,
          body: `−${fmtEur(cents)}${l.interest_points ? ` y −${l.interest_points} puntos` : ''}.${seq === l.weeks ? ' ¡Ya lo has devuelto todo!' : ''}`,
          link: '/mesada', dedupeKey: `loan-charge:${id}:${seq}`,
        });
      }
      if (paid !== l.installments_paid) {
        await db.query(`UPDATE loans SET installments_paid = $2, status = CASE WHEN $2 >= weeks THEN 'paid' ELSE status END WHERE id = $1`, [id, paid]);
      }
      return n;
    });
  }
  return charged;
}

// ---------------------------------------------------------------------------------------------
// Vista general de la cuenta: saldos, números de cuenta y qué botones están disponibles (y por qué no).
// ---------------------------------------------------------------------------------------------

export async function bankOverview(db: Db, familyId: string, userId: string, now = new Date()) {
  const fam = await getFamily(db, familyId);
  const today = familyToday(fam, now);
  const [money, points, savings] = await Promise.all([
    moneyBalance(db, userId),
    pointsBalance(db, userId),
    moneyBalance(db, userId, 'savings'),
  ]);
  const cap = await capStatus(db, fam, userId, today);
  const withdrawals = await withdrawalsThisWeek(db, fam, userId, today);
  const openWithdrawal = await one(db, `SELECT 1 FROM payout_requests WHERE user_id = $1 AND kind = 'money' AND status = 'pending'`, [userId]);
  const adv = await advanceRoom(db, fam, userId, today);
  const loans = await listLoans(db, familyId, { userId, status: ['pending', 'active'] });
  const openLoan = loans[0] ?? null;
  const loanMax = cap.weeklyCap == null ? 0 : Math.floor((cap.weeklyCap * fam.bank_loan_max_percent) / 100);

  const minPts = fam.bank_exchange_min_points;
  const maxPts = Math.max(0, Math.min(points, cap.remaining == null ? points : maxPointsForCents(fam, cap.remaining)));
  let exchangeReason: string | null = null;
  if (!fam.bank_exchange_enabled) exchangeReason = 'El canje está desactivado';
  else if (points < minPts) exchangeReason = `Necesitas al menos ${minPts} puntos`;
  else if (maxPts < minPts) exchangeReason = cap.remaining === 0 ? 'Ya has llegado al tope de esta semana' : `Esta semana solo te caben ${fmtEur(cap.remaining ?? 0)}`;

  let withdrawReason: string | null = null;
  if (!fam.bank_withdraw_enabled) withdrawReason = 'Retirar está desactivado';
  else if (money < 0) withdrawReason = 'Tu cuenta está en negativo';
  else if (money === 0) withdrawReason = 'No tienes dinero que retirar';
  else if (openWithdrawal) withdrawReason = 'Ya tienes un retiro esperando';
  else if (withdrawals >= fam.bank_withdraw_per_week) withdrawReason = `Ya hiciste ${withdrawals} retiros esta semana. Vuelve el lunes`;

  let loanReason: string | null = null;
  if (!fam.bank_loan_enabled) loanReason = 'El préstamo está desactivado';
  else if (cap.weeklyCap == null) loanReason = NO_CAP;
  else if (openLoan) loanReason = openLoan.status === 'pending' ? 'Tu préstamo espera respuesta' : 'Ya tienes un préstamo';
  else if (money < 0) loanReason = 'Tu cuenta está en negativo';

  const goalCount = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM savings_goals WHERE user_id = $1 AND status = 'active' AND NOT archived`, [userId]))!.n;
  let saveReason: string | null = null;
  if (goalCount === 0) saveReason = 'Crea primero una meta';
  else if (money <= 0) saveReason = 'No tienes dinero para ahorrar';

  return {
    accounts: { money: accountNumber(userId, 'money'), points: accountNumber(userId, 'points') },
    money_cents: money,
    points,
    savings_cents: savings,
    rate: { points: fam.rate_points, cents: fam.rate_cents },
    week: {
      start: cap.weekStart, end: cap.weekEnd, cap_cents: cap.weeklyCap, used_cents: cap.usedWeek, remaining_cents: cap.remaining,
      withdrawals_used: withdrawals, withdrawals_max: fam.bank_withdraw_per_week,
    },
    actions: {
      withdraw: { ok: !withdrawReason, reason: withdrawReason, max_cents: Math.max(0, money) },
      exchange: { ok: !exchangeReason, reason: exchangeReason, min_points: minPts, max_points: maxPts },
      advance: { ok: !adv.reason, reason: adv.reason, max_cents: adv.max },
      loan: { ok: !loanReason, reason: loanReason, max_cents: loanMax, max_weeks: fam.bank_loan_max_weeks, interest_points: fam.bank_loan_interest_points },
      save: { ok: !saveReason, reason: saveReason },
    },
    loan: openLoan,
    owed_cents: money + savings,
  };
}

/** Extracto de una cuenta con el saldo tras cada movimiento (más reciente primero). */
export async function statement(db: Db, userId: string, account: 'money' | 'points') {
  if (account === 'points') {
    return many(
      db,
      `SELECT * FROM (
         SELECT l.id, l.delta AS amount, l.kind, l.note, l.created_at, c.display_name AS created_by_name,
                SUM(l.delta) OVER (ORDER BY l.created_at, l.seq)::int AS balance_after, l.created_at AS ts, l.seq
           FROM points_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = $1
       ) s ORDER BY ts DESC, seq DESC LIMIT 200`,
      [userId],
    );
  }
  return many(
    db,
    `SELECT * FROM (
       SELECT l.id, l.delta_cents AS amount, l.kind, l.note, l.created_at, c.display_name AS created_by_name,
              SUM(l.delta_cents) OVER (ORDER BY l.created_at, l.seq)::int AS balance_after, l.created_at AS ts, l.seq
         FROM money_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = $1 AND l.account = 'available'
     ) s ORDER BY ts DESC, seq DESC LIMIT 200`,
    [userId],
  );
}
