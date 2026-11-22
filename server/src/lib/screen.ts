import { many, one, tx, type Db } from './db.js';
import { lockUser } from './ledger.js';
import { badRequest } from './errors.js';
import { addDays, diffDays, isoWeekday, startOfWeek, todayIn } from './dates.js';
import { zonedToUtc } from './notify/time.js';

export type ScreenKind = 'bonus' | 'penalty' | 'spend' | 'adjustment' | 'refund' | 'task' | 'usage' | 'plan' | 'expiry';

/** Categorías de pantalla: comparten un único saldo de minutos, solo describen en qué se gastó. */
export const SCREEN_CATEGORIES = ['videojuegos', 'tele', 'tablet', 'movil', 'ordenador', 'otro'] as const;
export type ScreenCategory = (typeof SCREEN_CATEGORIES)[number];

/** «de videojuegos», «de tele»… para frases como «te ha dado 30 min de videojuegos». */
export const CATEGORY_PHRASE: Record<ScreenCategory, string> = {
  videojuegos: 'de videojuegos', tele: 'de tele', tablet: 'de tablet', movil: 'de móvil', ordenador: 'de ordenador', otro: 'de pantalla',
};

/** Los minutos ganados caducan a los 30 días: el primer lunes a partir de ese día (entre 30 y 36 días; siempre pasa un fin de semana). */
export const EARNED_DAYS = 30;

/** Primer lunes que cae en `earnDay + 30 días` o después (fechas civiles de la familia). */
export function earnedExpiryDay(earnDay: string): string {
  const t = addDays(earnDay, EARNED_DAYS);
  return addDays(t, (8 - isoWeekday(t)) % 7);
}

/** El plan semanal caduca el lunes siguiente al de su semana. */
export function planExpiryDay(planWeek: string): string {
  return addDays(planWeek, 7);
}

/** Las 00:00 de ese día en la zona de la familia. */
export const midnightAt = (day: string, tz: string) => zonedToUtc(day, '00:00', tz);

/** «mañana», «el jueves» o «el 3 de diciembre», según lo lejos que esté `day` de `today`. */
export function phraseUntil(day: string, today: string): string {
  const n = diffDays(day, today);
  if (n <= 1) return 'mañana';
  const d = new Date(`${day}T12:00:00Z`);
  if (n < 7) return `el ${new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: 'UTC' }).format(d)}`;
  return `el ${new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d)}`;
}

export async function screenBalance(db: Db, userId: string): Promise<number> {
  const r = await one<{ b: number }>(db, 'SELECT COALESCE(SUM(delta),0)::int AS b FROM screen_ledger WHERE user_id = $1', [userId]);
  return r!.b;
}

async function familyTz(db: Db, familyId: string): Promise<string> {
  return (await one<{ timezone: string }>(db, 'SELECT timezone FROM families WHERE id = $1', [familyId]))!.timezone;
}

/** Pausa vigente de un hijo (no puede gastar ni pedir minutos), o null. */
export async function activePause(db: Db, userId: string, today: string) {
  return one<{ id: string; pause_starts_on: string; pause_ends_on: string; reason_title: string }>(
    db,
    `SELECT id, pause_starts_on, pause_ends_on, reason_title FROM screen_adjustments
      WHERE user_id = $1 AND effect = 'pause' AND status = 'active' AND pause_ends_on > $2`,
    [userId, today],
  );
}

/** Una pausa cuya fecha ya pasó deja de estar «activa» (libera el índice de una sola pausa vigente). */
export async function endLapsedPauses(db: Db, userId: string, today: string) {
  await db.query(`UPDATE screen_adjustments SET status = 'ended', ended_at = now() WHERE user_id = $1 AND effect = 'pause' AND status = 'active' AND pause_ends_on <= $2`, [userId, today]);
}

interface LedgerInsert {
  familyId: string; userId: string; delta: number; kind: ScreenKind; refId?: string | null; note?: string; createdBy?: string | null;
  idempotencyKey?: string | null; category?: ScreenCategory | null;
}

