import { many, one, tx } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { familyToday, getFamily, pointsToCents, centsToPoints } from './family.js';
import { addMoney, addPoints, LIFETIME_POINTS_SQL, lockUser, moneyBalance, pointsBalance } from './ledger.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { isValidDate, periodBounds } from './dates.js';
import { evaluateBadges } from './gamification.js';
import { capUsedInPeriod } from './cap.js';
import { fmtMoney } from './currency.js';
import { applyAutoSave } from './savings.js';

function periodLabel(start: string, end: string) {
  const f = (d: string, o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('es-ES', { ...o, timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`));
  return `${f(start, { day: 'numeric', month: 'short' })} – ${f(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

async function assertChild(db: any, familyId: string, userId: string) {
  const u = await one(db, `SELECT id, display_name, role FROM users WHERE id = $1 AND family_id = $2 AND active`, [userId, familyId]);
  if (!u) throw notFound('Miembro no encontrado');
  if (u.role !== 'child') throw badRequest('Esta operación es solo para perfiles de hijos');
  return u as { id: string; display_name: string };
}

/**
 * Cierre de periodo: convierte el saldo de puntos del hijo en euros según la tasa, aplicando el límite
 * por periodo. Los puntos que exceden el límite se quedan como puntos. Un único cierre por hijo y periodo.
 */
export async function settlePeriod(adult: AuthUser, userId: string, anyDateInPeriod: string) {
  if (!isValidDate(anyDateInPeriod)) throw badRequest('Fecha no válida');
  return tx(async (db) => {
    const fam = await getFamily(db, adult.familyId);
    const child = await assertChild(db, adult.familyId, userId);
    const { start, end } = periodBounds(fam.settlement_period, anyDateInPeriod);
    if (start > familyToday(fam)) throw badRequest('No se puede cerrar un periodo que aún no ha empezado');
    await lockUser(db, userId);
    const existing = await one(db, 'SELECT id FROM settlements WHERE user_id = $1 AND period_start = $2', [userId, start]);
    if (existing) throw conflict('Este periodo ya está cerrado para este hijo', 'already_settled');

    const points = Math.max(0, await pointsBalance(db, userId));
    let cents = pointsToCents(fam, points);
    let converted = points;
    let capped = false;
    // El tope del periodo se reparte con los canjes y adelantos ya hechos: el cierre solo convierte lo que quede.
    const room = fam.cap_cents === null ? null : Math.max(0, fam.cap_cents - (await capUsedInPeriod(db, fam, userId, start, end)));
    if (room !== null && cents > room) {
      cents = room;
      converted = Math.min(points, centsToPoints(fam, cents));
      capped = true;
    }
    const s = await one(
      db,
      `INSERT INTO settlements(family_id, user_id, period_start, period_end, points_converted, cents, capped, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [adult.familyId, userId, start, end, converted, cents, capped, adult.id],
    );
    if (converted > 0) {
      await addPoints(db, { familyId: adult.familyId, userId, delta: -converted, kind: 'conversion', refId: s.id, note: `Cierre ${periodLabel(start, end)}`, createdBy: adult.id, idempotencyKey: `settle-pts:${s.id}` });
    }
    if (cents > 0) {
      await addMoney(db, { familyId: adult.familyId, userId, deltaCents: cents, kind: 'conversion', refId: s.id, note: `Cierre ${periodLabel(start, end)}`, createdBy: adult.id, idempotencyKey: `settle-eur:${s.id}` });
    }
    // Ahorro automático (I19): el % acordado de lo cobrado va solo a cada meta.
    const autoSaved = await applyAutoSave(db, adult.familyId, userId, s.id, cents, fam.currency, adult.id);
    await audit(db, adult.familyId, adult.id, 'allowance.settle', 'settlement', s.id, { userId, start, end, points: converted, cents, capped, autoSaved });
    await notify(db, { userId, event: 'settlement', title: 'Cierre de periodo', body: `${converted} puntos convertidos en ${fmtMoney(cents, fam.currency)}`, link: '/mesada', dedupeKey: `settlement:${s.id}` });
    return s;
  });
}

const METHOD_PHRASE: Record<string, string> = { cash: ' en efectivo', transfer: ' por transferencia', bizum: ' por Bizum', other: '' };

type PaymentInput = { userId: string; amountCents: number; method: string; note?: string; idempotencyKey?: string; notifyChild?: boolean };

/** Pago dentro de una transacción ya abierta (lo usa también la aprobación de una petición del hijo). */
export async function recordPaymentTx(db: any, adult: AuthUser, p: PaymentInput) {
  if (!Number.isInteger(p.amountCents) || p.amountCents <= 0) throw badRequest('Importe no válido');
  await assertChild(db, adult.familyId, p.userId);
  if (p.idempotencyKey) {
    const dup = await one(db, 'SELECT * FROM payments WHERE idempotency_key = $1 AND family_id = $2', [p.idempotencyKey, adult.familyId]);
    if (dup) return { ...dup, duplicate: true };
  }
  await lockUser(db, p.userId);
  const available = await moneyBalance(db, p.userId);
  const cur = (await getFamily(db, adult.familyId)).currency;
  if (p.amountCents > available) throw conflict('El pago supera el saldo pendiente de este hijo', 'insufficient_balance');
  const pay = await one(
    db,
    `INSERT INTO payments(family_id, user_id, amount_cents, method, note, paid_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [adult.familyId, p.userId, p.amountCents, p.method, p.note ?? '', adult.id, p.idempotencyKey ?? null],
  );
  await addMoney(db, { familyId: adult.familyId, userId: p.userId, deltaCents: -p.amountCents, kind: 'payment', refId: pay.id, note: p.note ?? 'Pago', createdBy: adult.id, idempotencyKey: `payment:${pay.id}` });
  await audit(db, adult.familyId, adult.id, 'allowance.payment', 'payment', pay.id, { userId: p.userId, for: p.userId, cents: p.amountCents, method: p.method });
  if (p.notifyChild !== false) {
    const left = available - p.amountCents;
    const fmtEur = (c: number) => fmtMoney(c, cur);
    await notify(db, {
      userId: p.userId, event: 'payment',
      title: `${adult.displayName} te ha pagado ${fmtEur(p.amountCents)}${METHOD_PHRASE[p.method] ?? ''}.`,
      body: `Te quedan ${fmtEur(left)}.${p.note?.trim() ? ` ${p.note.trim()}` : ''}`,
      link: '/mesada', dedupeKey: `payment:${pay.id}`,
    });
  }
  return { ...pay, duplicate: false };
}

export async function recordPayment(adult: AuthUser, p: PaymentInput) {
  return tx((db) => recordPaymentTx(db, adult, p));
}

export async function adjustPoints(adult: AuthUser, p: { userId: string; delta: number; note: string; bonus?: boolean; idempotencyKey?: string }) {
  if (!Number.isInteger(p.delta) || p.delta === 0 || Math.abs(p.delta) > 100000) throw badRequest('Ajuste no válido');
  if (!p.note.trim()) throw badRequest('Indica el motivo del ajuste');
  return tx(async (db) => {
    await assertChild(db, adult.familyId, p.userId);
    await lockUser(db, p.userId);
    const kind = p.bonus && p.delta > 0 ? 'bonus' : 'adjustment';
    const r = await addPoints(db, { familyId: adult.familyId, userId: p.userId, delta: p.delta, kind, note: p.note, createdBy: adult.id, idempotencyKey: p.idempotencyKey ? `adj:${adult.familyId}:${p.idempotencyKey}` : null });
    if (r.duplicate) return { duplicate: true };
    await audit(db, adult.familyId, adult.id, 'points.adjust', 'user', p.userId, { delta: p.delta, note: p.note, kind, for: p.userId });
    await notify(db, { userId: p.userId, event: 'points_adjusted', emoji: p.delta > 0 ? '⭐' : '📉', title: p.delta > 0 ? `+${p.delta} puntos` : `${p.delta} puntos`, body: p.note, link: '/progreso', dedupeKey: r.id ? `points:${r.id}` : null });
    return { duplicate: false, balance: await pointsBalance(db, p.userId) };
  });
}

export async function adjustMoney(adult: AuthUser, p: { userId: string; deltaCents: number; note: string; idempotencyKey?: string }) {
  if (!Number.isInteger(p.deltaCents) || p.deltaCents === 0) throw badRequest('Ajuste no válido');
  if (!p.note.trim()) throw badRequest('Indica el motivo del ajuste');
  return tx(async (db) => {
    await assertChild(db, adult.familyId, p.userId);
    await lockUser(db, p.userId);
    const r = await addMoney(db, { familyId: adult.familyId, userId: p.userId, deltaCents: p.deltaCents, kind: 'adjustment', note: p.note, createdBy: adult.id, idempotencyKey: p.idempotencyKey ? `madj:${adult.familyId}:${p.idempotencyKey}` : null });
    if (r.duplicate) return { duplicate: true };
    if ((await moneyBalance(db, p.userId)) < 0) throw conflict('El ajuste dejaría el saldo en negativo', 'insufficient_balance');
    await audit(db, adult.familyId, adult.id, 'money.adjust', 'user', p.userId, { cents: p.deltaCents, note: p.note, for: p.userId });
    return { duplicate: false };
  });
}

/** Mover dinero entre saldo disponible y hucha. Los hijos solo pueden ahorrar; sacar de la hucha es cosa de adultos. */
export async function transferSavings(actor: AuthUser, p: { userId: string; cents: number; direction: 'to_savings' | 'from_savings'; idempotencyKey?: string }) {
  if (!Number.isInteger(p.cents) || p.cents <= 0) throw badRequest('Importe no válido');
  if (actor.role === 'child' && (actor.id !== p.userId || p.direction !== 'to_savings')) {
    throw forbidden('Para sacar dinero de la hucha, pide a un adulto');
  }
  return tx(async (db) => {
    await assertChild(db, actor.familyId, p.userId);
    await lockUser(db, p.userId);
    const fromAcc = p.direction === 'to_savings' ? 'available' : 'savings';
    const toAcc = p.direction === 'to_savings' ? 'savings' : 'available';
    if ((await moneyBalance(db, p.userId, fromAcc)) < p.cents) throw conflict('No hay saldo suficiente', 'insufficient_balance');
    const key = p.idempotencyKey ? `xfer:${actor.familyId}:${p.idempotencyKey}` : null;
    const a = await addMoney(db, { familyId: actor.familyId, userId: p.userId, account: fromAcc, deltaCents: -p.cents, kind: 'transfer', note: 'Hucha', createdBy: actor.id, idempotencyKey: key ? key + ':out' : null });
    if (a.duplicate) return { duplicate: true };
    await addMoney(db, { familyId: actor.familyId, userId: p.userId, account: toAcc, deltaCents: p.cents, kind: 'transfer', note: 'Hucha', createdBy: actor.id, idempotencyKey: key ? key + ':in' : null });
    await audit(db, actor.familyId, actor.id, 'savings.transfer', 'user', p.userId, { cents: p.cents, direction: p.direction, for: p.userId });
    const fam = await getFamily(db, actor.familyId);
    await evaluateBadges(db, p.userId, familyToday(fam), fam.timezone, 0);
    return { duplicate: false };
  });
}

export async function requestRedemption(child: AuthUser, rewardId: string) {
  if (child.role !== 'child') throw forbidden('Solo los hijos pueden pedir recompensas');
  return tx(async (db) => {
    const reward = await one(db, 'SELECT * FROM rewards WHERE id = $1 AND family_id = $2 AND active', [rewardId, child.familyId]);
    if (!reward) throw notFound('Recompensa no disponible');
    await lockUser(db, child.id);
    const bal = await pointsBalance(db, child.id);
    if (bal < reward.cost_points) throw conflict(`Te faltan ${reward.cost_points - bal} puntos`, 'insufficient_balance');
    const red = await one(
      db,
      `INSERT INTO redemptions(family_id, reward_id, reward_title, user_id, cost_points) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [child.familyId, reward.id, reward.title, child.id, reward.cost_points],
    );
    // Los puntos se reservan al pedir; si se rechaza, se devuelven.
    await addPoints(db, { familyId: child.familyId, userId: child.id, delta: -reward.cost_points, kind: 'redemption', refId: red.id, note: reward.title, createdBy: child.id, idempotencyKey: `redeem:${red.id}` });
    await audit(db, child.familyId, child.id, 'reward.request', 'redemption', red.id, { reward: reward.title, cost: reward.cost_points });
    await notifyAdults(db, child.familyId, { event: 'reward_requested', title: `${child.displayName} quiere «${reward.title}»`, body: `${reward.cost_points} puntos`, link: '/validar', dedupeKey: `redeem:${red.id}` });
    return red;
  });
}

export async function decideRedemption(adult: AuthUser, redemptionId: string, decision: 'approved' | 'rejected' | 'delivered', note = '') {
  return tx(async (db) => {
    const red = await one(db, 'SELECT * FROM redemptions WHERE id = $1 AND family_id = $2 FOR UPDATE', [redemptionId, adult.familyId]);
    if (!red) throw notFound('Petición no encontrada');
    const allowed: Record<string, string[]> = { requested: ['approved', 'rejected', 'delivered'], approved: ['delivered', 'rejected'] };
    if (!allowed[red.status]?.includes(decision)) throw conflict('Esta petición ya está resuelta', 'already_decided');
    await db.query(`UPDATE redemptions SET status = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $1`, [red.id, decision, adult.id, note]);
    if (decision === 'rejected') {
      await addPoints(db, { familyId: adult.familyId, userId: red.user_id, delta: red.cost_points, kind: 'refund', refId: red.id, note: `Devolución: ${red.reward_title}`, createdBy: adult.id, idempotencyKey: `refund:${red.id}` });
    }
    await audit(db, adult.familyId, adult.id, `reward.${decision}`, 'redemption', red.id, { note });
    const msg = { approved: 'aprobada', rejected: 'rechazada (puntos devueltos)', delivered: 'entregada' }[decision];
    await notify(db, { userId: red.user_id, event: 'reward_decided', title: `«${red.reward_title}» ${msg}`, body: note, link: '/premios', dedupeKey: `redeem-${decision}:${red.id}` });
    if (decision !== 'rejected') {
      const fam = await getFamily(db, adult.familyId);
      await evaluateBadges(db, red.user_id, familyToday(fam), fam.timezone, 0);
    }
    return { id: red.id, status: decision };
  });
}

/** Resumen económico de un hijo, manteniendo separados puntos, saldo convertido y pagado. */
export async function walletSummary(db: any, familyId: string, userId: string) {
  const r = await one(
    db,
    `SELECT
      (SELECT COALESCE(SUM(delta),0) FROM points_ledger WHERE user_id = $1)::int AS points_available,
      (SELECT ${LIFETIME_POINTS_SQL} FROM points_ledger WHERE user_id = $1) AS points_lifetime,
      (SELECT COALESCE(SUM(delta_cents),0) FROM money_ledger WHERE user_id = $1 AND account = 'available')::int AS cents_pending,
      (SELECT COALESCE(SUM(delta_cents),0) FROM money_ledger WHERE user_id = $1 AND account = 'savings')::int AS cents_savings,
      (SELECT COALESCE(SUM(cents),0) FROM settlements WHERE user_id = $1)::int AS cents_converted_total,
      (SELECT COALESCE(SUM(amount_cents),0) FROM payments WHERE user_id = $1)::int AS cents_paid_total,
      (SELECT COALESCE(SUM(cost_points),0) FROM redemptions WHERE user_id = $1 AND status = 'requested')::int AS points_reserved,
      (SELECT COALESCE(SUM(delta),0) FROM screen_ledger WHERE user_id = $1)::int AS screen_minutes`,
    [userId],
  );
  const fam = await getFamily(db, familyId);
  return { ...r, points_value_cents: pointsToCents(fam, Math.max(0, r.points_available)) };
}

export async function listSettlements(db: any, familyId: string, userId?: string) {
  return many(
    db,
    `SELECT s.*, u.display_name FROM settlements s JOIN users u ON u.id = s.user_id
      WHERE s.family_id = $1 AND ($2::uuid IS NULL OR s.user_id = $2) ORDER BY s.period_start DESC, u.display_name LIMIT 100`,
    [familyId, userId ?? null],
  );
}
