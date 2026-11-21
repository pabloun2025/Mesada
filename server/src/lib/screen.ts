import { one, type Db } from './db.js';
import { lockUser } from './ledger.js';
import { badRequest } from './errors.js';

export type ScreenKind = 'bonus' | 'penalty' | 'spend' | 'adjustment' | 'refund' | 'task' | 'usage';

/** Categorías de pantalla: comparten un único saldo de minutos, solo describen en qué se gastó. */
export const SCREEN_CATEGORIES = ['videojuegos', 'tele', 'tablet', 'movil', 'ordenador', 'otro'] as const;
export type ScreenCategory = (typeof SCREEN_CATEGORIES)[number];

/** «de videojuegos», «de tele»… para frases como «te ha dado 30 min de videojuegos». */
export const CATEGORY_PHRASE: Record<ScreenCategory, string> = {
  videojuegos: 'de videojuegos', tele: 'de tele', tablet: 'de tablet', movil: 'de móvil', ordenador: 'de ordenador', otro: 'de pantalla',
};

export async function screenBalance(db: Db, userId: string): Promise<number> {
  const r = await one<{ b: number }>(db, 'SELECT COALESCE(SUM(delta),0)::int AS b FROM screen_ledger WHERE user_id = $1', [userId]);
  return r!.b;
}

/**
 * Movimiento de minutos de pantalla. Debe llamarse dentro de una transacción.
 * Un movimiento negativo se recorta al saldo (nunca queda por debajo de 0); `applied` es lo que se movió de verdad.
 * Bloquea la fila del hijo para serializar movimientos concurrentes (el trigger de la base lo vuelve a garantizar).
 */
export async function addScreen(
  db: Db,
  e: { familyId: string; userId: string; delta: number; kind: ScreenKind; refId?: string | null; note?: string; createdBy?: string | null; idempotencyKey?: string | null; category?: ScreenCategory | null },
): Promise<{ id?: string; applied: number; requested: number; duplicate: boolean; balance: number }> {
  if (!Number.isInteger(e.delta)) throw badRequest('Los minutos deben ser un número entero');
  await lockUser(db, e.userId);
  if (e.idempotencyKey) {
    const dup = await one<{ delta: number }>(db, 'SELECT delta FROM screen_ledger WHERE idempotency_key = $1', [e.idempotencyKey]);
    if (dup) return { applied: dup.delta, requested: e.delta, duplicate: true, balance: await screenBalance(db, e.userId) };
  }
  const bal = await screenBalance(db, e.userId);
  const applied = e.delta < 0 ? -Math.min(-e.delta, bal) : e.delta;
  const ins = await db.query(
    `INSERT INTO screen_ledger(family_id, user_id, delta, kind, ref_id, note, created_by, idempotency_key, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [e.familyId, e.userId, applied, e.kind, e.refId ?? null, e.note ?? '', e.createdBy ?? null, e.idempotencyKey ?? null, e.category ?? null],
  );
  return { id: ins.rows[0].id as string, applied, requested: e.delta, duplicate: false, balance: bal + applied };
}
