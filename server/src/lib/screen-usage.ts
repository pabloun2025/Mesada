import { many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { familyToday, getFamily } from './family.js';
import { addPoints, lockUser } from './ledger.js';
import { addScreen, CATEGORY_PHRASE, type ScreenCategory } from './screen.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';

/** Puntos por anotar con honestidad la pantalla de un día (una vez al día, sea cual sea el nº de anotaciones). */
export const HONESTY_POINTS = 5;

/**
 * Deja los puntos de honestidad de un día en el estado que toca, y solo una vez al día:
 * hay premio si alguna anotación vigente está confirmada y ninguna vigente se pasó del saldo.
 * Es idempotente: se puede llamar tras confirmar, anular o anotar un exceso. Dentro de una transacción.
 */
export async function syncHonesty(db: Db, familyId: string, userId: string, day: string, actorId: string | null) {
  await lockUser(db, userId);
  const logs = await many<{ status: string; overflow_minutes: number }>(
    db, `SELECT status, overflow_minutes FROM screen_usage_logs WHERE user_id = $1 AND day = $2 AND status <> 'voided'`, [userId, day],
  );
  const eligible = logs.some((l) => l.status === 'confirmed') && !logs.some((l) => l.overflow_minutes > 0);
  const row = await one<{ grants: number; granted: boolean }>(db, 'SELECT grants, granted FROM honesty_days WHERE user_id = $1 AND day = $2 FOR UPDATE', [userId, day]);
  const granted = row?.granted ?? false;
  const grants = row?.grants ?? 0;
  if (eligible && !granted) {
    // La primera concesión usa la clave `honesty:{hijo}:{día}`; si se concede otra vez tras compensarla, lleva sufijo.
    const key = grants === 0 ? `honesty:${userId}:${day}` : `honesty:${userId}:${day}:${grants}`;
    const r = await addPoints(db, { familyId, userId, delta: HONESTY_POINTS, kind: 'bonus', note: 'Por anotar tu pantalla con honestidad', createdBy: actorId, idempotencyKey: key });
    await db.query(
      `INSERT INTO honesty_days(user_id, day, family_id, grants, granted) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (user_id, day) DO UPDATE SET grants = EXCLUDED.grants, granted = true`,
      [userId, day, familyId, grants + 1],
    );
    await notify(db, { userId, event: 'points_adjusted', emoji: '🌟', title: `+${HONESTY_POINTS} puntos por ser honesto`, body: 'Gracias por anotar tu pantalla. ¡Así da gusto! 😊', link: '/progreso', dedupeKey: r.id ? `points:${r.id}` : null });
    return { granted: true, changed: true };
  }
  if (!eligible && granted) {
    const r = await addPoints(db, { familyId, userId, delta: -HONESTY_POINTS, kind: 'adjustment', note: 'Puntos de honestidad retirados', createdBy: actorId, idempotencyKey: `honesty-rev:${userId}:${day}:${grants - 1}`, reversesEarning: true });
    await db.query('UPDATE honesty_days SET granted = false WHERE user_id = $1 AND day = $2', [userId, day]);
    await notify(db, { userId, event: 'points_adjusted', emoji: '📉', title: `−${HONESTY_POINTS} puntos`, body: 'Ese día ya no cuenta como pantalla anotada con honestidad.', link: '/progreso', dedupeKey: r.id ? `points:${r.id}` : null });
    return { granted: false, changed: true };
  }
  return { granted, changed: false };
}

/** El hijo anota lo que ha usado: los minutos se restan ya; lo que exceda el saldo queda como «exceso». */
export async function logScreenUsage(
  child: AuthUser,
  p: { minutes: number; category: ScreenCategory; note?: string; idempotencyKey?: string },
) {
  if (child.role !== 'child') throw forbidden('Solo los hijos anotan su pantalla');
  if (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > 720) throw badRequest('Los minutos deben estar entre 1 y 720');
  return tx(async (db) => {
    await lockUser(db, child.id);
    // La clave lleva el id del hijo: la restricción de unicidad es global y no debe cruzar familias.
    const idem = p.idempotencyKey ? `${child.id}:${p.idempotencyKey}` : null;
    if (idem) {
      const dup = await one(db, 'SELECT * FROM screen_usage_logs WHERE idempotency_key = $1', [idem]);
      if (dup) return { log: dup, duplicate: true };
    }
    const fam = await getFamily(db, child.familyId);
    const day = familyToday(fam);
    const note = p.note?.trim() ?? '';
    // El movimiento se crea con ref al registro, así que primero se reserva su id.
    const created = await one(
      db,
      `INSERT INTO screen_usage_logs(family_id, user_id, day, minutes, applied_minutes, overflow_minutes, category, note, idempotency_key)
       VALUES ($1,$2,$3,$4,0,$4,$5,$6,$7) RETURNING id`,
      [child.familyId, child.id, day, p.minutes, p.category, note, idem],
    );
    const r = await addScreen(db, { familyId: child.familyId, userId: child.id, delta: -p.minutes, kind: 'usage', refId: created!.id, note: note || 'Anotado por ti', createdBy: child.id, category: p.category, idempotencyKey: `usage:${created!.id}` });
    const applied = -r.applied;
    const overflow = p.minutes - applied;
    const log = await one(db, 'UPDATE screen_usage_logs SET applied_minutes = $2, overflow_minutes = $3 WHERE id = $1 RETURNING *', [created!.id, applied, overflow]);
    await audit(db, child.familyId, child.id, 'screen.usage', 'screen_usage_log', log.id, { minutes: p.minutes, applied, overflow, category: p.category });
    if (overflow > 0) {
      // Un exceso quita el premio del día aunque ya estuviera concedido.
      await syncHonesty(db, child.familyId, child.id, day, null);
      await notifyAdults(db, child.familyId, {
        event: 'screen_overuse',
        title: `${child.displayName} anotó más pantalla de la que tenía`,
        body: `${p.minutes} min ${CATEGORY_PHRASE[p.category]}; tenía ${applied}. Se pasó ${overflow} min y el saldo queda en 0.`,
        link: '/validar', dedupeKey: `overuse:${log.id}`,
      });
    }
    return { log, duplicate: false, balance: r.balance };
  });
}

async function loadLog(db: Db, adult: AuthUser, id: string) {
  const log = await one(db, 'SELECT * FROM screen_usage_logs WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, adult.familyId]);
  if (!log) throw notFound('Anotación no encontrada');
  return log;
}

export async function confirmUsage(adult: AuthUser, id: string) {
  return tx(async (db) => {
    const log = await loadLog(db, adult, id);
    if (log.status === 'voided') throw conflict('Esta anotación está anulada', 'already_voided');
    if (log.status === 'confirmed') return { log, duplicate: true, honesty: false };
    const upd = await one(db, `UPDATE screen_usage_logs SET status = 'confirmed', decided_by = $2, decided_at = now() WHERE id = $1 RETURNING *`, [id, adult.id]);
    const h = await syncHonesty(db, adult.familyId, log.user_id, log.day, adult.id);
    await audit(db, adult.familyId, adult.id, 'screen.usage_confirm', 'screen_usage_log', id, { minutes: log.minutes, honesty: h.granted });
    await notify(db, { userId: log.user_id, event: 'screen_changed', title: `${adult.displayName} ha confirmado tu pantalla`, body: `${log.minutes} min ${CATEGORY_PHRASE[log.category as ScreenCategory]}.`, link: '/mesada', dedupeKey: `usage-confirm:${id}` });
    return { log: upd, duplicate: false, honesty: h.granted };
  });
}

export async function voidUsage(adult: AuthUser, id: string) {
  return tx(async (db) => {
    const log = await loadLog(db, adult, id);
    if (log.status === 'voided') return { log, duplicate: true, refunded: 0 };
    await lockUser(db, log.user_id);
    // Se devuelve exactamente lo que se restó, no lo que el hijo dijo que usó.
    let refunded = 0;
    if (log.applied_minutes > 0) {
      const r = await addScreen(db, { familyId: adult.familyId, userId: log.user_id, delta: log.applied_minutes, kind: 'refund', refId: id, note: 'Anotación anulada', createdBy: adult.id, category: log.category, idempotencyKey: `usage-void:${id}` });
      refunded = r.applied;
    }
    const upd = await one(db, `UPDATE screen_usage_logs SET status = 'voided', decided_by = $2, decided_at = now() WHERE id = $1 RETURNING *`, [id, adult.id]);
    await syncHonesty(db, adult.familyId, log.user_id, log.day, adult.id);
    await audit(db, adult.familyId, adult.id, 'screen.usage_void', 'screen_usage_log', id, { minutes: log.minutes, refunded });
    await notify(db, { userId: log.user_id, event: 'screen_changed', title: `${adult.displayName} ha anulado tu anotación de pantalla`, body: refunded ? `Te devuelve ${refunded} min.` : 'No había minutos que devolver.', link: '/mesada', dedupeKey: `usage-void:${id}` });
    return { log: upd, duplicate: false, refunded };
  });
}

export async function listUsageLogs(db: Db, familyId: string, opts: { userId?: string; status?: string }) {
  return many(
    db,
    `SELECT g.*, u.display_name, u.avatar, u.color FROM screen_usage_logs g JOIN users u ON u.id = g.user_id
      WHERE g.family_id = $1 AND ($2::uuid IS NULL OR g.user_id = $2) AND ($3::text IS NULL OR g.status = $3)
      ORDER BY g.created_at DESC LIMIT 100`,
    [familyId, opts.userId ?? null, opts.status ?? null],
  );
}
