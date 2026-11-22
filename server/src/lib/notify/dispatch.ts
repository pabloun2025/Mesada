import { many, one, type Db } from '../db.js';
import { CHANNELS, EVENTS, type Channel, type EventKey } from './events.js';
import { nextAllowedTime } from './time.js';

export interface NotifyInput {
  userId: string;
  event: EventKey;
  title: string;
  body?: string;
  link?: string | null;
  /** Clave de deduplicación: el mismo aviso nunca se envía dos veces por el mismo canal. */
  dedupeKey?: string | null;
}

interface Recipient {
  id: string;
  family_id: string;
  role: 'adult' | 'child';
  email: string | null;
  phone: string | null;
  whatsapp_consent_at: string | null;
  birth_year: number | null;
  active: boolean;
  timezone: string;
  quiet_start: string;
  quiet_end: string;
}

export const WHATSAPP_MIN_AGE = 13;

/** Edad mínima conservadora: con solo el año de nacimiento, se asume que aún no ha cumplido los años de este año. */
export function minAge(birthYear: number | null, now = new Date()) {
  return birthYear == null ? null : now.getUTCFullYear() - birthYear - 1;
}

/** Motivo por el que un canal no está disponible para una persona (null = disponible). */
export function channelBlockReason(r: Pick<Recipient, 'role' | 'email' | 'phone' | 'whatsapp_consent_at' | 'birth_year'>, channel: Channel): string | null {
  if (channel === 'email') return r.email ? null : 'Sin correo';
  // En menores, la edad va primero: es lo que decide si tiene sentido pedir el teléfono.
  if (r.role === 'child') {
    const age = minAge(r.birth_year);
    if (age == null) return 'Falta el año de nacimiento';
    if (age < WHATSAPP_MIN_AGE) return `WhatsApp exige ${WHATSAPP_MIN_AGE} años`;
  }
  if (!r.phone) return 'Sin teléfono';
  if (!r.whatsapp_consent_at) return 'Sin consentimiento';
  return null;
}

async function loadRecipient(db: Db, userId: string) {
  return one<Recipient>(
    db,
    `SELECT u.id, u.family_id, u.role, u.email, u.phone, u.whatsapp_consent_at, u.birth_year, u.active,
            f.timezone, to_char(f.quiet_start, 'HH24:MI') AS quiet_start, to_char(f.quiet_end, 'HH24:MI') AS quiet_end
       FROM users u JOIN families f ON f.id = u.family_id WHERE u.id = $1`,
    [userId],
  );
}

/** Canales externos activos para un evento: preferencia guardada o valor por defecto, y además disponible. */
export async function effectiveChannels(db: Db, r: Recipient, event: EventKey): Promise<Channel[]> {
  const prefs = await many<{ channel: Channel; enabled: boolean }>(db, 'SELECT channel, enabled FROM notification_prefs WHERE user_id = $1 AND event = $2', [r.id, event]);
  const byChannel = new Map(prefs.map((p) => [p.channel, p.enabled]));
  const defaults: readonly Channel[] = EVENTS[event].defaults;
  return CHANNELS.filter((c) => (byChannel.get(c) ?? defaults.includes(c)) && channelBlockReason(r, c) === null);
}

/**
 * Notifica a una persona: aviso en la aplicación y, si procede, encola correo/WhatsApp.
 * Debe llamarse dentro de la transacción de la acción que lo origina (patrón outbox).
 */
export async function notify(db: Db, n: NotifyInput) {
  const r = await loadRecipient(db, n.userId);
  if (!r || !r.active) return;
  const inApp = await db.query(
    `INSERT INTO notifications(user_id, kind, title, body, link, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [n.userId, n.event, n.title, n.body ?? '', n.link ?? null, n.dedupeKey ?? null],
  );
  if (inApp.rowCount === 0) return; // ya avisado
  const key = n.dedupeKey ?? `${n.event}:${inApp.rows[0].id}`;
  const channels = await effectiveChannels(db, r, n.event);
  if (!channels.length) return;
  const critical = 'critical' in EVENTS[n.event] && Boolean((EVENTS[n.event] as { critical?: boolean }).critical);
  const notBefore = critical ? new Date() : nextAllowedTime(new Date(), r.timezone, r.quiet_start, r.quiet_end);
  for (const channel of channels) {
    await db.query(
      `INSERT INTO notification_outbox(family_id, user_id, to_address, event, channel, subject, body, link, critical, dedupe_key, not_before)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (dedupe_key) DO NOTHING`,
      [r.family_id, r.id, channel === 'email' ? r.email : r.phone, n.event, channel, n.title, n.body ?? '', absoluteLink(n.link), critical, `${key}:${channel}`, notBefore],
    );
  }
}

/** Avisa a los adultos completos; los parientes (ver y animar) no reciben avisos de gestión. */
export async function notifyAdults(db: Db, familyId: string, n: Omit<NotifyInput, 'userId'>) {
  const adults = await many<{ id: string }>(db, `SELECT id FROM users WHERE family_id = $1 AND role = 'adult' AND active AND NOT is_relative`, [familyId]);
  for (const a of adults) await notify(db, { ...n, userId: a.id, dedupeKey: n.dedupeKey ? `${n.dedupeKey}:${a.id}` : null });
}

/** Correo de sistema (recuperación, invitación): no depende de preferencias ni del horario de silencio. */
export async function sendSystemEmail(
  db: Db,
  m: { familyId: string; userId?: string | null; to: string; event: 'password_reset' | 'invitation'; subject: string; body: string; link: string; dedupeKey: string },
) {
  await db.query(
    `INSERT INTO notification_outbox(family_id, user_id, to_address, event, channel, subject, body, link, critical, dedupe_key)
     VALUES ($1,$2,$3,$4,'email',$5,$6,$7,true,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
    [m.familyId, m.userId ?? null, m.to, m.event, m.subject, m.body, m.link, m.dedupeKey],
  );
}

export function absoluteLink(link?: string | null) {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  const base = (process.env.APP_BASE_URL ?? '').replace(/\/$/, '');
  return base ? `${base}${link}` : null;
}
