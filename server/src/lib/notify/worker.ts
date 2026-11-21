import { getPool, one, tx, type Db } from '../db.js';
import { getProviders } from './providers.js';
import type { Channel } from './events.js';
import { getSetting } from '../settings.js';

const MAX_ATTEMPTS = 5;

export function caps() {
  return {
    emailMonthly: Number(process.env.NOTIFY_EMAIL_MONTHLY_CAP ?? 100),
    whatsappDaily: Number(process.env.NOTIFY_WHATSAPP_DAILY_CAP ?? 40),
    whatsappMinIntervalMs: Number(process.env.NOTIFY_WHATSAPP_MIN_INTERVAL_MS ?? 4000),
  };
}

function period(channel: Channel, now = new Date()) {
  const madrid = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return channel === 'email' ? madrid.slice(0, 7) : madrid;
}

/** Reserva un envío dentro del tope de la instalación. false = tope alcanzado. */
async function reserve(db: Db, channel: Channel, force: boolean) {
  const cap = channel === 'email' ? caps().emailMonthly : caps().whatsappDaily;
  const r = await db.query(
    `INSERT INTO notification_usage(channel, period, sent) VALUES ($1, $2, 1)
     ON CONFLICT (channel, period) DO UPDATE SET sent = notification_usage.sent + 1
       WHERE $4 OR notification_usage.sent < $3
     RETURNING sent`,
    [channel, period(channel), cap, force],
  );
  if (r.rowCount === 0) return false;
  if (!force && r.rows[0].sent > cap) {
    await release(db, channel); // primer envío del periodo con tope 0
    return false;
  }
  return true;
}

async function release(db: Db, channel: Channel) {
  await db.query('UPDATE notification_usage SET sent = greatest(0, sent - 1) WHERE channel = $1 AND period = $2', [channel, period(channel)]);
}

export async function usage(db: Db = getPool()) {
  const e = await one<{ sent: number }>(db, `SELECT sent FROM notification_usage WHERE channel = 'email' AND period = $1`, [period('email')]);
  const w = await one<{ sent: number }>(db, `SELECT sent FROM notification_usage WHERE channel = 'whatsapp' AND period = $1`, [period('whatsapp')]);
  const c = caps();
  return { email: { sent: e?.sent ?? 0, cap: c.emailMonthly, period: 'mes' }, whatsapp: { sent: w?.sent ?? 0, cap: c.whatsappDaily, period: 'día' } };
}

let lastWhatsapp = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Procesa la cola: toma cada mensaje con bloqueo (SKIP LOCKED, admite varias instancias), respeta topes,
 * envía fuera de la transacción y registra el resultado. Devuelve cuántos ha procesado.
 */
export async function processOutbox(opts: { limit?: number; db?: Db } = {}) {
  const db = opts.db ?? getPool();
  // Pausa desde Administración: los mensajes esperan en la cola, no se pierden.
  if (await getSetting('notify_paused', db)) return 0;
  const providers = getProviders();
  let processed = 0;
  // Mensajes que se quedaron «enviando» por una caída: no se sabe si salieron → inciertos, sin reintento.
  await db.query(`UPDATE notification_outbox SET status = 'uncertain', last_error = 'Interrumpido durante el envío' WHERE status = 'sending' AND not_before < now() - interval '10 minutes'`);
  for (let i = 0; i < (opts.limit ?? 50); i++) {
    const job = await tx(async (c) => {
      const row = await one(
        c,
        `SELECT * FROM notification_outbox WHERE status = 'pending' AND not_before <= now() ORDER BY critical DESC, not_before LIMIT 1 FOR UPDATE SKIP LOCKED`,
      );
      if (!row) return null;
      if (!row.to_address) {
        await c.query(`UPDATE notification_outbox SET status = 'skipped', last_error = 'Sin destinatario' WHERE id = $1`, [row.id]);
        return { skip: true };
      }
      if (!(await reserve(c, row.channel, row.critical))) {
        await c.query(`UPDATE notification_outbox SET status = 'skipped', last_error = 'Tope de envíos alcanzado' WHERE id = $1`, [row.id]);
        return { skip: true };
      }
      await c.query(`UPDATE notification_outbox SET status = 'sending', attempts = attempts + 1, not_before = now() WHERE id = $1`, [row.id]);
      return { row };
    });
    if (!job) break;
    processed++;
    if ('skip' in job) continue;
    const row = job.row;
    const provider = row.channel === 'email' ? providers.email : providers.whatsapp;
    if (row.channel === 'whatsapp' && provider.real) {
      const wait = lastWhatsapp + caps().whatsappMinIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
      lastWhatsapp = Date.now();
    }
    const result = await provider.send({ to: row.to_address, subject: row.subject, body: row.body, link: row.link, idempotencyKey: `mesada:${row.dedupe_key}` });
    if (result.ok) {
      await db.query(`UPDATE notification_outbox SET status = 'sent', provider = $2, external_id = $3, sent_at = now(), last_error = NULL WHERE id = $1`, [row.id, provider.name, result.externalId]);
    } else if (result.uncertain) {
      await db.query(`UPDATE notification_outbox SET status = 'uncertain', provider = $2, last_error = $3 WHERE id = $1`, [row.id, provider.name, result.error]);
    } else {
      await release(db, row.channel);
      const retry = result.retryable && row.attempts + 1 < MAX_ATTEMPTS;
      await db.query(
        `UPDATE notification_outbox SET status = $2, provider = $3, last_error = $4,
                not_before = CASE WHEN $2 = 'pending' THEN now() + make_interval(mins => power(2, attempts)::int) ELSE not_before END
          WHERE id = $1`,
        [row.id, retry ? 'pending' : 'failed', provider.name, result.error],
      );
    }
  }
  return processed;
}
