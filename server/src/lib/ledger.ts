import { one, type Db } from './db.js';
import { badRequest, conflict } from './errors.js';

export type PointsKind = 'task' | 'adjustment' | 'bonus' | 'redemption' | 'refund' | 'conversion' | 'exchange' | 'advance' | 'loan_interest';
export type MoneyKind =
  | 'conversion' | 'payment' | 'adjustment' | 'transfer' | 'exchange' | 'advance' | 'loan' | 'loan_repayment'
  | 'interest' | 'interest_forfeit' | 'goal_redeem';

/** Bloquea la fila del usuario para serializar operaciones de saldo concurrentes (dentro de una transacción). */
export async function lockUser(db: Db, userId: string) {
  await db.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [userId]);
}

/**
 * Puntos ganados de por vida (niveles): lo ganado en tareas y bonos menos lo que se ha deshecho
 * (correcciones, tareas desmarcadas, puntos de honestidad anulados). Nunca baja de 0.
 */
export const LIFETIME_POINTS_SQL = `GREATEST(0, COALESCE(SUM(delta) FILTER (WHERE (kind IN ('task','bonus') AND delta > 0) OR (reverses_earning AND delta < 0)), 0))::int`;

export async function pointsBalance(db: Db, userId: string): Promise<number> {
  const r = await one<{ b: number }>(db, 'SELECT COALESCE(SUM(delta),0)::int AS b FROM points_ledger WHERE user_id = $1', [userId]);
  return r!.b;
}

export async function moneyBalance(db: Db, userId: string, account: 'available' | 'savings' = 'available'): Promise<number> {
  const r = await one<{ b: number }>(
    db,
    'SELECT COALESCE(SUM(delta_cents),0)::int AS b FROM money_ledger WHERE user_id = $1 AND account = $2',
    [userId, account],
  );
  return r!.b;
}

/**
 * Inserta un movimiento de puntos. Si la clave de idempotencia ya existe, no duplica y devuelve `duplicate: true`.
 */
export async function addPoints(
  db: Db,
  e: { familyId: string; userId: string; delta: number; kind: PointsKind; refId?: string | null; note?: string; createdBy?: string | null; idempotencyKey?: string | null; reversesEarning?: boolean },
) {
  if (!Number.isInteger(e.delta)) throw badRequest('Los puntos deben ser un número entero');
  const r = await db.query(
    `INSERT INTO points_ledger(family_id, user_id, delta, kind, ref_id, note, created_by, idempotency_key, reverses_earning)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [e.familyId, e.userId, e.delta, e.kind, e.refId ?? null, e.note ?? '', e.createdBy ?? null, e.idempotencyKey ?? null, e.reversesEarning ?? false],
  );
  return { id: r.rows[0]?.id as string | undefined, duplicate: r.rowCount === 0 };
}

export async function addMoney(
  db: Db,
  e: { familyId: string; userId: string; deltaCents: number; kind: MoneyKind; account?: 'available' | 'savings'; goalId?: string | null; refId?: string | null; note?: string; createdBy?: string | null; idempotencyKey?: string | null },
) {
  if (!Number.isInteger(e.deltaCents)) throw badRequest('Importe no válido');
  const r = await db.query(
    `INSERT INTO money_ledger(family_id, user_id, account, delta_cents, kind, ref_id, note, created_by, idempotency_key, goal_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [e.familyId, e.userId, e.account ?? 'available', e.deltaCents, e.kind, e.refId ?? null, e.note ?? '', e.createdBy ?? null, e.idempotencyKey ?? null, e.goalId ?? null],
  );
  return { id: r.rows[0]?.id as string | undefined, duplicate: r.rowCount === 0 };
}

export function ensureNonNegative(balance: number, msg: string) {
  if (balance < 0) throw conflict(msg, 'insufficient_balance');
}
