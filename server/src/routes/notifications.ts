import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { createSession, hashPassword, requireAdult, requireUser, setSessionCookie, type AuthUser } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { CHANNELS, EVENTS, isEventKey } from '../lib/notify/events.js';
import { absoluteLink, channelBlockReason, sendSystemEmail } from '../lib/notify/dispatch.js';
import { channelStatus } from '../lib/notify/providers.js';
import { usage } from '../lib/notify/worker.js';
import { config } from '../lib/config.js';
import { adultPassword, publicUser, usernameSchema } from './auth.js';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora no válida (HH:MM)');
const phone = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s.-]/g, ''))
  .transform((s) => (/^\d{9}$/.test(s) ? `+34${s}` : s.startsWith('00') ? `+${s.slice(2)}` : s))
  .refine((s) => /^\+[1-9]\d{7,14}$/.test(s), 'teléfono no válido (usa formato +34600000000)');

/** Un adulto gestiona sus avisos y los de los hijos; no los de otro adulto. Un hijo solo consulta los suyos. */
async function assertCanManage(u: AuthUser, userId: string) {
  const m = await one<{ id: string; role: string }>(getPool(), 'SELECT id, role FROM users WHERE id = $1 AND family_id = $2', [userId, u.familyId]);
  if (!m) throw notFound('Miembro no encontrado');
  if (u.role !== 'adult') throw forbidden('Los avisos los configuran los adultos de la familia');
  if (m.role === 'adult' && m.id !== u.id) throw forbidden('Cada adulto gestiona sus propios avisos');
  return m;
}

