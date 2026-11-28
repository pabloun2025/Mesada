import { many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { addDays, isoWeekday, startOfWeek, todayIn } from './dates.js';
import { getFamily, type Family } from './family.js';
import { addMoney, addPoints, lockUser, moneyBalance, pointsBalance } from './ledger.js';
import { activePause, addScreen, endLapsedPauses, expireLots, midnightAt, screenBalance, screenBuckets, SCREEN_CATEGORIES, type ScreenCategory } from './screen.js';
import { hhmmToMinutes, localMinutes } from './notify/time.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { fmtMoney } from './currency.js';
import { removePhotoFile } from './photos.js';

/** I21: sesiones de pantalla (el temporizador vive en el servidor), días de uso, castigos con retos y tiempo extra. */

export const MAX_SESSION_MINUTES = 720;
/** Aviso previo al final de la sesión. */
export const WARN_MINUTES = 5;
/** Días de antelación del aviso de minutos ganados que caducan. */
export const EXPIRY_WARN_DAYS = 3;
/** Tiempo máximo para anotar «me pasé» tras acabar una sesión, y minutos máximos por sesión. */
const OVERRUN_WINDOW_MS = 12 * 3600_000;
const OVERRUN_MAX = 240;

const WEEKDAYS = ['', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];
const hhmm = (t: string | null | undefined) => String(t ?? '').slice(0, 5);

/** «hoy», «mañana», «el jueves» o «el 3 de diciembre», según lo lejos que esté `day`. */
export function dayWord(day: string, today: string): string {
  const n = Math.round((Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86400000);
  if (n <= 0) return 'hoy';
  if (n === 1) return 'mañana';
  const d = new Date(`${day}T12:00:00Z`);
  if (n < 7) return `el ${new Intl.DateTimeFormat('es-ES', { weekday: 'long', timeZone: 'UTC' }).format(d)}`;
  return `el ${new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d)}`;
}

const clockAt = (d: Date, tz: string) => new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).format(d);

/* ---------- Reglas del plan: días de uso, topes y aprobación ---------- */

export interface Rules { allowedDays: number[]; dayMax: Record<string, number>; requireApproval: boolean }

export async function getRules(db: Db, userId: string): Promise<Rules> {
  const r = await one<{ allowed_days: number[]; day_max: Record<string, number>; require_approval: boolean }>(
    db, 'SELECT allowed_days, day_max, require_approval FROM screen_plans WHERE user_id = $1', [userId],
  );
  return { allowedDays: r?.allowed_days ?? [1, 2, 3, 4, 5, 6, 7], dayMax: r?.day_max ?? {}, requireApproval: r?.require_approval ?? false };
}

/** «lun, mar y mié» para explicar los días permitidos. */
export function daysPhrase(days: number[]): string {
  const names = [...days].sort((a, b) => a - b).map((d) => WEEKDAYS[d].slice(0, 3));
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0] ?? 'ninguno';
}

/* ---------- Castigos (bloqueos) ---------- */

interface BlockRow {
  id: string; user_id: string; kind: 'days' | 'window'; reason: string; starts_on: string; ends_on: string; window_start: string | null; window_end: string | null;
  status: 'active' | 'lifted'; challenge_text: string | null; challenge_photo: boolean; challenge_effect: 'lift' | 'shorten' | null; challenge_days: number | null;
  challenge_status: 'open' | 'submitted' | 'approved' | 'rejected' | null; challenge_note: string; challenge_photo_path: string | null; challenge_done_at: Date | null;
  created_at: Date; lifted_at: Date | null;
}

function blockLabel(b: BlockRow, today: string) {
  const until = b.ends_on <= today ? 'hoy' : dayWord(b.ends_on, today);
  if (b.kind === 'days') return b.ends_on <= today ? 'Sin pantalla hoy' : `Sin pantalla hasta ${until} (incluido)`;
  return `Sin pantalla de ${hhmm(b.window_start)} a ${hhmm(b.window_end)}${b.ends_on <= today ? ' hoy' : ` hasta ${until}`}`;
}

