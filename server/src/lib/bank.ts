import { createHash, randomUUID } from 'node:crypto';
import { getPool, many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { centsToPoints, familyToday, getFamily, pointsToCents, type Family } from './family.js';
import { addMoney, addPoints, lockUser, moneyBalance, pointsBalance } from './ledger.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { addDays, startOfWeek } from './dates.js';
import { capStatus, weeklyCapCents } from './cap.js';

import { fmtMoney, type Currency } from './currency.js';
import { applyExpense, quoteExpense, type ExpenseInput } from './expenses.js';

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
    const fmtEur = (c: number) => fmtMoney(c, fam.currency);
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
    const exchangedAt = new Date();
    const cap = await capStatus(db, fam, child.id, familyToday(fam, exchangedAt));
    if (cap.remaining !== null && cents > cap.remaining) {
      throw conflict(`Esta semana solo puedes cambiar ${fmtEur(cap.remaining)} más`, 'cap_reached');
    }
    const ex = await one(
      db,
      `INSERT INTO cap_uses(family_id, user_id, kind, cap_week, points, cents, idempotency_key, created_at) VALUES ($1,$2,'exchange',$3,$4,$5,$6,$7) RETURNING *`,
      [child.familyId, child.id, cap.weekStart, p.points, cents, key, exchangedAt],
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
  const fmtEur = (c: number) => fmtMoney(c, fam.currency);
  const cap = await capStatus(db, fam, userId, today);
  if (!fam.bank_advance_enabled) return { max: 0, cap, nextWeek: addDays(cap.weekStart, 7), reason: 'El adelanto está desactivado', hint: 'Desactivado' };
  const nextWeek = addDays(cap.weekStart, 7);
  if (cap.weeklyCap == null) return { max: 0, cap, nextWeek, reason: NO_CAP, hint: 'Sin tope' };
  // Mientras pueda canjear (al menos el mínimo) esta semana, el adelanto no hace falta.
  const minCents = pointsToCents(fam, fam.bank_exchange_min_points);
  if ((cap.remaining ?? 0) >= Math.max(1, minCents)) return { max: 0, cap, nextWeek, reason: `Aún puedes canjear ${fmtEur(cap.remaining!)} esta semana`, hint: 'Canjea antes' };
  const already = (await one<{ n: number }>(db, `SELECT COALESCE(SUM(cents),0)::int AS n FROM cap_uses WHERE user_id = $1 AND kind = 'advance' AND cap_week = $2`, [userId, nextWeek]))!.n;
  const max = Math.max(0, Math.floor((cap.weeklyCap * fam.bank_advance_percent) / 100) - already);
  if (max <= 0) return { max: 0, cap, nextWeek, reason: 'Ya has adelantado todo lo que se puede de la semana que viene', hint: 'Sin cupo' };
  const bal = await pointsBalance(db, userId);
  const affordable = Math.min(max, pointsToCents(fam, Math.max(0, bal)));
  if (affordable <= 0) return { max: 0, cap, nextWeek, reason: 'No tienes puntos para adelantar', hint: 'Sin puntos' };
  return { max: affordable, cap, nextWeek, reason: null as string | null, hint: null as string | null };
}

export async function takeAdvance(child: AuthUser, p: { cents: number; idempotencyKey?: string }) {
  requireChild(child);
  if (!Number.isInteger(p.cents) || p.cents <= 0) throw badRequest('Importe no válido');
  return tx(async (db) => {
    const fam = await getFamily(db, child.familyId);
    const fmtEur = (c: number) => fmtMoney(c, fam.currency);
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
    const fmtEur = (c: number) => fmtMoney(c, fam.currency);
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

export type LoanPurchase = { type: 'purchase'; title: string; totalCents: number; currency: Currency };
export type LoanDestination = { type: 'balance' } | { type: 'external'; method: 'cash' | 'bizum' | 'transfer' }
  | { type: 'goal'; goalId: string } | (LoanPurchase & { requestId: string; token: string });
const LOAN_METHOD = { cash: 'efectivo', bizum: 'Bizum', transfer: 'transferencia' };

const DISBURSEMENT = `CASE WHEN d.loan_id IS NOT NULL THEN jsonb_build_object(
  'destination', d.destination, 'currency', d.currency, 'method', d.method, 'goal_id', d.goal_id, 'goal_title', d.goal_title,
  'expense_id', d.expense_id, 'expense_title', d.expense_title, 'actor_id', d.actor_id, 'actor_name', da.display_name, 'created_at', d.created_at
) END`;

async function loanDisbursement(db: Db, loanId: string) {
  return (await one(db, `SELECT ${DISBURSEMENT} AS receipt FROM loan_disbursements d LEFT JOIN users da ON da.id = d.actor_id WHERE d.loan_id = $1`, [loanId]))?.receipt ?? null;
}

function loanExpense(userId: string, p: LoanPurchase): ExpenseInput {
  return { userId, title: p.title, totalCents: p.totalCents, currency: p.currency, contribution: { type: 'amount', cents: 0 } };
}

async function checkLoanFunds(db: Db, fam: Family, userId: string) {
  if (!fam.bank_loan_enabled) throw disabled('El préstamo');
  if ((await moneyBalance(db, userId)) < 0) throw conflict('Su cuenta de dinero está en negativo: no se le puede prestar', 'negative_balance');
}

async function lockLoanChild(db: Db, familyId: string, userId: string) {
  if (!(await one(db, `SELECT id FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active FOR UPDATE`, [userId, familyId]))) {
    throw notFound('Hijo no encontrado');
  }
}

export function previewLoanPurchase(adult: AuthUser, id: string, purchase: LoanPurchase) {
  return tx(async (db) => {
    const loan = await one(db, 'SELECT * FROM loans WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, adult.familyId]);
    if (!loan) throw notFound('Préstamo no encontrado');
    if (loan.status !== 'pending') throw conflict('Este préstamo ya está resuelto', 'already_decided');
    await lockLoanChild(db, adult.familyId, loan.user_id);
    const fam = await getFamily(db, adult.familyId);
    await checkLoanFunds(db, fam, loan.user_id);
    const requestId = randomUUID();
    const { breakdown, token } = await quoteExpense(db, adult.familyId, loanExpense(loan.user_id, purchase), requestId, { loanId: id, principalCents: loan.amount_cents }, fam);
    return { breakdown, token, requestId };
  });
}

async function matchDisbursement(db: Db, receipt: any, destination: LoanDestination) {
  if (destination.type !== (receipt?.destination ?? 'balance')) return false;
  if (destination.type === 'external') return receipt.method === destination.method;
  if (destination.type === 'goal') return receipt.goal_id === destination.goalId;
  if (destination.type !== 'purchase') return true;
  return !!(await one(db, `SELECT 1 FROM child_expenses WHERE id = $1 AND title = $2 AND total_cents = $3 AND currency = $4 AND request_id = $5 AND quote_token = $6`,
    [receipt.expense_id, destination.title, destination.totalCents, destination.currency, destination.requestId, destination.token]));
}

export async function decideLoan(adult: AuthUser, id: string, o: { approve: boolean; note?: string; destination?: LoanDestination }) {
  return tx(async (db) => {
    const l = await one(db, 'SELECT * FROM loans WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, adult.familyId]);
    if (!l) throw notFound('Préstamo no encontrado');
    const destination: LoanDestination = o.destination ?? { type: 'balance' };
    if (o.approve && ['active', 'paid'].includes(l.status)) {
      const receipt = await loanDisbursement(db, id);
      if (!(await matchDisbursement(db, receipt, destination))) throw conflict('El préstamo ya se entregó con otro destino', 'already_decided');
      return { loan: { ...l, disbursement: receipt }, duplicate: true };
    }
    if (!o.approve && l.status === 'rejected') return { loan: l, duplicate: true };
    if (l.status !== 'pending') throw conflict('Este préstamo ya está resuelto', 'already_decided');
    const note = o.note?.trim() ?? '';
    let goal: { id: string; title: string } | undefined;
    if (o.approve && destination.type === 'goal') {
      const target = await one<{ id: string; title: string; status: string }>(db,
        'SELECT id, title, status FROM savings_goals WHERE id = $1 AND family_id = $2 AND user_id = $3 AND NOT archived FOR NO KEY UPDATE',
        [destination.goalId, adult.familyId, l.user_id]);
      if (!target) throw notFound('Meta no encontrada');
      if (target.status !== 'active' || await one(db, `SELECT 1 FROM goal_requests WHERE goal_id = $1 AND status = 'pending'`, [target.id])) {
        throw conflict('La meta ya no admite aportaciones', 'goal_unavailable');
      }
      goal = target;
    }
    if (o.approve) await lockLoanChild(db, adult.familyId, l.user_id);
    else await lockUser(db, l.user_id);
    const fam = await getFamily(db, adult.familyId);
    const fmtEur = (c: number) => fmtMoney(c, fam.currency);
    if (!o.approve) {
      const upd = await one(db, `UPDATE loans SET status = 'rejected', decision_note = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING *`, [id, note, adult.id]);
      await audit(db, adult.familyId, adult.id, 'loan.reject', 'loan', id, { note, for: l.user_id });
      await notify(db, { userId: l.user_id, event: 'loan_decided', title: `${adult.displayName} no ha aceptado tu préstamo de ${fmtEur(l.amount_cents)}`, body: note, link: '/mesada', dedupeKey: `loan-rejected:${id}` });
      return { loan: upd, duplicate: false };
    }
    await checkLoanFunds(db, fam, l.user_id);
    const input = destination.type === 'purchase' ? loanExpense(l.user_id, destination) : null;
    const quote = destination.type === 'purchase' && input
      ? await quoteExpense(db, adult.familyId, input, destination.requestId, { loanId: id, principalCents: l.amount_cents }, fam) : null;
    // La primera cuota se cobra el lunes siguiente al día de la aprobación.
    const firstWeek = addDays(startOfWeek(familyToday(fam)), 7);
    const upd = await one(
      db,
      `UPDATE loans SET status = 'active', first_charge_week = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE id = $1 RETURNING *`,
      [id, firstWeek, note, adult.id],
    );
    const movement = { familyId: adult.familyId, userId: l.user_id, refId: id, createdBy: adult.id };
    await addMoney(db, { ...movement, deltaCents: l.amount_cents, kind: 'loan', note: 'Préstamo', idempotencyKey: `loan:${id}` });
    let expenseId: string | null = null;
    let delivered = 'Se abonó en tu saldo.';
    if (destination.type === 'external') {
      delivered = `Se entregó por ${LOAN_METHOD[destination.method]}.`;
      await addMoney(db, { ...movement, deltaCents: -l.amount_cents, kind: 'loan_delivery', note: `Entrega del préstamo · ${LOAN_METHOD[destination.method]}`, idempotencyKey: `loan-delivery:${id}` });
    } else if (goal) {
      delivered = `Se aportó a tu meta «${goal.title}».`;
      const note = `Préstamo para «${goal.title}»`;
      await addMoney(db, { ...movement, deltaCents: -l.amount_cents, kind: 'transfer', note, idempotencyKey: `loan-goal-out:${id}` });
      await addMoney(db, { ...movement, deltaCents: l.amount_cents, kind: 'transfer', account: 'savings', goalId: goal.id, note, idempotencyKey: `loan-goal-in:${id}` });
    } else if (destination.type === 'purchase' && input && quote) {
      delivered = `Se aplicó a «${destination.title}».`;
      expenseId = (await applyExpense(db, adult, input, destination.requestId, destination.token, quote)).id;
    }
    await db.query(`INSERT INTO loan_disbursements(loan_id, family_id, user_id, actor_id, destination, currency, method, goal_id, goal_title, expense_id, expense_title)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, adult.familyId, l.user_id, adult.id, destination.type, fam.currency,
      destination.type === 'external' ? destination.method : null, goal?.id ?? null, goal?.title ?? null, expenseId, destination.type === 'purchase' ? destination.title : null]);
    await audit(db, adult.familyId, adult.id, 'loan.approve', 'loan', id, { cents: l.amount_cents, weeks: l.weeks, for: l.user_id, destination: destination.type });
    const first = installmentCents(l.amount_cents, l.weeks, 1);
    await notify(db, {
      userId: l.user_id, event: 'loan_decided', title: `${adult.displayName} ha aprobado tu préstamo de ${fmtEur(l.amount_cents)}`,
      body: `${delivered} Cada lunes se descuentan ${fmtEur(first)}${l.interest_points ? ` y ${l.interest_points} puntos de interés` : ''}, durante ${l.weeks} ${l.weeks === 1 ? 'semana' : 'semanas'}. Empieza el ${firstWeek}.${note ? ` ${note}` : ''}`,
      link: '/mesada', dedupeKey: `loan-approved:${id}`,
    });
    return { loan: { ...upd, disbursement: await loanDisbursement(db, id) }, duplicate: false };
  });
}

/** Préstamos de un hijo (o de la familia) con las cuotas que quedan y la próxima fecha de cobro. */
export async function listLoans(db: Db, familyId: string, o: { userId?: string; status?: string[] }) {
  const rows = await many(
    db,
    `SELECT l.*, u.display_name, u.avatar, u.color, ${DISBURSEMENT} AS disbursement,
            COALESCE((SELECT SUM(c.cents) FROM loan_charges c WHERE c.loan_id = l.id),0)::int AS repaid_cents,
            COALESCE((SELECT SUM(c.interest_points) FROM loan_charges c WHERE c.loan_id = l.id),0)::int AS interest_paid_points
       FROM loans l JOIN users u ON u.id = l.user_id
       LEFT JOIN loan_disbursements d ON d.loan_id = l.id LEFT JOIN users da ON da.id = d.actor_id
      WHERE l.family_id = $1 AND ($2::uuid IS NULL OR l.user_id = $2) AND ($3::text[] IS NULL OR l.status = ANY($3))
      ORDER BY l.created_at DESC LIMIT 50`,
    [familyId, o.userId ?? null, o.status ?? null],
  );
  const pendingWeek = rows.some((l) => l.status === 'pending') ? addDays(startOfWeek(familyToday(await getFamily(db, familyId))), 7) : null;
  return rows.map((l) => {
    const remaining = l.status === 'active' ? l.weeks - l.installments_paid : 0;
    return {
      ...l,
      remaining_installments: remaining,
      remaining_cents: l.status === 'active' ? l.amount_cents - l.repaid_cents : 0,
      installment_cents: installmentCents(l.amount_cents, l.weeks, Math.min(l.weeks, l.installments_paid + 1)),
      next_charge_week: l.status === 'active' && l.first_charge_week ? addDays(l.first_charge_week, 7 * l.installments_paid) : null,
      proposed_first_charge_week: l.status === 'pending' ? pendingWeek : null,
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
      const fmtEur = (c: number) => fmtMoney(c, fam.currency);
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
  const fmtEur = (c: number) => fmtMoney(c, fam.currency);
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
  // Cada motivo lleva además una pista corta para el botón redondo (el motivo completo sale al tocarlo).
  let exchangeReason: string | null = null;
  let exchangeHint: string | null = null;
  if (!fam.bank_exchange_enabled) { exchangeReason = 'El canje está desactivado'; exchangeHint = 'Desactivado'; }
  else if (points < minPts) { exchangeReason = `Necesitas al menos ${minPts} puntos`; exchangeHint = `Mín. ${minPts} pts`; }
  else if (maxPts < minPts) { exchangeReason = cap.remaining === 0 ? 'Ya has llegado al tope de esta semana' : `Esta semana solo te caben ${fmtEur(cap.remaining ?? 0)}`; exchangeHint = 'Tope semanal'; }

  let withdrawReason: string | null = null;
  let withdrawHint: string | null = null;
  if (!fam.bank_withdraw_enabled) { withdrawReason = 'Retirar está desactivado'; withdrawHint = 'Desactivado'; }
  else if (money < 0) { withdrawReason = 'Tu cuenta está en negativo'; withdrawHint = 'En negativo'; }
  else if (money === 0) { withdrawReason = 'No tienes dinero que retirar'; withdrawHint = 'Sin saldo'; }
  else if (openWithdrawal) { withdrawReason = 'Ya tienes un retiro esperando'; withdrawHint = 'En curso'; }
  else if (withdrawals >= fam.bank_withdraw_per_week) { withdrawReason = `Ya hiciste ${withdrawals} retiros esta semana. Vuelve el lunes`; withdrawHint = 'Vuelve el lunes'; }

  let loanReason: string | null = null;
  let loanHint: string | null = null;
  if (!fam.bank_loan_enabled) { loanReason = 'El préstamo está desactivado'; loanHint = 'Desactivado'; }
  else if (cap.weeklyCap == null) { loanReason = NO_CAP; loanHint = 'Sin tope'; }
  else if (openLoan) { loanReason = openLoan.status === 'pending' ? 'Tu préstamo espera respuesta' : 'Ya tienes un préstamo'; loanHint = openLoan.status === 'pending' ? 'En espera' : 'En curso'; }
  else if (money < 0) { loanReason = 'Tu cuenta está en negativo'; loanHint = 'En negativo'; }

  const goalCount = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM savings_goals WHERE user_id = $1 AND status = 'active' AND NOT archived`, [userId]))!.n;
  const proposedCount = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM savings_goals WHERE user_id = $1 AND status = 'proposed' AND NOT archived`, [userId]))!.n;
  let saveReason: string | null = null;
  let saveHint: string | null = null;
  if (goalCount === 0 && proposedCount > 0) { saveReason = 'Tu meta espera la aprobación de tus padres'; saveHint = 'En espera'; }
  else if (goalCount === 0) { saveReason = 'Crea primero una meta'; saveHint = 'Crea una meta'; }
  else if (money <= 0) { saveReason = 'No tienes dinero para ahorrar'; saveHint = 'Sin saldo'; }

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
      withdraw: { ok: !withdrawReason, reason: withdrawReason, hint: withdrawHint, max_cents: Math.max(0, money) },
      exchange: { ok: !exchangeReason, reason: exchangeReason, hint: exchangeHint, min_points: minPts, max_points: maxPts },
      advance: { ok: !adv.reason, reason: adv.reason, hint: adv.hint, max_cents: adv.max },
      loan: { ok: !loanReason, reason: loanReason, hint: loanHint, max_cents: loanMax, max_weeks: fam.bank_loan_max_weeks, interest_points: fam.bank_loan_interest_points },
      save: { ok: !saveReason, reason: saveReason, hint: saveHint },
    },
    loan: openLoan,
    owed_cents: money + savings,
    history: await balanceHistory(db, fam, userId, today),
  };
}

/**
 * Saldo de dinero al final de cada una de las últimas `n` semanas (lunes a domingo, en la zona de la familia).
 * La semana en curso termina «ahora», así que su último punto es el saldo actual. `start_cents` es el saldo
 * justo antes de la primera semana, para poder decir cuánto ha cambiado en total.
 */
export async function balanceHistory(db: Db, fam: Family, userId: string, today: string, n = 8) {
  const thisWeek = startOfWeek(today);
  const first = addDays(thisWeek, -7 * (n - 1));
  const rows = await many<{ week_start: string; balance: number }>(
    db,
    `SELECT to_char(w.ws::date, 'YYYY-MM-DD') AS week_start,
            COALESCE((SELECT SUM(l.delta_cents) FROM money_ledger l
                       WHERE l.user_id = $1 AND l.account = 'available'
                         AND (l.created_at AT TIME ZONE $4)::date <= (w.ws::date + 6)), 0)::int AS balance
       FROM generate_series($2::date, $3::date, interval '7 days') AS w(ws) ORDER BY w.ws`,
    [userId, first, thisWeek, fam.timezone],
  );
  const start = await one<{ b: number }>(
    db,
    `SELECT COALESCE(SUM(delta_cents),0)::int AS b FROM money_ledger WHERE user_id = $1 AND account = 'available' AND (created_at AT TIME ZONE $3)::date < $2::date`,
    [userId, first, fam.timezone],
  );
  const weeks = rows.map((r) => ({ week_start: r.week_start, balance_cents: r.balance }));
  const last = weeks[weeks.length - 1]?.balance_cents ?? 0;
  const prev = weeks.length > 1 ? weeks[weeks.length - 2].balance_cents : start!.b;
  return { weeks, start_cents: start!.b, delta_cents: last - start!.b, week_delta_cents: last - prev };
}

/** Resumen de banco de toda la familia para los padres: lo que deben, préstamos vivos e interés de la semana. */
export async function familyBankSummary(db: Db, familyId: string, now = new Date()) {
  const fam = await getFamily(db, familyId);
  const fmtEur = (c: number) => fmtMoney(c, fam.currency);
  const weekStart = startOfWeek(familyToday(fam, now));
  const r = await one<{ money: number; savings: number; interest: number; loans: number; loans_left: number }>(
    db,
    `SELECT
       COALESCE((SELECT SUM(l.delta_cents) FROM money_ledger l JOIN users u ON u.id = l.user_id WHERE l.family_id = $1 AND u.active AND u.role = 'child' AND l.account = 'available'),0)::int AS money,
       COALESCE((SELECT SUM(l.delta_cents) FROM money_ledger l JOIN users u ON u.id = l.user_id WHERE l.family_id = $1 AND u.active AND u.role = 'child' AND l.account = 'savings'),0)::int AS savings,
       COALESCE((SELECT SUM(l.delta_cents) FROM money_ledger l WHERE l.family_id = $1 AND l.kind = 'interest' AND (l.created_at AT TIME ZONE $3)::date >= $2::date),0)::int AS interest,
       (SELECT count(*) FROM loans WHERE family_id = $1 AND status = 'active')::int AS loans,
       COALESCE((SELECT SUM(x.amount_cents - COALESCE((SELECT SUM(c.cents) FROM loan_charges c WHERE c.loan_id = x.id),0)) FROM loans x WHERE x.family_id = $1 AND x.status = 'active'),0)::int AS loans_left`,
    [familyId, weekStart, fam.timezone],
  );
  return {
    owed_cents: r!.money + r!.savings, money_cents: r!.money, savings_cents: r!.savings,
    loans_active: r!.loans, loans_remaining_cents: r!.loans_left, interest_week_cents: r!.interest,
  };
}

export type StatementAccount = 'money' | 'points' | 'all';

/**
 * Extracto con el saldo tras cada movimiento (más reciente primero), paginado.
 * - `points` y `money` son un libro cada uno; `all` los mezcla por fecha.
 * - En dinero también salen, como movimientos «de meta», el interés, el interés perdido y la compra de la meta
 *   (viven en la cuenta de ahorro; su saldo es el de esa meta, no el de la cuenta).
 */
export async function statement(db: Db, userId: string, account: StatementAccount, o: { limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(o.limit ?? 200, 1), 200);
  const offset = Math.max(o.offset ?? 0, 0);
  const pointsSql = `
    SELECT l.id, 'points'::text AS account, 'account'::text AS scope, l.delta AS amount, l.kind, l.note, l.created_at, c.display_name AS created_by_name,
           SUM(l.delta) OVER (ORDER BY l.created_at, l.seq)::int AS balance_after, NULL::text AS method, false AS is_withdrawal, l.seq, NULL::jsonb AS expense, NULL::jsonb AS disbursement
      FROM points_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = $1`;
  const moneySql = `
    SELECT l.id, 'money'::text AS account, 'account'::text AS scope, l.delta_cents AS amount, l.kind, l.note, l.created_at, c.display_name AS created_by_name,
           SUM(l.delta_cents) OVER (ORDER BY l.created_at, l.seq)::int AS balance_after,
           CASE WHEN l.kind = 'payment' THEN (SELECT p.method FROM payments p WHERE p.id = l.ref_id) WHEN l.kind = 'loan_delivery' THEN d.method END AS method,
           CASE WHEN l.kind = 'payment' THEN EXISTS (SELECT 1 FROM payout_requests q WHERE q.payment_id = l.ref_id) ELSE false END AS is_withdrawal, l.seq,
           CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
             'total_cents', e.total_cents, 'parent_cents', e.parent_cents, 'parent_basis_points', e.parent_basis_points, 'child_cents', -l.delta_cents,
             'cash_cents', e.cash_cents, 'used_points', e.used_points, 'points_cents', e.points_cents,
             'debt_cents', e.debt_cents, 'balance_after', e.balance_after, 'currency', e.currency, 'rule', e.rule_snapshot,
             'loan_cents', e.loan_cents,
             'loan_applied_cents', CASE WHEN e.loan_cents IS NOT NULL THEN LEAST(e.loan_cents, e.total_cents) END,
             'prior_cash_cents', CASE WHEN e.loan_cents IS NOT NULL THEN GREATEST(0, e.cash_cents - e.loan_cents) END
           ) END AS expense, ${DISBURSEMENT} AS disbursement
      FROM money_ledger l
      LEFT JOIN users c ON c.id = l.created_by
      LEFT JOIN child_expenses e ON l.kind = 'expense' AND e.id = l.ref_id AND e.user_id = l.user_id AND e.family_id = l.family_id
      LEFT JOIN loan_disbursements d ON l.kind IN ('loan','loan_delivery') AND d.loan_id = l.ref_id AND d.user_id = l.user_id AND d.family_id = l.family_id
      LEFT JOIN users da ON da.id = d.actor_id
      WHERE l.user_id = $1 AND l.account = 'available'
    UNION ALL
    SELECT * FROM (
      SELECT l.id, 'money'::text AS account, 'goal'::text AS scope, l.delta_cents AS amount, l.kind, l.note, l.created_at, c.display_name AS created_by_name,
             SUM(l.delta_cents) OVER (PARTITION BY l.goal_id ORDER BY l.created_at, l.seq)::int AS balance_after, NULL::text AS method, false AS is_withdrawal, l.seq, NULL::jsonb AS expense, NULL::jsonb AS disbursement
        FROM money_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = $1 AND l.account = 'savings'
    ) g WHERE g.kind IN ('interest','interest_forfeit','goal_redeem','goal_match','goal_gift','goal_reversal')`;
  const inner = account === 'points' ? pointsSql : account === 'money' ? moneySql : `${pointsSql} UNION ALL ${moneySql}`;
  const rows = await many(
    db,
    `SELECT * FROM (${inner}) s ORDER BY created_at DESC, seq DESC, id DESC LIMIT $2 OFFSET $3`,
    [userId, limit + 1, offset],
  );
  return { entries: rows.slice(0, limit), has_more: rows.length > limit };
}