export default async function notificationRoutes(app: FastifyInstance) {
  /** Todo lo necesario para la pantalla de avisos. */
  app.get('/api/notify/settings', async (req) => {
    const u = requireUser(req);
    const db = getPool();
    const fam = await one(
      db,
      `SELECT to_char(quiet_start,'HH24:MI') AS quiet_start, to_char(quiet_end,'HH24:MI') AS quiet_end,
              to_char(reminder_time,'HH24:MI') AS reminder_time, due_soon_minutes FROM families WHERE id = $1`,
      [u.familyId],
    );
    const members = await many(
      db,
      `SELECT id, role, display_name, avatar, color, birth_year, email, phone, whatsapp_consent_at FROM users
        WHERE family_id = $1 AND active AND ($2::uuid IS NULL OR id = $2) ORDER BY role DESC, created_at`,
      [u.familyId, u.role === 'child' ? u.id : null],
    );
    const prefs = await many(db, `SELECT user_id, event, channel, enabled FROM notification_prefs WHERE user_id = ANY($1::uuid[])`, [members.map((m) => m.id)]);
    const byUser = new Map<string, Record<string, boolean>>();
    for (const p of prefs) byUser.set(p.user_id, { ...(byUser.get(p.user_id) ?? {}), [`${p.event}:${p.channel}`]: p.enabled });
    return {
      family: fam,
      channels: channelStatus(),
      usage: u.role === 'adult' ? await usage(db) : undefined,
      events: Object.entries(EVENTS).map(([key, e]) => ({ key, label: e.label, audience: e.audience, defaults: e.defaults })),
      members: members.map((m) => {
        const saved = byUser.get(m.id) ?? {};
        const matrix: Record<string, Record<string, boolean>> = {};
        for (const [key, e] of Object.entries(EVENTS)) {
          if (e.audience !== 'any' && e.audience !== m.role) continue;
          matrix[key] = Object.fromEntries(CHANNELS.map((c) => [c, saved[`${key}:${c}`] ?? (e.defaults as readonly string[]).includes(c)]));
        }
        return {
          ...m,
          editable: u.role === 'adult' && (m.role === 'child' || m.id === u.id),
          blocked: Object.fromEntries(CHANNELS.map((c) => [c, channelBlockReason(m, c)])),
          prefs: matrix,
        };
      }),
    };
  });

  app.put('/api/notify/family', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ quietStart: time, quietEnd: time, reminderTime: time, dueSoonMinutes: z.number().int().min(0).max(720) }).parse(req.body);
    await getPool().query(
      'UPDATE families SET quiet_start = $2, quiet_end = $3, reminder_time = $4, due_soon_minutes = $5 WHERE id = $1',
      [u.familyId, b.quietStart, b.quietEnd, b.reminderTime, b.dueSoonMinutes],
    );
    await audit(getPool(), u.familyId, u.id, 'notify.family_update', 'family', u.familyId, b);
    return { ok: true };
  });

  app.put('/api/notify/contact/:userId', async (req) => {
    const u = requireAdult(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    await assertCanManage(u, userId);
    const b = z
      .object({
        email: z.union([z.literal(''), z.string().trim().toLowerCase().email('correo no válido').max(200)]).nullable(),
        phone: z.union([z.literal(''), phone]).nullable(),
        whatsappConsent: z.boolean(),
      })
      .parse(req.body);
    const email = b.email || null;
    const tel = b.phone || null;
    const dup = email ? await one(getPool(), 'SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [email, userId]) : null;
    if (dup) throw badRequest('Ese correo ya lo usa otra cuenta');
    await getPool().query(
      `UPDATE users SET email = $2, phone = $3,
         whatsapp_consent_at = CASE WHEN $4 AND $3::text IS NOT NULL THEN COALESCE(whatsapp_consent_at, now()) ELSE NULL END
       WHERE id = $1`,
      [userId, email, tel, b.whatsappConsent],
    );
    await audit(getPool(), u.familyId, u.id, 'notify.contact_update', 'user', userId, { email: !!email, phone: !!tel, whatsappConsent: b.whatsappConsent });
    return { ok: true };
  });

  app.put('/api/notify/prefs/:userId', async (req) => {
    const u = requireAdult(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    await assertCanManage(u, userId);
    const b = z.object({ prefs: z.array(z.object({ event: z.string(), channel: z.enum(['email', 'whatsapp']), enabled: z.boolean() })).max(100) }).parse(req.body);
    await tx(async (db) => {
      for (const p of b.prefs) {
        if (!isEventKey(p.event)) throw badRequest(`Evento desconocido: ${p.event}`);
        await db.query(
          `INSERT INTO notification_prefs(user_id, event, channel, enabled, updated_by) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (user_id, event, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
          [userId, p.event, p.channel, p.enabled, u.id],
        );
      }
      await audit(db, u.familyId, u.id, 'notify.prefs_update', 'user', userId, { count: b.prefs.length });
    });
    return { ok: true };
  });

  /** Últimos envíos externos, para comprobar que llegan (solo adultos). */
  app.get('/api/notify/outbox', async (req) => {
    const u = requireAdult(req);
    const rows = await many(
      getPool(),
      `SELECT o.id, o.event, o.channel, o.subject, o.status, o.attempts, o.provider, o.last_error, o.not_before, o.sent_at, o.created_at,
              u.display_name
         FROM notification_outbox o LEFT JOIN users u ON u.id = o.user_id
        WHERE o.family_id = $1 ORDER BY o.created_at DESC LIMIT 50`,
      [u.familyId],
    );
    return { entries: rows };
  });

  // --- Recuperación de contraseña (adultos con correo). Respuesta siempre igual, para no revelar cuentas. ---
  app.post('/api/auth/forgot', { config: { rateLimit: { max: Math.min(config.authRateLimit, 5), timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ login: z.string().trim().min(1).max(200) }).parse(req.body);
    const user = await one<{ id: string; family_id: string; email: string; display_name: string }>(
      getPool(),
      `SELECT id, family_id, email, display_name FROM users
        WHERE active AND role = 'adult' AND email IS NOT NULL AND (lower(username) = lower($1) OR lower(email) = lower($1))`,
      [b.login],
    );
    if (user) {
      const token = crypto.randomBytes(32).toString('base64url');
      await tx(async (db) => {
        // Solo un enlace vivo por cuenta.
        await db.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
        const r = await one(db, `INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '30 minutes') RETURNING id`, [user.id, sha256(token)]);
        await sendSystemEmail(db, {
          familyId: user.family_id,
          userId: user.id,
          to: user.email,
          event: 'password_reset',
          subject: 'Cambia tu contraseña de Mesada',
          body: `Hola, ${user.display_name}. Alguien ha pedido cambiar tu contraseña. Si no has sido tú, ignora este correo. El enlace caduca en 30 minutos.`,
          link: absoluteLink(`/restablecer?token=${token}`) ?? `/restablecer?token=${token}`,
          dedupeKey: `reset:${r.id}`,
        });
        await audit(db, user.family_id, user.id, 'user.password_reset_requested', 'user', user.id);
      });
    }
    return { ok: true, message: 'Si la cuenta existe y tiene correo, te hemos enviado un enlace.' };
  });

  app.post('/api/auth/reset', { config: { rateLimit: { max: Math.min(config.authRateLimit, 10), timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ token: z.string().min(20).max(200), password: adultPassword }).parse(req.body);
    await tx(async (db) => {
      const r = await one(
        db,
        `SELECT pr.id, pr.user_id, u.family_id FROM password_resets pr JOIN users u ON u.id = pr.user_id
          WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > now() AND u.active FOR UPDATE OF pr`,
        [sha256(b.token)],
      );
      if (!r) throw badRequest('El enlace no es válido o ha caducado. Pide otro.', 'invalid_token');
      await db.query('UPDATE password_resets SET used_at = now() WHERE id = $1', [r.id]);
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [r.user_id, await hashPassword(b.password)]);
      await db.query('DELETE FROM sessions WHERE user_id = $1', [r.user_id]);
      await audit(db, r.family_id, r.user_id, 'user.password_reset', 'user', r.user_id);
    });
    return { ok: true };
  });

  // --- Invitaciones por correo para otro adulto de la familia ---
  app.post('/api/invitations', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ email: z.string().trim().toLowerCase().email('correo no válido').max(200), displayName: z.string().trim().min(1).max(60) }).parse(req.body);
    if (await one(getPool(), 'SELECT 1 FROM users WHERE lower(email) = $1', [b.email])) throw badRequest('Ese correo ya tiene una cuenta');
    const token = crypto.randomBytes(32).toString('base64url');
    const fam = await one(getPool(), 'SELECT name FROM families WHERE id = $1', [u.familyId]);
    await tx(async (db) => {
      const inv = await one(
        db,
        `INSERT INTO invitations(family_id, email, display_name, token_hash, invited_by, expires_at) VALUES ($1,$2,$3,$4,$5, now() + interval '7 days') RETURNING id`,
        [u.familyId, b.email, b.displayName, sha256(token), u.id],
      );
      await sendSystemEmail(db, {
        familyId: u.familyId,
        to: b.email,
        event: 'invitation',
        subject: `${u.displayName} te invita a ${fam.name} en Mesada`,
        body: `Hola, ${b.displayName}. ${u.displayName} te invita a gestionar las tareas y la mesada de ${fam.name}. Crea tu usuario con el enlace; caduca en 7 días.`,
        link: absoluteLink(`/invitacion?token=${token}`) ?? `/invitacion?token=${token}`,
        dedupeKey: `invitation:${inv.id}`,
      });
      await audit(db, u.familyId, u.id, 'invitation.create', 'invitation', inv.id, { email: b.email });
    });
    return { ok: true };
  });

  app.get('/api/invitations', async (req) => {
    const u = requireAdult(req);
    return {
      invitations: await many(
        getPool(),
        `SELECT id, email, display_name, expires_at, accepted_at, created_at FROM invitations WHERE family_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [u.familyId],
      ),
    };
  });

  app.post('/api/invitations/lookup', async (req) => {
    const b = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    const inv = await one(
      getPool(),
      `SELECT i.email, i.display_name, f.name AS family_name FROM invitations i JOIN families f ON f.id = i.family_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
      [sha256(b.token)],
    );
    if (!inv) throw notFound('La invitación no es válida o ha caducado');
    return { invitation: inv };
  });

  app.post('/api/invitations/accept', { config: { rateLimit: { max: Math.min(config.authRateLimit, 10), timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z.object({ token: z.string().min(20).max(200), username: usernameSchema, password: adultPassword }).parse(req.body);
    const created = await tx(async (db) => {
      const inv = await one(db, `SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(b.token)]);
      if (!inv) throw notFound('La invitación no es válida o ha caducado');
      if (await one(db, 'SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.username])) throw badRequest('Ese nombre de usuario ya existe', 'username_taken');
      if (await one(db, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [inv.email])) throw badRequest('Ese correo ya tiene una cuenta');
      const user = await one(
        db,
        `INSERT INTO users(family_id, role, display_name, username, password_hash, email, avatar, color) VALUES ($1,'adult',$2,$3,$4,$5,'bear','sky') RETURNING id`,
        [inv.family_id, inv.display_name, b.username, await hashPassword(b.password), inv.email],
      );
      await db.query('UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [inv.id, user.id]);
      await audit(db, inv.family_id, user.id, 'invitation.accept', 'invitation', inv.id, { displayName: inv.display_name });
      const s = await createSession(db, user.id, req.headers['user-agent']);
      return { userId: user.id as string, ...s };
    });
    setSessionCookie(reply, created.token, created.expires);
    return { user: await publicUser(created.userId) };
  });
}