async function insertLedger(db: Db, e: LedgerInsert) {
  const ins = await db.query(
    `INSERT INTO screen_ledger(family_id, user_id, delta, kind, ref_id, note, created_by, idempotency_key, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [e.familyId, e.userId, e.delta, e.kind, e.refId ?? null, e.note ?? '', e.createdBy ?? null, e.idempotencyKey ?? null, e.category ?? null],
  );
  return ins.rows[0].id as string;
}

/** Caduca los lotes vencidos: cada uno deja un movimiento «Caducado» para que el saldo siga cuadrando con el libro. */
export async function expireLots(db: Db, familyId: string, userId: string, now = new Date()) {
  const due = await many<{ id: string; remaining: number; source: string }>(
    db, `SELECT id, remaining, source FROM screen_lots WHERE user_id = $1 AND remaining > 0 AND expires_at <= $2 ORDER BY expires_at, id FOR UPDATE`, [userId, now],
  );
  let expired = 0;
  for (const l of due) {
    await insertLedger(db, {
      familyId, userId, delta: -l.remaining, kind: 'expiry', refId: l.id,
      note: l.source === 'plan' ? 'Caducado · plan de la semana' : 'Caducado · minutos ganados', idempotencyKey: `expiry:${l.id}`,
    });
    await db.query('UPDATE screen_lots SET remaining = 0 WHERE id = $1', [l.id]);
    expired += l.remaining;
  }
  return expired;
}

/** Si por cualquier motivo el libro tiene más minutos que los lotes (datos anteriores), la diferencia pasa a un lote «ganado». */
async function reconcileLots(db: Db, familyId: string, userId: string, bal: number, today: string, tz: string) {
  const r = await one<{ s: number }>(db, 'SELECT COALESCE(SUM(remaining),0)::int AS s FROM screen_lots WHERE user_id = $1', [userId]);
  if (bal > r!.s) {
    await db.query(
      `INSERT INTO screen_lots(family_id, user_id, source, amount, remaining, expires_at) VALUES ($1,$2,'earned',$3,$3,$4)`,
      [familyId, userId, bal - r!.s, midnightAt(earnedExpiryDay(today), tz)],
    );
  }
}

/**
 * Movimiento de minutos de pantalla. Debe llamarse dentro de una transacción.
 * - Positivo: crea un lote (plan semanal o ganado) con su caducidad.
 * - Negativo: se recorta al saldo (nunca queda por debajo de 0) y se descuenta de los lotes que caducan antes.
 * `applied` es lo que se movió de verdad. Bloquea la fila del hijo para serializar movimientos concurrentes
 * (el trigger de la base lo vuelve a garantizar).
 */
export async function addScreen(
  db: Db,
  e: LedgerInsert & { planWeek?: string; now?: Date },
): Promise<{ id?: string; applied: number; requested: number; duplicate: boolean; balance: number }> {
  if (!Number.isInteger(e.delta)) throw badRequest('Los minutos deben ser un número entero');
  if (e.kind === 'expiry') throw badRequest('Los minutos caducados se registran con expireLots');
  await lockUser(db, e.userId);
  if (e.idempotencyKey) {
    const dup = await one<{ delta: number }>(db, 'SELECT delta FROM screen_ledger WHERE idempotency_key = $1', [e.idempotencyKey]);
    if (dup) return { applied: dup.delta, requested: e.delta, duplicate: true, balance: await screenBalance(db, e.userId) };
  }
  const now = e.now ?? new Date();
  const tz = await familyTz(db, e.familyId);
  const today = todayIn(tz, now);
  if (e.delta < 0) await expireLots(db, e.familyId, e.userId, now); // lo vencido no se puede gastar
  const bal = await screenBalance(db, e.userId);
  const applied = e.delta < 0 ? 0 - Math.min(-e.delta, bal) : e.delta; // «0 -» evita un -0
  const id = await insertLedger(db, { ...e, delta: applied });

  if (applied > 0) {
    const isPlan = e.kind === 'plan';
    if (isPlan && !e.planWeek) throw badRequest('Falta la semana del plan');
    // Los lotes no caducan durante una pausa: se les suman los días de pausa que quedan.
    const pause = await activePause(db, e.userId, today);
    const ext = pause ? Math.max(0, diffDays(pause.pause_ends_on, today)) : 0;
    const day = addDays(isPlan ? planExpiryDay(e.planWeek!) : earnedExpiryDay(today), ext);
    await db.query(
      `INSERT INTO screen_lots(family_id, user_id, source, amount, remaining, expires_at, plan_week, ledger_id, ext_pause_id, ext_days)
       VALUES ($1,$2,$3,$4,$4,$5,$6,$7,$8,$9)`,
      [e.familyId, e.userId, isPlan ? 'plan' : e.kind === 'refund' ? 'refund' : 'earned', applied, midnightAt(day, tz), isPlan ? e.planWeek : null, id, pause?.id ?? null, ext],
    );
  } else if (applied < 0) {
    await reconcileLots(db, e.familyId, e.userId, bal, today, tz);
    let left = -applied;
    const lots = await many<{ id: string; remaining: number }>(
      db, `SELECT id, remaining FROM screen_lots WHERE user_id = $1 AND remaining > 0 ORDER BY expires_at, created_at, id FOR UPDATE`, [e.userId],
    );
    for (const l of lots) {
      if (left <= 0) break;
      const take = Math.min(l.remaining, left);
      await db.query('UPDATE screen_lots SET remaining = remaining - $2 WHERE id = $1', [l.id, take]);
      left -= take;
    }
  }
  return { id, applied, requested: e.delta, duplicate: false, balance: bal + applied };
}

/** Crédito del plan semanal de una familia (idempotente por hijo y semana; se repite sin riesgo y se pone al día tras una parada). */
export async function runScreenPlans(db: Db, familyId: string, now = new Date(), onlyUserId?: string) {
  const tz = await familyTz(db, familyId);
  const week = startOfWeek(todayIn(tz, now));
  const plans = await many<{ user_id: string; minutes_per_week: number }>(
    db,
    `SELECT p.user_id, p.minutes_per_week FROM screen_plans p JOIN users u ON u.id = p.user_id
      WHERE p.family_id = $1 AND p.enabled AND p.minutes_per_week > 0 AND u.active AND u.role = 'child' AND ($2::uuid IS NULL OR p.user_id = $2)`,
    [familyId, onlyUserId ?? null],
  );
  let credited = 0;
  for (const p of plans) {
    // Una transacción por hijo: si uno falla, los demás reciben su plan igualmente.
    const r = await tx((t) => addScreen(t, {
      familyId, userId: p.user_id, delta: p.minutes_per_week, kind: 'plan', planWeek: week, note: 'Plan de la semana', now,
      idempotencyKey: `plan:${p.user_id}:${week}`,
    }));
    if (!r.duplicate) credited++;
  }
  return credited;
}

/** Caducidad de todos los hijos de la familia (para la tarea periódica). */
export async function runScreenExpiry(db: Db, familyId: string, now = new Date()) {
  const kids = await many<{ user_id: string }>(db, `SELECT DISTINCT user_id FROM screen_lots WHERE family_id = $1 AND remaining > 0 AND expires_at <= $2`, [familyId, now]);
  let n = 0;
  for (const k of kids) {
    n += await tx(async (t) => {
      await lockUser(t, k.user_id);
      return expireLots(t, familyId, k.user_id, now);
    });
  }
  return n;
}

/** Desplaza la caducidad de los lotes con minutos `days` días de calendario de la familia (positivo o negativo). */
export async function shiftLots(db: Db, familyId: string, userId: string, days: number, pauseId: string, mode: 'extend' | 'shrink') {
  if (days === 0) return;
  const tz = await familyTz(db, familyId);
  if (mode === 'extend') {
    await db.query(
      `UPDATE screen_lots SET expires_at = ((expires_at AT TIME ZONE $3) + make_interval(days => $2::int)) AT TIME ZONE $3, ext_pause_id = $4, ext_days = $2::int
        WHERE user_id = $1 AND remaining > 0`,
      [userId, days, tz, pauseId],
    );
  } else {
    // Solo se devuelve lo que esa pausa había alargado.
    await db.query(
      `UPDATE screen_lots SET expires_at = ((expires_at AT TIME ZONE $3) - make_interval(days => LEAST($2::int, ext_days))) AT TIME ZONE $3, ext_days = ext_days - LEAST($2::int, ext_days)
        WHERE user_id = $1 AND remaining > 0 AND ext_pause_id = $4`,
      [userId, days, tz, pauseId],
    );
  }
}

/** Desglose del saldo para el hijo: plan de la semana y ganados (con su primera caducidad). */
export async function screenBuckets(db: Db, userId: string) {
  const rows = await many<{ source: string; remaining: number; expires_at: Date }>(
    db, `SELECT source, remaining, expires_at FROM screen_lots WHERE user_id = $1 AND remaining > 0 ORDER BY expires_at`, [userId],
  );
  const sum = (f: (s: string) => boolean) => rows.filter((r) => f(r.source)).reduce((s, r) => s + r.remaining, 0);
  const first = (f: (s: string) => boolean) => rows.find((r) => f(r.source))?.expires_at ?? null;
  const isPlan = (s: string) => s === 'plan';
  const isEarned = (s: string) => s !== 'plan';
  return {
    plan: { minutes: sum(isPlan), expires_at: first(isPlan) },
    earned: { minutes: sum(isEarned), first_expires_at: first(isEarned) },
  };
}