/** Castigos de un hijo con su estado y si bloquean ahora. */
export async function listBlocks(db: Db, userId: string, tz: string, now = new Date(), opts: { all?: boolean } = {}) {
  const today = todayIn(tz, now);
  const nowMin = localMinutes(now, tz);
  const rows = await many<BlockRow>(db, 'SELECT * FROM screen_blocks WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [userId]);
  return rows
    .map((b) => {
      const state = b.status === 'lifted' ? 'lifted' : b.ends_on < today ? 'ended' : 'active';
      const inRange = state === 'active' && b.starts_on <= today;
      let blockedNow = false;
      let untilMin: number | null = null; // minutos hasta que empiece la franja de hoy
      if (inRange) {
        if (b.kind === 'days') blockedNow = true;
        else {
          const s = hhmmToMinutes(hhmm(b.window_start));
          const e = hhmmToMinutes(hhmm(b.window_end));
          blockedNow = nowMin >= s && nowMin < e;
          if (nowMin < s) untilMin = s - nowMin;
        }
      }
      return {
        id: b.id, kind: b.kind, reason: b.reason, starts_on: b.starts_on, ends_on: b.ends_on, window_start: hhmm(b.window_start) || null, window_end: hhmm(b.window_end) || null,
        state, label: blockLabel(b, today), blocked_now: blockedNow, until_window_min: untilMin,
        challenge: b.challenge_text ? {
          text: b.challenge_text, photo_required: b.challenge_photo, effect: b.challenge_effect, days: b.challenge_days, status: b.challenge_status, note: b.challenge_note,
          has_photo: !!b.challenge_photo_path, done_at: b.challenge_done_at,
        } : null,
        created_at: b.created_at, lifted_at: b.lifted_at,
      };
    })
    .filter((b) => opts.all || b.state === 'active' || (new Date(b.created_at).getTime() > now.getTime() - 14 * 86400000));
}

/* ---------- Acceso: ¿puede empezar ahora? ---------- */

async function sessionMinutesToday(db: Db, userId: string, today: string) {
  return (await one<{ plan: number; total: number }>(db,
    `SELECT COALESCE(SUM(used_minutes) FILTER (WHERE NOT extra),0)::int AS plan,
            COALESCE(SUM(used_minutes + overrun_minutes),0)::int AS total
       FROM screen_sessions WHERE user_id = $1 AND day = $2 AND status = 'finished'`, [userId, today],
  ))!;
}

async function openSession(db: Db, userId: string) {
  return one<{ id: string; status: string }>(db, `SELECT id, status FROM screen_sessions WHERE user_id = $1 AND kind = 'timer' AND status IN ('pending','running')`, [userId]);
}

export interface Access {
  today: string; allowedDay: boolean; cap: number | null; usedToday: number; totalSessionMinutes: number; capLeft: number | null;
  blockNow: { label: string; reason: string } | null; untilBlockMin: number | null; pause: { label: string } | null; balance: number; open: boolean; rules: Rules;
}

export async function accessFor(db: Db, fam: Pick<Family, 'timezone' | 'id'>, userId: string, now: Date): Promise<Access> {
  const today = todayIn(fam.timezone, now);
  const rules = await getRules(db, userId);
  await endLapsedPauses(db, userId, today);
  const pause = await activePause(db, userId, today);
  const blocks = await listBlocks(db, userId, fam.timezone, now, { all: true });
  const blocking = blocks.find((b) => b.blocked_now);
  const upcoming = blocks.filter((b) => b.until_window_min != null).map((b) => b.until_window_min!);
  const dow = isoWeekday(today);
  const cap = rules.dayMax[String(dow)] ?? null;
  const minutes = await sessionMinutesToday(db, userId, today);
  return {
    today, rules, allowedDay: rules.allowedDays.includes(dow), cap, usedToday: minutes.plan, totalSessionMinutes: minutes.total,
    capLeft: cap == null ? null : Math.max(0, cap - minutes.plan),
    blockNow: blocking ? { label: blocking.label, reason: blocking.reason } : null,
    untilBlockMin: upcoming.length ? Math.min(...upcoming) : null,
    pause: pause ? { label: `Pausa hasta ${dayWord(pause.pause_ends_on, today)}` } : null,
    balance: await screenBalance(db, userId), open: !!(await openSession(db, userId)),
  };
}

/** ¿Puede empezar? `own` = el propio hijo sin tiempo extra (aplican días y topes); si no, solo bloqueos y pausa. */
export function canStart(a: Access, own: boolean): { ok: boolean; code: string | null; reason: string; maxMinutes: number } {
  const fail = (code: string, reason: string) => ({ ok: false, code, reason, maxMinutes: 0 });
  if (a.open) return fail('open', 'Ya hay una sesión de pantalla abierta.');
  if (a.pause) return fail('paused', `${a.pause.label}: ahora no se puede usar la pantalla.`);
  if (a.blockNow) return fail('blocked', `${a.blockNow.label}. Motivo: ${a.blockNow.reason}.`);
  let max: number = MAX_SESSION_MINUTES;
  if (own) {
    if (!a.allowedDay) return fail('day', `Hoy no toca pantalla. Tus días: ${daysPhrase(a.rules.allowedDays)}.`);
    if (a.capLeft === 0) return fail('cap', `Hoy ya has usado tus ${a.cap} min de pantalla.`);
    if (a.balance <= 0) return fail('no_balance', 'No te quedan minutos de pantalla.');
    max = Math.min(max, a.balance);
    if (a.capLeft != null) max = Math.min(max, a.capLeft);
  }
  if (a.untilBlockMin != null) max = Math.min(max, a.untilBlockMin);
  if (max < 1) return fail('window', 'Enseguida empieza un descanso de pantalla.');
  return { ok: true, code: null, reason: '', maxMinutes: max };
}

/* ---------- Tasa del tiempo extra pagado con puntos o dinero ---------- */

export async function getRates(db: Db, familyId: string) {
  const f = await one<{ screen_points_per_15: number; screen_cents_per_15: number }>(db, 'SELECT screen_points_per_15, screen_cents_per_15 FROM families WHERE id = $1', [familyId]);
  return { pointsPer15: f!.screen_points_per_15, centsPer15: f!.screen_cents_per_15 };
}

/** Lo que cuestan `minutes` minutos a razón de `per15` por cada 15 min (se redondea hacia arriba). */
export const costFor = (minutes: number, per15: number) => Math.ceil((minutes * per15) / 15);
/** Cuántos minutos se pueden pagar con `balance` a esa razón. */
export const affordableMinutes = (balance: number, per15: number) => Math.floor((Math.max(0, balance) * 15) / per15);

/* ---------- Sesiones ---------- */

interface SessionRow {
  id: string; family_id: string; user_id: string; kind: 'timer' | 'charge'; status: string; category: ScreenCategory | null; note: string; requested_minutes: number;
  extended_minutes: number; day: string; extra: boolean; started_at: Date | null; planned_end_at: Date | null; ended_at: Date | null; shortfall_mode: 'debt' | 'points' | 'money';
  warned_at: Date | null; started_by: string | null; overrun_minutes: number; used_minutes: number;
}

const totalMinutes = (s: Pick<SessionRow, 'requested_minutes' | 'extended_minutes'>) => s.requested_minutes + s.extended_minutes;
const what = (s: Pick<SessionRow, 'note'>) => (s.note ? ` (${s.note})` : '');

/** Cierra la sesión: descuenta lo usado de las baterías y, si no llega, cobra la diferencia como eligió el adulto. */
async function settle(db: Db, s: SessionRow, used: number, now: Date, o: { endReason: 'stopped' | 'expired' | 'charge' | 'blocked'; endedAt?: Date; actorId: string | null }) {
  const rates = await getRates(db, s.family_id);
  let applied = 0;
  if (used > 0) {
    const r = await addScreen(db, {
      familyId: s.family_id, userId: s.user_id, delta: -used, kind: 'session', refId: s.id, note: s.note ? `Pantalla: ${s.note}` : 'Sesión de pantalla',
      createdBy: o.actorId, category: s.category, idempotencyKey: `session:${s.id}`, now,
    });
    applied = -r.applied;
  }
  const shortfall = used - applied;
  let paidPoints = 0, paidCents = 0, debtMin = 0;
  if (shortfall > 0) {
    debtMin = shortfall;
    const label = `Pantalla extra: ${shortfall} min${what(s)}`;
    if (s.shortfall_mode === 'points') {
      const mins = Math.min(shortfall, affordableMinutes(await pointsBalance(db, s.user_id), rates.pointsPer15));
      if (mins > 0) {
        paidPoints = costFor(mins, rates.pointsPer15);
        await addPoints(db, { familyId: s.family_id, userId: s.user_id, delta: -paidPoints, kind: 'adjustment', refId: s.id, note: label, createdBy: o.actorId, idempotencyKey: `session-pts:${s.id}` });
        debtMin = shortfall - mins;
      }
    } else if (s.shortfall_mode === 'money') {
      const mins = Math.min(shortfall, affordableMinutes(await moneyBalance(db, s.user_id), rates.centsPer15));
      if (mins > 0) {
        paidCents = costFor(mins, rates.centsPer15);
        await addMoney(db, { familyId: s.family_id, userId: s.user_id, deltaCents: -paidCents, kind: 'adjustment', refId: s.id, note: label, createdBy: o.actorId, idempotencyKey: `session-eur:${s.id}` });
        debtMin = shortfall - mins;
      }
    }
    if (debtMin > 0) {
      await db.query(`INSERT INTO screen_debts(family_id, user_id, session_id, minutes, remaining, reason) VALUES ($1,$2,$3,$4,$4,$5)`, [s.family_id, s.user_id, s.id, debtMin, `No llegaban los minutos: ${debtMin} min${what(s)}`]);
    }
  }
  const upd = await one(
    db,
    `UPDATE screen_sessions SET status = 'finished', ended_at = $2, end_reason = $3, used_minutes = $4, charged_minutes = $5, shortfall_minutes = $6, paid_points = $7, paid_cents = $8,
            stopped_by = $9 WHERE id = $1 RETURNING *`,
    [s.id, o.endedAt ?? now, o.endReason, used, applied, shortfall, paidPoints, paidCents, o.actorId],
  );
  return { session: upd, applied, shortfall, paidPoints, paidCents, debtMin };
}

const SESSION_SELECT = `SELECT s.*, u.display_name, u.avatar, u.color, sb.display_name AS started_by_name, st.display_name AS stopped_by_name
  FROM screen_sessions s JOIN users u ON u.id = s.user_id LEFT JOIN users sb ON sb.id = s.started_by LEFT JOIN users st ON st.id = s.stopped_by`;

async function loadSession(db: Db, familyId: string, id: string) {
  const s = await one<SessionRow>(db, 'SELECT * FROM screen_sessions WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, familyId]);
  if (!s) throw notFound('Sesión no encontrada');
  return s;
}

async function viewSession(db: Db, id: string) {
  return one(db, `${SESSION_SELECT} WHERE s.id = $1`, [id]);
}

async function childOf(db: Db, familyId: string, userId: string) {
  const c = await one<{ id: string; display_name: string }>(db, `SELECT id, display_name FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active`, [userId, familyId]);
  if (!c) throw notFound('Miembro no encontrado');
  return c;
}

/** Cierra las sesiones vencidas (nadie las paró) y avisa. Se llama desde el proceso periódico y al leer el estado. */
export async function closeDueSessions(db: Db, now = new Date(), userId?: string) {
  const due = await many<SessionRow>(
    db, `SELECT * FROM screen_sessions WHERE status = 'running' AND planned_end_at <= $1 AND ($2::uuid IS NULL OR user_id = $2) ORDER BY planned_end_at FOR UPDATE`, [now, userId ?? null],
  );
  for (const s of due) {
    await lockUser(db, s.user_id);
    const r = await settle(db, s, totalMinutes(s), now, { endReason: 'expired', endedAt: s.planned_end_at!, actorId: null });
    const kid = await one<{ display_name: string }>(db, 'SELECT display_name FROM users WHERE id = $1', [s.user_id]);
    await db.query('UPDATE screen_sessions SET end_notified_at = now() WHERE id = $1', [s.id]);
    await notify(db, { userId: s.user_id, event: 'screen_ended', title: 'Se acabó el tiempo de pantalla', body: `Han pasado tus ${totalMinutes(s)} min${what(s)}. Es hora de parar.`, link: '/pantalla', dedupeKey: `screen-end:${s.id}` });
    await notifyAdults(db, s.family_id, { event: 'screen_ended', title: `A ${kid?.display_name} se le acabó el tiempo de pantalla`, body: `${totalMinutes(s)} min${what(s)}.${r.debtMin ? ` No llegaban los minutos: ${r.debtMin} min a la semana siguiente.` : ''}`, link: `/pantalla?hijo=${s.user_id}`, dedupeKey: `screen-end:${s.id}` });
  }
  return due.length;
}

/** Aviso a los 5 minutos del final (una vez por sesión y ampliación). */
export async function warnSessions(db: Db, now = new Date()) {
  const rows = await many<SessionRow>(
    db,
    `SELECT * FROM screen_sessions WHERE status = 'running' AND warned_at IS NULL AND planned_end_at > $1 AND planned_end_at <= $1::timestamptz + make_interval(mins => $2) AND requested_minutes + extended_minutes > $2`,
    [now, WARN_MINUTES],
  );
  for (const s of rows) {
    await db.query('UPDATE screen_sessions SET warned_at = $2 WHERE id = $1', [s.id, now]);
    await notify(db, { userId: s.user_id, event: 'screen_warning', title: `Te quedan ${WARN_MINUTES} minutos de pantalla`, body: 'Ve cerrando lo que estás haciendo 😉', link: '/pantalla', dedupeKey: `screen-warn:${s.id}:${s.extended_minutes}` });
  }
  return rows.length;
}

/** «El lunes caducan 20 min: úsalos», 3 días antes (solo minutos ganados, no el plan semanal). */
export async function warnExpiringLots(db: Db, now = new Date()) {
  const rows = await many<{ user_id: string; family_id: string; expires_at: Date; m: number; tz: string }>(
    db,
    `SELECT l.user_id, l.family_id, l.expires_at, SUM(l.remaining)::int AS m, f.timezone AS tz
       FROM screen_lots l JOIN families f ON f.id = l.family_id JOIN users u ON u.id = l.user_id AND u.active
      WHERE l.source <> 'plan' AND l.remaining > 0 AND l.expires_at > $1 AND l.expires_at <= $1::timestamptz + make_interval(days => $2)
      GROUP BY l.user_id, l.family_id, l.expires_at, f.timezone`,
    [now, EXPIRY_WARN_DAYS],
  );
  for (const r of rows) {
    const when = dayWord(todayIn(r.tz, r.expires_at), todayIn(r.tz, now));
    await notify(db, {
      userId: r.user_id, event: 'screen_expiring', title: `${when === 'hoy' ? 'Hoy' : when === 'mañana' ? 'Mañana' : `${when[0].toUpperCase()}${when.slice(1)}`} caducan ${r.m} min: úsalos`,
      body: 'Son minutos que ganaste con tus tareas. Si no los usas, se pierden.', link: '/pantalla', dedupeKey: `lotexp:${r.user_id}:${r.expires_at.toISOString()}`,
    });
  }
  return rows.length;
}

/** Todo lo periódico de pantalla, para el proceso del servidor (cada 30 s): cierra vencidas, avisa y avisa de caducidades. */
export async function runScreenSessions(db: Db, now = new Date()) {
  const closed = await tx((t) => closeDueSessions(t, now));
  const warned = await tx((t) => warnSessions(t, now));
  const expiring = await tx((t) => warnExpiringLots(t, now));
  return { closed, warned, expiring };
}

/* ---------- Empezar, parar, ampliar ---------- */

export interface StartInput {
  userId?: string; minutes: number; category?: ScreenCategory | null; note?: string; extra?: boolean;
  /** Solo un adulto: «solo descontar» (sin temporizador). */
  mode?: 'start' | 'charge';
  /** Qué hacer si las baterías no llegan: deuda (semana siguiente), puntos o dinero. */
  payWith?: 'debt' | 'points' | 'money';
  idempotencyKey?: string;
}

export async function startSession(actor: AuthUser, p: StartInput, opts: { now?: Date } = {}) {
  const isChild = actor.role === 'child';
  if (actor.role === 'adult' && actor.isRelative) throw forbidden();
  const userId = isChild ? actor.id : p.userId;
  if (!userId) throw badRequest('Falta el hijo');
  if (!Number.isInteger(p.minutes) || p.minutes < 1 || p.minutes > MAX_SESSION_MINUTES) throw badRequest(`Los minutos deben estar entre 1 y ${MAX_SESSION_MINUTES}`);
  if (p.category && !SCREEN_CATEGORIES.includes(p.category)) throw badRequest('Categoría no válida');
  if (isChild && p.mode === 'charge') throw forbidden('Solo un adulto puede dar minutos directamente. Pide tiempo extra.');
  // «Dar minutos» (un adulto) y «Pedir tiempo extra» (el hijo, con aprobación) descuentan al instante y no llevan temporizador.
  const mode = p.mode ?? 'start';
  const charge = mode === 'charge' || (isChild && !!p.extra);
  const note = p.note?.trim() ?? '';
  return tx(async (db) => {
    const now = opts.now ?? new Date();
    const kid = await childOf(db, actor.familyId, userId);
    const fam = await getFamily(db, actor.familyId);
    await lockUser(db, userId);
    const idem = p.idempotencyKey ? `${userId}:${p.idempotencyKey}` : null;
    if (idem) {
      const dup = await one(db, 'SELECT id FROM screen_sessions WHERE idempotency_key = $1', [idem]);
      if (dup) return { session: await viewSession(db, dup.id), duplicate: true };
    }
    await closeDueSessions(db, now, userId);
    await expireLots(db, actor.familyId, userId, now);
    const access = await accessFor(db, fam, userId, now);
    // Un adulto (o el tiempo extra aprobado) puede ir más allá de los días y topes del plan, pero nunca de un bloqueo.
    const bypassPlan = !isChild || !!p.extra;
    // Un descuento manual registra uso pasado. Los clientes anteriores lo registraban siempre como extra.
    const extra = mode === 'charge' ? p.extra !== false : bypassPlan;
    // Dar minutos registra algo que ya pasó o se concede: un adulto no tiene más límite que el de no estar repetido.
    // El hijo que pide tiempo extra no puede hacerlo bloqueado o en pausa, pero sí fuera de sus días y topes.
    const pendingCharge = charge && isChild ? await one(db, `SELECT 1 FROM screen_sessions WHERE user_id = $1 AND kind = 'charge' AND status = 'pending'`, [userId]) : null;
    if (pendingCharge) throw conflict('Ya tienes una petición de tiempo extra esperando. Espera a que la resuelvan o cancélala.', 'already_pending');
    const can = mode === 'charge' ? { ok: true, code: null, reason: '', maxMinutes: MAX_SESSION_MINUTES } : charge ? canStart({ ...access, open: false }, false) : canStart(access, !bypassPlan);
    if (!can.ok) throw conflict(can.reason, can.code ?? 'blocked');
    if (!bypassPlan && p.minutes > can.maxMinutes) {
      throw conflict(access.capLeft != null && can.maxMinutes === access.capLeft ? `Hoy solo te quedan ${can.maxMinutes} min según tu plan.` : `Ahora puedes usar como mucho ${can.maxMinutes} min.`, 'too_long');
    }
    if (bypassPlan && !charge && access.untilBlockMin != null && p.minutes > access.untilBlockMin) throw conflict(`Enseguida empieza un descanso: solo caben ${access.untilBlockMin} min.`, 'too_long');

    // Lo que las baterías no cubren y cómo se paga.
    const short = bypassPlan ? Math.max(0, p.minutes - access.balance) : 0;
    let payWith = p.payWith ?? 'debt';
    if (short > 0) {
      if (isChild && payWith === 'debt') throw badRequest('Elige cómo pagas los minutos que te faltan: puntos o dinero', 'choose_payment');
      const rates = await getRates(db, actor.familyId);
      if (payWith === 'points' && costFor(short, rates.pointsPer15) > (await pointsBalance(db, userId))) throw conflict(`No hay puntos suficientes: ${short} min cuestan ${costFor(short, rates.pointsPer15)} puntos.`, 'insufficient_funds');
      if (payWith === 'money' && costFor(short, rates.centsPer15) > (await moneyBalance(db, userId))) throw conflict(`No hay dinero suficiente: ${short} min cuestan ${fmtMoney(costFor(short, rates.centsPer15), fam.currency)}.`, 'insufficient_funds');
    } else payWith = 'debt';

    const needsApproval = isChild && (access.rules.requireApproval || !!p.extra);
    const status = needsApproval ? 'pending' : 'running';
    const kindCol = charge ? 'charge' : 'timer';
    const startedAt = status === 'running' ? now : null;
    const end = status === 'running' ? new Date(now.getTime() + p.minutes * 60_000) : null;
    const ins = await one<{ id: string }>(
      db,
      `INSERT INTO screen_sessions(family_id, user_id, kind, status, category, note, requested_minutes, day, extra, started_at, planned_end_at, started_by, shortfall_mode, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [actor.familyId, userId, kindCol, status, p.category ?? null, note, p.minutes, access.today, extra, charge ? (needsApproval ? null : now) : startedAt, charge ? (needsApproval ? null : now) : end, actor.id, payWith, idem],
    );
    const id = ins!.id;
    await audit(db, actor.familyId, actor.id, needsApproval ? 'screen_session.request' : charge ? 'screen_session.charge' : 'screen_session.start', 'screen_session', id, { for: userId, minutes: p.minutes, extra, payWith, note });

    if (needsApproval) {
      await notifyAdults(db, actor.familyId, {
        event: 'screen_request',
        title: charge ? `${kid.display_name} pide ${p.minutes} min de tiempo extra${what({ note })}` : `${kid.display_name} pide usar ${p.minutes} min de pantalla${what({ note })}`,
        body: charge ? (short > 0 ? `Le faltan ${short} min: los paga con ${payWith === 'points' ? 'puntos' : 'dinero'}. Al aprobar se descuentan al momento.` : 'Al aprobar se le descuentan al momento de su saldo.') : 'Apruébalo para que empiece el temporizador.', link: '/validar', dedupeKey: `screen-req:${id}`,
      });
    } else if (charge) {
      const s = (await one<SessionRow>(db, 'SELECT * FROM screen_sessions WHERE id = $1 FOR UPDATE', [id]))!;
      const r = await settle(db, s, p.minutes, now, { endReason: 'charge', actorId: actor.id });
      await notify(db, {
        userId, event: 'screen_parent_started', title: `${actor.displayName} te ha dado ${p.minutes} min de pantalla${what({ note })}`,
        body: r.paidPoints ? `Pagados con ${r.paidPoints} puntos.` : r.paidCents ? `Pagados con ${fmtMoney(r.paidCents, fam.currency)}.` : r.debtMin ? `Faltaban ${r.debtMin} min: se descuentan de la semana siguiente.` : '', link: '/pantalla', dedupeKey: `screen-charge:${id}`,
      });
    } else if (isChild) {
      await notifyAdults(db, actor.familyId, { event: 'screen_started', title: `${kid.display_name} ha empezado su pantalla`, body: `${p.minutes} min${what({ note })} · termina a las ${clockAt(end!, fam.timezone)}.`, link: `/pantalla?hijo=${userId}`, dedupeKey: `screen-start:${id}` });
    } else {
      await notify(db, { userId, event: 'screen_parent_started', title: `${actor.displayName} ha puesto en marcha tu pantalla`, body: `${p.minutes} min${what({ note })} · termina a las ${clockAt(end!, fam.timezone)}.`, link: '/pantalla', dedupeKey: `screen-start:${id}` });
    }
    return { session: await viewSession(db, id), duplicate: false };
  });
}

export async function stopSession(actor: AuthUser, id: string, opts: { now?: Date } = {}) {
  return tx(async (db) => {
    const now = opts.now ?? new Date();
    const s = await loadSession(db, actor.familyId, id);
    if (actor.role === 'child' && s.user_id !== actor.id) throw forbidden();
    if (actor.role === 'adult' && actor.isRelative) throw forbidden();
    if (s.status === 'finished') return { session: await viewSession(db, id), duplicate: true };
    if (s.status !== 'running') throw conflict('Esta sesión no está en marcha', 'not_running');
    await lockUser(db, s.user_id);
    const total = totalMinutes(s);
    const elapsed = now.getTime() - s.started_at!.getTime();
    const late = now >= s.planned_end_at!;
    // Se cobra lo usado de verdad, redondeado hacia arriba con 15 s de margen y un mínimo de 1 min.
    const used = late ? total : Math.min(total, Math.max(1, Math.ceil((elapsed - 15_000) / 60_000)));
    const r = await settle(db, s, used, now, { endReason: late ? 'expired' : 'stopped', endedAt: late ? s.planned_end_at! : now, actorId: actor.id });
    const kid = (await one<{ display_name: string }>(db, 'SELECT display_name FROM users WHERE id = $1', [s.user_id]))!;
    const left = await screenBalance(db, s.user_id);
    await audit(db, actor.familyId, actor.id, 'screen_session.stop', 'screen_session', id, { for: s.user_id, used, shortfall: r.shortfall });
    if (actor.role === 'child') {
      await notifyAdults(db, actor.familyId, { event: 'screen_stopped', title: `${kid.display_name} ha parado su pantalla`, body: `Usó ${used} min${what(s)}. Le quedan ${left} min.`, link: `/pantalla?hijo=${s.user_id}`, dedupeKey: `screen-stop:${id}` });
    } else {
      await notify(db, { userId: s.user_id, event: 'screen_stopped', title: `${actor.displayName} ha parado tu pantalla`, body: `Has usado ${used} min${what(s)}. Te quedan ${left} min.`, link: '/pantalla', dedupeKey: `screen-stop:${id}` });
    }
    return { session: await viewSession(db, id), duplicate: false, used };
  });
}

/** Un adulto da más tiempo a una sesión en marcha (se cobra igual que el resto). */
export async function extendSession(adult: AuthUser, id: string, minutes: number, opts: { now?: Date } = {}) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240) throw badRequest('Puedes ampliar entre 1 y 240 minutos');
  return tx(async (db) => {
    const s = await loadSession(db, adult.familyId, id);
    if (s.status !== 'running') throw conflict('Esta sesión no está en marcha', 'not_running');
    if (totalMinutes(s) + minutes > MAX_SESSION_MINUTES) throw badRequest('La sesión sería demasiado larga');
    const fam = await getFamily(db, adult.familyId);
    const end = new Date(s.planned_end_at!.getTime() + minutes * 60_000);
    await db.query('UPDATE screen_sessions SET extended_minutes = extended_minutes + $2, planned_end_at = $3, warned_at = NULL WHERE id = $1', [id, minutes, end]);
    await audit(db, adult.familyId, adult.id, 'screen_session.extend', 'screen_session', id, { for: s.user_id, minutes });
    await notify(db, { userId: s.user_id, event: 'screen_parent_started', title: `${adult.displayName} te da ${minutes} min más`, body: `Ahora termina a las ${clockAt(end, fam.timezone)}.`, link: '/pantalla', dedupeKey: `screen-ext:${id}:${s.extended_minutes}` });
    return { session: await viewSession(db, id) };
  });
}

export async function approveSession(adult: AuthUser, id: string, opts: { now?: Date } = {}) {
  return tx(async (db) => {
    const now = opts.now ?? new Date();
    const s = await loadSession(db, adult.familyId, id);
    if (s.status === 'running' || s.status === 'finished') return { session: await viewSession(db, id), duplicate: true };
    if (s.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    await lockUser(db, s.user_id);
    const fam = await getFamily(db, adult.familyId);
    await expireLots(db, adult.familyId, s.user_id, now);
    const a = await accessFor(db, fam, s.user_id, now);
    // La propia petición es la sesión abierta. El plan puede haber cambiado mientras esperaba.
    const ordinary = s.kind === 'timer' && !s.extra;
    const can = canStart({ ...a, open: false }, ordinary);
    if (!can.ok) throw conflict(can.reason, can.code ?? 'blocked');
    if (ordinary && s.requested_minutes > can.maxMinutes) {
      throw conflict(a.capLeft === can.maxMinutes ? `Hoy solo te quedan ${can.maxMinutes} min según tu plan.` : `Ahora puedes usar como mucho ${can.maxMinutes} min.`, 'too_long');
    }
    if (a.untilBlockMin != null && s.requested_minutes > a.untilBlockMin) throw conflict(`Enseguida empieza un descanso: solo caben ${a.untilBlockMin} min.`, 'too_long');
    if (s.kind === 'charge') {
      // Tiempo extra: se descuenta al aprobarlo, sin temporizador.
      await db.query(`UPDATE screen_sessions SET started_at = $2, planned_end_at = $2, decided_by = $3, decided_at = $2, day = $4 WHERE id = $1`, [id, now, adult.id, a.today]);
      const r = await settle(db, { ...s, started_at: now, planned_end_at: now, day: a.today }, s.requested_minutes, now, { endReason: 'charge', actorId: adult.id });
      await audit(db, adult.familyId, adult.id, 'screen_session.approve', 'screen_session', id, { for: s.user_id, minutes: s.requested_minutes, extra: true });
      await notify(db, {
        userId: s.user_id, event: 'screen_decided', title: `${adult.displayName} te ha dado ${s.requested_minutes} min de pantalla${what(s)}`,
        body: r.paidPoints ? `Los has pagado con ${r.paidPoints} puntos.` : r.paidCents ? `Los has pagado con ${fmtMoney(r.paidCents, fam.currency)}.` : r.debtMin ? `Faltaban ${r.debtMin} min: se descuentan de la semana siguiente.` : `Te quedan ${await screenBalance(db, s.user_id)} min.`,
        link: '/pantalla', dedupeKey: `screen-approved:${id}`,
      });
      return { session: await viewSession(db, id), duplicate: false };
    }
    const end = new Date(now.getTime() + s.requested_minutes * 60_000);
    await db.query(`UPDATE screen_sessions SET status = 'running', started_at = $2, planned_end_at = $3, decided_by = $4, decided_at = $2, day = $5 WHERE id = $1`, [id, now, end, adult.id, a.today]);
    await audit(db, adult.familyId, adult.id, 'screen_session.approve', 'screen_session', id, { for: s.user_id, minutes: s.requested_minutes });
    await notify(db, { userId: s.user_id, event: 'screen_decided', title: `${adult.displayName} ha aprobado tu pantalla`, body: `${s.requested_minutes} min${what(s)} · termina a las ${clockAt(end, fam.timezone)}.`, link: '/pantalla', dedupeKey: `screen-approved:${id}` });
    return { session: await viewSession(db, id), duplicate: false };
  });
}

export async function rejectSession(adult: AuthUser, id: string, note = '') {
  return tx(async (db) => {
    const s = await loadSession(db, adult.familyId, id);
    if (s.status === 'rejected') return { session: await viewSession(db, id), duplicate: true };
    if (s.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    await db.query(`UPDATE screen_sessions SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3 WHERE id = $1`, [id, adult.id, note.trim()]);
    await audit(db, adult.familyId, adult.id, 'screen_session.reject', 'screen_session', id, { for: s.user_id, note });
    await notify(db, { userId: s.user_id, event: 'screen_decided', title: `${adult.displayName} no ha aceptado tu petición de pantalla`, body: note.trim(), link: '/pantalla', dedupeKey: `screen-rejected:${id}` });
    return { session: await viewSession(db, id), duplicate: false };
  });
}

export async function cancelSession(child: AuthUser, id: string) {
  return tx(async (db) => {
    const s = await loadSession(db, child.familyId, id);
    if (s.user_id !== child.id) throw forbidden();
    if (s.status === 'cancelled') return { session: await viewSession(db, id), duplicate: true };
    if (s.status !== 'pending') throw conflict('Esta petición ya está resuelta', 'already_decided');
    await db.query(`UPDATE screen_sessions SET status = 'cancelled', ended_at = now() WHERE id = $1`, [id]);
    return { session: await viewSession(db, id), duplicate: false };
  });
}

/** «Me pasé»: minutos usados de más tras acabar la sesión. No se cobran ya: se descuentan de la semana siguiente. */
export async function addOverrun(actor: AuthUser, id: string, minutes: number, opts: { now?: Date } = {}) {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > OVERRUN_MAX) throw badRequest(`Indica entre 1 y ${OVERRUN_MAX} minutos`);
  if (actor.role === 'adult' && actor.isRelative) throw forbidden();
  return tx(async (db) => {
    const now = opts.now ?? new Date();
    const s = await loadSession(db, actor.familyId, id);
    if (actor.role === 'child' && s.user_id !== actor.id) throw forbidden();
    if (s.status !== 'finished' || s.kind !== 'timer' || !s.ended_at) throw conflict('Solo se puede anotar de más en una sesión terminada', 'not_finished');
    if (now.getTime() - s.ended_at.getTime() > OVERRUN_WINDOW_MS) throw conflict('Ya ha pasado demasiado tiempo para anotarlo', 'too_late');
    if (s.overrun_minutes + minutes > OVERRUN_MAX) throw conflict('Ya hay demasiados minutos anotados de más en esta sesión', 'too_many');
    const kid = (await one<{ display_name: string }>(db, 'SELECT display_name FROM users WHERE id = $1', [s.user_id]))!;
    await db.query(`INSERT INTO screen_debts(family_id, user_id, session_id, minutes, remaining, reason) VALUES ($1,$2,$3,$4,$4,$5)`, [s.family_id, s.user_id, id, minutes, `Te pasaste ${minutes} min${what(s)}`]);
    await db.query('UPDATE screen_sessions SET overrun_minutes = overrun_minutes + $2 WHERE id = $1', [id, minutes]);
    await audit(db, actor.familyId, actor.id, 'screen_session.overrun', 'screen_session', id, { for: s.user_id, minutes });
    const body = 'Se descuenta de la semana siguiente.';
    if (actor.role === 'child') await notifyAdults(db, actor.familyId, { event: 'screen_overrun', title: `${kid.display_name} se pasó ${minutes} min de pantalla`, body, link: `/pantalla?hijo=${s.user_id}`, dedupeKey: `screen-over:${id}:${s.overrun_minutes}` });
    else await notify(db, { userId: s.user_id, event: 'screen_overrun', title: `${actor.displayName} ha anotado ${minutes} min de más`, body, link: '/pantalla', dedupeKey: `screen-over:${id}:${s.overrun_minutes}` });
    return { session: await viewSession(db, id) };
  });
}

/** Descuenta el exceso de semanas anteriores: lo que se anotó antes del lunes de esta semana sale de lo que haya ahora (plan nuevo incluido). */
export async function runScreenDebts(db: Db, familyId: string, now = new Date()) {
  const fam = await getFamily(db, familyId);
  const monday = midnightAt(startOfWeek(todayIn(fam.timezone, now)), fam.timezone);
  const debts = await many<{ id: string; user_id: string; remaining: number; reason: string }>(
    db, `SELECT id, user_id, remaining, reason FROM screen_debts WHERE family_id = $1 AND remaining > 0 AND created_at < $2 ORDER BY created_at`, [familyId, monday],
  );
  let taken = 0;
  for (const d of debts) {
    taken += await tx(async (t) => {
      await lockUser(t, d.user_id);
      const cur = await one<{ remaining: number }>(t, 'SELECT remaining FROM screen_debts WHERE id = $1 FOR UPDATE', [d.id]);
      if (!cur || cur.remaining <= 0) return 0;
      const bal = await screenBalance(t, d.user_id);
      const take = Math.min(cur.remaining, bal);
      if (take <= 0) return 0;
      const r = await addScreen(t, { familyId, userId: d.user_id, delta: -take, kind: 'adjustment', note: `Pantalla de la semana pasada: ${take} min`, idempotencyKey: `debt:${d.id}:${cur.remaining}`, now });
      const got = -r.applied;
      await t.query('UPDATE screen_debts SET remaining = remaining - $2, settled_at = CASE WHEN remaining - $2 <= 0 THEN now() ELSE settled_at END WHERE id = $1', [d.id, got]);
      await notify(t, { userId: d.user_id, event: 'screen_overrun', title: `Se descuentan ${got} min de pantalla`, body: `${d.reason}. Es de la semana pasada.`, link: '/pantalla', dedupeKey: `debt:${d.id}:${cur.remaining}` });
      return got;
    });
  }
  return taken;
}

/* ---------- Castigos ---------- */

export interface NewBlock {
  userId: string; kind: 'days' | 'window'; reason: string; endsOn: string; windowStart?: string; windowEnd?: string;
  challenge?: { text: string; photo?: boolean; effect: 'lift' | 'shorten'; days?: number } | null;
}

export async function createBlock(adult: AuthUser, p: NewBlock, opts: { now?: Date } = {}) {
  const reason = p.reason.trim();
  if (!reason) throw badRequest('Cuenta el motivo');
  if (p.kind === 'window') {
    if (!p.windowStart || !p.windowEnd || hhmmToMinutes(p.windowStart) >= hhmmToMinutes(p.windowEnd)) throw badRequest('La franja debe terminar después de empezar (p. ej. de 20:00 a 22:00)');
  }
  return tx(async (db) => {
    const now = opts.now ?? new Date();
    const kid = await childOf(db, adult.familyId, p.userId);
    const fam = await getFamily(db, adult.familyId);
    const today = todayIn(fam.timezone, now);
    if (p.endsOn < today) throw badRequest('El último día no puede ser anterior a hoy');
    if (p.endsOn > addDays(today, 90)) throw badRequest('Un descanso puede durar 90 días como máximo');
    const ch = p.challenge?.text?.trim() ? p.challenge : null;
    if (ch && ch.effect === 'shorten' && !(ch.days && ch.days >= 1)) throw badRequest('Indica cuántos días acorta el reto');
    const b = (await one<{ id: string }>(
      db,
      `INSERT INTO screen_blocks(family_id, user_id, kind, reason, starts_on, ends_on, window_start, window_end, challenge_text, challenge_photo, challenge_effect, challenge_days, challenge_status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [adult.familyId, p.userId, p.kind, reason, today, p.endsOn, p.kind === 'window' ? p.windowStart : null, p.kind === 'window' ? p.windowEnd : null,
        ch ? ch.text.trim() : null, ch ? !!ch.photo : false, ch ? ch.effect : null, ch && ch.effect === 'shorten' ? ch.days : null, ch ? 'open' : null, adult.id],
    ))!;
    // Si ya está bloqueado y tiene una sesión en marcha, se para (se cobra lo usado).
    const running = await one<SessionRow>(db, `SELECT * FROM screen_sessions WHERE user_id = $1 AND status = 'running' FOR UPDATE`, [p.userId]);
    if (running) {
      const now0 = now;
      const blocked = (await listBlocks(db, p.userId, fam.timezone, now0, { all: true })).some((x) => x.blocked_now);
      if (blocked) {
        await lockUser(db, p.userId);
        const used = Math.min(totalMinutes(running), Math.max(1, Math.ceil((now0.getTime() - running.started_at!.getTime() - 15_000) / 60_000)));
        await settle(db, running, used, now0, { endReason: 'blocked', actorId: adult.id });
      }
    }
    const label = (await listBlocks(db, p.userId, fam.timezone, now)).find((x) => x.id === b.id)!.label;
    await audit(db, adult.familyId, adult.id, 'screen_block.create', 'screen_block', b.id, { for: p.userId, kind: p.kind, reason, until: p.endsOn, challenge: !!ch });
    await notify(db, {
      userId: p.userId, event: 'screen_block', title: label, body: `Motivo: ${reason}.${ch ? ` Puedes acortarlo con un reto: «${ch.text.trim()}».` : ''}`, link: '/pantalla', dedupeKey: `screen-block:${b.id}`,
    });
    void kid;
    return { id: b.id, label };
  });
}

async function loadBlock(db: Db, familyId: string, id: string) {
  const b = await one<BlockRow & { family_id: string }>(db, 'SELECT * FROM screen_blocks WHERE id = $1 AND family_id = $2 FOR UPDATE', [id, familyId]);
  if (!b) throw notFound('Descanso no encontrado');
  return b;
}

export async function liftBlock(adult: AuthUser, id: string) {
  return tx(async (db) => {
    const b = await loadBlock(db, adult.familyId, id);
    if (b.status === 'lifted') return { ok: true, duplicate: true };
    await db.query(`UPDATE screen_blocks SET status = 'lifted', lifted_at = now(), lifted_by = $2 WHERE id = $1`, [id, adult.id]);
    await audit(db, adult.familyId, adult.id, 'screen_block.lift', 'screen_block', id, { for: b.user_id });
    await notify(db, { userId: b.user_id, event: 'screen_block', title: `${adult.displayName} ha terminado tu descanso de pantalla`, body: b.reason, link: '/pantalla', dedupeKey: `screen-lift:${id}` });
    return { ok: true, duplicate: false };
  });
}

/** El hijo marca el reto como hecho (con foto si el adulto la pidió) y un adulto lo valida. */
export async function submitChallenge(child: AuthUser, id: string, o: { note?: string; photoPath?: string | null }) {
  return tx(async (db) => {
    const b = await loadBlock(db, child.familyId, id);
    if (b.user_id !== child.id) throw forbidden();
    const fam = await getFamily(db, child.familyId);
    if (b.status !== 'active' || b.ends_on < todayIn(fam.timezone)) throw conflict('Este descanso ya no está activo', 'not_active');
    if (!b.challenge_text) throw conflict('Este descanso no tiene reto', 'no_challenge');
    if (b.challenge_status === 'submitted') throw conflict('El reto ya está enviado: espera a que lo valide un adulto', 'already_submitted');
    if (b.challenge_status === 'approved') throw conflict('El reto ya está validado', 'already_decided');
    if (b.challenge_photo && !o.photoPath) throw badRequest('Este reto necesita una foto como prueba', 'photo_required');
    const old = b.challenge_photo_path;
    await db.query(
      `UPDATE screen_blocks SET challenge_status = 'submitted', challenge_note = $2, challenge_photo_path = COALESCE($3, challenge_photo_path), challenge_done_at = now() WHERE id = $1`,
      [id, (o.note ?? '').slice(0, 300), o.photoPath ?? null],
    );
    await audit(db, child.familyId, child.id, 'screen_block.challenge_done', 'screen_block', id, { for: child.id });
    await notifyAdults(db, child.familyId, { event: 'screen_challenge', title: `${child.displayName} ha cumplido su reto: «${b.challenge_text}»`, body: 'Valídalo para terminar o acortar su descanso de pantalla.', link: '/validar', dedupeKey: `screen-chal:${id}:${Date.now()}` });
    if (o.photoPath && old && old !== o.photoPath) removePhotoFile(old);
    return { ok: true };
  });
}

export async function reviewChallenge(adult: AuthUser, id: string, approve: boolean, note = '') {
  return tx(async (db) => {
    const b = await loadBlock(db, adult.familyId, id);
    if (b.challenge_status !== 'submitted') throw conflict('Este reto no está esperando validación', 'not_submitted');
    const fam = await getFamily(db, adult.familyId);
    const today = todayIn(fam.timezone);
    let result = 'rejected';
    if (approve) {
      if (b.challenge_effect === 'lift') {
        await db.query(`UPDATE screen_blocks SET status = 'lifted', lifted_at = now(), lifted_by = $2, challenge_status = 'approved', challenge_decided_at = now(), challenge_decided_by = $2 WHERE id = $1`, [id, adult.id]);
        result = 'lifted';
      } else {
        const newEnd = addDays(b.ends_on, -(b.challenge_days ?? 1));
        if (newEnd < today) {
          await db.query(`UPDATE screen_blocks SET status = 'lifted', lifted_at = now(), lifted_by = $2, ends_on = GREATEST(starts_on, $3), challenge_status = 'approved', challenge_decided_at = now(), challenge_decided_by = $2 WHERE id = $1`, [id, adult.id, newEnd]);
          result = 'lifted';
        } else {
          await db.query(`UPDATE screen_blocks SET ends_on = GREATEST(starts_on, $3), challenge_status = 'approved', challenge_decided_at = now(), challenge_decided_by = $2 WHERE id = $1`, [id, adult.id, newEnd]);
          result = 'shortened';
        }
      }
    } else {
      await db.query(`UPDATE screen_blocks SET challenge_status = 'rejected', challenge_note = $2, challenge_decided_at = now(), challenge_decided_by = $3 WHERE id = $1`, [id, note.trim().slice(0, 300), adult.id]);
    }
    await audit(db, adult.familyId, adult.id, 'screen_block.challenge_review', 'screen_block', id, { for: b.user_id, approve, result });
    const title = result === 'lifted' ? `¡Reto cumplido! ${adult.displayName} ha terminado tu descanso de pantalla`
      : result === 'shortened' ? `¡Reto cumplido! Tu descanso se acorta ${b.challenge_days} ${b.challenge_days === 1 ? 'día' : 'días'}`
      : `${adult.displayName} te pide repetir el reto «${b.challenge_text}»`;
    await notify(db, { userId: b.user_id, event: 'screen_block', title, body: approve ? '' : note.trim(), link: '/pantalla', dedupeKey: `screen-chal-dec:${id}:${Date.now()}` });
    return { ok: true, result };
  });
}

/** Retos esperando validación (para «Validar»). */
export async function pendingChallenges(db: Db, familyId: string) {
  return many(
    db,
    `SELECT b.id, b.user_id, b.reason, b.challenge_text, b.challenge_photo, b.challenge_effect, b.challenge_days, b.challenge_note, b.challenge_done_at, (b.challenge_photo_path IS NOT NULL) AS has_photo,
            u.display_name, u.avatar, u.color
       FROM screen_blocks b JOIN users u ON u.id = b.user_id WHERE b.family_id = $1 AND b.status = 'active' AND b.challenge_status = 'submitted' ORDER BY b.challenge_done_at`,
    [familyId],
  );
}

/** Peticiones de pantalla o tiempo extra esperando permiso (para «Validar»). */
export async function pendingSessions(db: Db, familyId: string) {
  const rates = await getRates(db, familyId);
  const rows = await many(
    db,
    `${SESSION_SELECT.replace('SELECT s.*,', 'SELECT s.*, (SELECT COALESCE(SUM(delta),0)::int FROM screen_ledger WHERE user_id = s.user_id) AS balance_minutes,')} WHERE s.family_id = $1 AND s.status = 'pending' ORDER BY s.created_at`,
    [familyId],
  );
  return rows.map((r) => ({ ...r, rates }));
}

/* ---------- Lecturas ---------- */

export async function listSessions(db: Db, familyId: string, userId: string, limit = 40) {
  return many(db, `${SESSION_SELECT} WHERE s.family_id = $1 AND s.user_id = $2 AND s.status <> 'cancelled' ORDER BY s.created_at DESC LIMIT $3`, [familyId, userId, limit]);
}

/** Todo lo que necesita «Mi pantalla» / «Pantalla» de un hijo, en una sola llamada. Cierra antes lo vencido. */
export async function screenState(viewer: AuthUser, userId: string, opts: { now?: Date } = {}) {
  return tx(async (db) => {
    const now = opts.now ?? new Date();
    const fam = await getFamily(db, viewer.familyId);
    await childOf(db, viewer.familyId, userId);
    await lockUser(db, userId);
    await closeDueSessions(db, now, userId);
    await expireLots(db, viewer.familyId, userId, now);
    const access = await accessFor(db, fam, userId, now);
    const legacyUsage = await one<{ confirmed: number; pending: number; direct: number }>(db,
      `SELECT COALESCE(SUM(minutes) FILTER (WHERE status = 'confirmed'),0)::int AS confirmed,
              COALESCE(SUM(minutes) FILTER (WHERE status = 'pending'),0)::int AS pending,
              (SELECT COALESCE(SUM(-delta),0)::int FROM screen_ledger
                WHERE user_id = $1 AND kind = 'spend' AND ref_id IS NULL AND delta < 0
                  AND created_at >= ($2::date::timestamp AT TIME ZONE $3)
                  AND created_at < (($2::date + 1)::timestamp AT TIME ZONE $3)) AS direct
         FROM screen_usage_logs WHERE user_id = $1 AND day = $2`, [userId, access.today, fam.timezone],
    );
    const own = viewer.role === 'child';
    const session = await one(db, `${SESSION_SELECT} WHERE s.user_id = $1 AND s.kind = 'timer' AND s.status IN ('pending','running')`, [userId]);
    const pendingExtra = await one(db, `${SESSION_SELECT} WHERE s.user_id = $1 AND s.kind = 'charge' AND s.status = 'pending'`, [userId]);
    // Si la sesión terminó hace poco, el hijo aún ve «Se acabó el tiempo» (hasta que la cierre en pantalla).
    const last = await one(db, `${SESSION_SELECT} WHERE s.user_id = $1 AND s.kind = 'timer' AND s.status = 'finished' ORDER BY s.ended_at DESC LIMIT 1`, [userId]);
    const plan = await one(db, 'SELECT minutes_per_week, enabled FROM screen_plans WHERE user_id = $1', [userId]);
    const can = canStart(access, true);
    const adultCan = canStart(access, false);
    const blocks = await listBlocks(db, userId, fam.timezone, now);
    const debt = await one<{ n: number }>(db, 'SELECT COALESCE(SUM(remaining),0)::int AS n FROM screen_debts WHERE user_id = $1 AND remaining > 0', [userId]);
    const expiring = await one<{ m: number; first: Date | null }>(
      db,
      `SELECT COALESCE(SUM(remaining),0)::int AS m, MIN(expires_at) AS first FROM screen_lots WHERE user_id = $1 AND source <> 'plan' AND remaining > 0 AND expires_at > $2 AND expires_at <= $2::timestamptz + make_interval(days => $3)`,
      [userId, now, EXPIRY_WARN_DAYS],
    );
    const rates = await getRates(db, viewer.familyId);
    return {
      now: now.toISOString(),
      timezone: fam.timezone,
      balance: access.balance,
      buckets: await screenBuckets(db, userId),
      plan: { enabled: plan?.enabled ?? false, minutes_per_week: plan?.minutes_per_week ?? 0, allowed_days: access.rules.allowedDays, day_max: access.rules.dayMax, require_approval: access.rules.requireApproval },
      today: {
        date: access.today, allowed: access.allowedDay, cap: access.cap, used: access.usedToday, cap_left: access.capLeft,
        total_used_minutes: access.totalSessionMinutes + legacyUsage!.confirmed + legacyUsage!.direct, pending_legacy_minutes: legacyUsage!.pending,
      },
      can_start: own ? can.ok : adultCan.ok,
      reason: own ? can.reason : adultCan.reason,
      reason_code: own ? can.code : adultCan.code,
      max_minutes: own ? can.maxMinutes : adultCan.maxMinutes,
      session: session ?? null,
      pending_extra: pendingExtra ?? null,
      last_session: last ?? null,
      blocks,
      pause: access.pause,
      debt_minutes: debt!.n,
      expiring: expiring && expiring.m > 0 ? { minutes: expiring.m, expires_at: expiring.first } : null,
      rates,
      wallet: { points: await pointsBalance(db, userId), cents: await moneyBalance(db, userId) },
    };
  });
}

/** Cambia los días de uso, topes y la aprobación de un hijo. */
export async function saveRules(adult: AuthUser, userId: string, r: Rules) {
  return tx(async (db) => {
    await childOf(db, adult.familyId, userId);
    const days = [...new Set(r.allowedDays)].sort((a, b) => a - b);
    if (!days.length) throw badRequest('Deja al menos un día permitido (o programa un descanso de pantalla)');
    const max: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.dayMax)) if (days.includes(Number(k)) && v > 0) max[k] = v;
    await db.query(
      `INSERT INTO screen_plans(user_id, family_id, allowed_days, day_max, require_approval, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now())
       ON CONFLICT (user_id) DO UPDATE SET allowed_days = EXCLUDED.allowed_days, day_max = EXCLUDED.day_max, require_approval = EXCLUDED.require_approval, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [userId, adult.familyId, days, JSON.stringify(max), r.requireApproval, adult.id],
    );
    await audit(db, adult.familyId, adult.id, 'screen_rules.update', 'user', userId, { for: userId, days, max, approval: r.requireApproval });
    return { allowedDays: days, dayMax: max, requireApproval: r.requireApproval };
  });
}
