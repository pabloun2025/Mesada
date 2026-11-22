import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { createSession, hashPassword, requireAdult, requirePrincipal, requireUser, setSessionCookie, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { LEGAL_VERSION } from '../lib/legal.js';
import { enforceLimit } from '../lib/limits.js';
import { audit } from '../lib/audit.js';
import { CHANNELS, EVENTS, isEventKey } from '../lib/notify/events.js';
import { absoluteLink, channelBlockReason, notify, sendSystemEmail } from '../lib/notify/dispatch.js';
import { channelStatus } from '../lib/notify/providers.js';
import { usage } from '../lib/notify/worker.js';
import { lineConnect, lineStatus } from '../lib/notify/whatsapp-line.js';
import { config } from '../lib/config.js';
import { adultPassword, publicUser, usernameSchema } from './auth.js';
import { phoneSchema, relationshipLabelSchema, relationshipSchema } from '../lib/schemas.js';
import { randomUUID } from 'node:crypto';
import { isRelativeKind, kinshipText, whoText } from '../lib/kinship.js';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'hora no válida (HH:MM)');
const phone = phoneSchema;

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

  /**
   * Correo y teléfono (WhatsApp) de un miembro. Los cambia la cuenta principal (en cualquier miembro: adultos, parientes e hijos)
   * o el propio miembro; ningún otro adulto ni pariente (403). Los avisos ya encolados pasan a usar el dato nuevo.
   */
  app.put('/api/notify/contact/:userId', async (req) => {
    const u = requireAdult(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    const m = await one<{ id: string; role: string; email: string | null; phone: string | null; whatsapp_consent_at: string | null; active: boolean }>(
      getPool(), 'SELECT id, role, email, phone, whatsapp_consent_at, active FROM users WHERE id = $1 AND family_id = $2', [userId, u.familyId],
    );
    if (!m) throw notFound('Miembro no encontrado');
    if (m.id !== u.id && !u.isPrincipal) throw forbidden('Solo la cuenta principal o la propia persona pueden cambiar su correo y su teléfono');
    const b = z
      .object({
        // Sin `email`, el correo no se toca (el perfil solo cambia el WhatsApp).
        email: z.union([z.literal(''), z.string().trim().toLowerCase().email('correo no válido').max(200)]).nullable().optional(),
        phone: z.union([z.literal(''), phone]).nullable(),
        whatsappConsent: z.boolean(),
      })
      .parse(req.body);
    const keepEmail = b.email === undefined;
    const email = keepEmail ? m.email : b.email || null;
    const tel = b.phone || null;
    const dup = email && email !== m.email ? await one(getPool(), 'SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [email, userId]) : null;
    if (dup) throw badRequest('Ese correo ya lo usa otra cuenta');
    // El consentimiento de WhatsApp de un adulto o pariente lo da esa persona: si la principal le cambia el número, queda por dar de nuevo.
    const otherAdult = m.role === 'adult' && m.id !== u.id;
    const emailChanged = (email ?? null) !== (m.email ?? null);
    const phoneChanged = tel !== (m.phone ?? null);
    const consent = otherAdult ? (phoneChanged ? false : !!m.whatsapp_consent_at) : b.whatsappConsent;
    await tx(async (db) => {
      await db.query(
        `UPDATE users SET email = $2, phone = $3,
           whatsapp_consent_at = CASE WHEN $4 AND $3::text IS NOT NULL THEN COALESCE(whatsapp_consent_at, now()) ELSE NULL END
         WHERE id = $1`,
        [userId, email, tel, consent],
      );
      // Los avisos usan siempre el dato más reciente: lo que esperaba en la cola se reencamina (o se omite si ya no hay dónde enviarlo).
      if (emailChanged) {
        await db.query(`UPDATE notification_outbox SET to_address = $2, status = CASE WHEN $2::text IS NULL THEN 'skipped' ELSE status END WHERE user_id = $1 AND channel = 'email' AND status = 'pending'`, [userId, email]);
      }
      if (phoneChanged || (!consent && m.whatsapp_consent_at)) {
        await db.query(`UPDATE notification_outbox SET to_address = $2, status = CASE WHEN $2::text IS NULL OR NOT $3 THEN 'skipped' ELSE status END WHERE user_id = $1 AND channel = 'whatsapp' AND status = 'pending'`, [userId, tel, consent]);
      }
      await audit(db, u.familyId, u.id, 'notify.contact_update', 'user', userId, { for: userId, email: keepEmail ? 'sin cambios' : emailChanged ? (email ? 'cambiado' : 'quitado') : 'sin cambios', phone: phoneChanged ? (tel ? 'cambiado' : 'quitado') : 'sin cambios', whatsappConsent: consent });
      // Si la principal cambia los datos de otro adulto o pariente con cuenta activa, se le avisa en la app.
      if (otherAdult && m.active && (emailChanged || phoneChanged)) {
        const what = [emailChanged ? 'tu correo' : '', phoneChanged ? 'tu teléfono' : ''].filter(Boolean).join(' y ');
        await notify(db, {
          userId, event: 'family_change', title: `${whoText(u.displayName, u.relationship, u.relationshipLabel)} ha cambiado ${what}`,
          body: 'Puedes revisarlo y cambiarlo en Mi perfil.', link: '/perfil', dedupeKey: `contact-change:${userId}:${randomUUID()}`,
        });
      }
    });
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

  // --- Línea de WhatsApp de la instalación: solo adultos de la familia administradora (la primera creada) ---
  async function assertLineAdmin(u: AuthUser) {
    const first = await one<{ id: string }>(getPool(), 'SELECT id FROM families ORDER BY created_at LIMIT 1');
    if (first?.id !== u.familyId) throw forbidden('La línea de WhatsApp la gestiona la familia administradora de esta instalación');
  }

  app.get('/api/notify/whatsapp', async (req) => {
    const u = requireAdult(req);
    await assertLineAdmin(u);
    return { line: await lineStatus(), real: channelStatus().whatsapp.real };
  });

  app.post('/api/notify/whatsapp/link', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireAdult(req);
    await assertLineAdmin(u);
    const b = z.object({ number: z.union([z.literal(''), phone]).optional() }).parse(req.body ?? {});
    const r = await lineConnect(b.number || undefined);
    if (!r.ok) throw badRequest(r.error, 'whatsapp_unavailable');
    if (r.qr || r.pairingCode) await audit(getPool(), u.familyId, u.id, 'whatsapp.link_requested', 'whatsapp', null, { mode: r.pairingCode ? 'codigo' : 'qr' });
    return r;
  });

  // --- Recuperación de contraseña (adultos con correo). Respuesta siempre igual, para no revelar cuentas. ---
  app.post('/api/auth/forgot', { config: { rateLimit: { max: Math.min(config.authRateLimit, 5), timeWindow: '1 minute' } } }, async (req) => {
    const b = z.object({ login: z.string().trim().min(1).max(200) }).parse(req.body);
    enforceLimit(req, 'recovery', config.limits.recoveryPerHour);
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
          subject: 'Cambia tu contraseña de DiploP',
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
    enforceLimit(req, 'reset', config.limits.resetPerHour);
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

  // --- Invitaciones por correo para otro adulto o pariente (solo la cuenta principal; D59) ---
  app.post('/api/invitations', async (req) => {
    const u = requirePrincipal(req);
    const b = z
      .object({
        email: z.string().trim().toLowerCase().email('correo no válido').max(200),
        displayName: z.string().trim().min(1).max(60),
        relationship: relationshipSchema,
        relationshipLabel: relationshipLabelSchema.optional(),
        phone: z.union([z.literal(''), phoneSchema]).nullable().optional(),
      })
      .refine((v) => v.relationship !== 'other' || !!v.relationshipLabel, { message: 'Escribe qué parentesco tiene', path: ['relationshipLabel'] })
      .parse(req.body);
    enforceLimit(req, 'invite', config.limits.invitePerHour);
    if (await one(getPool(), 'SELECT 1 FROM users WHERE lower(email) = $1', [b.email])) throw badRequest('Ese correo ya tiene una cuenta');
    const open = (await one<{ n: number }>(getPool(), `SELECT count(*)::int AS n FROM invitations WHERE family_id = $1 AND accepted_at IS NULL AND expires_at > now()`, [u.familyId]))!.n;
    if (open >= config.caps.maxPendingInvitations) throw conflict('Ya tienes muchas invitaciones sin usar. Espera a que caduquen (7 días).', 'too_many_invitations');
    const members = (await one<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM users WHERE family_id = $1', [u.familyId]))!.n;
    if (members >= config.caps.maxMembers) throw conflict(`Una familia puede tener hasta ${config.caps.maxMembers} personas.`, 'too_many_members');
    const token = crypto.randomBytes(32).toString('base64url');
    const fam = await one(getPool(), 'SELECT name FROM families WHERE id = $1', [u.familyId]);
    const label = b.relationship === 'other' ? b.relationshipLabel! : null;
    const relative = isRelativeKind(b.relationship);
    await tx(async (db) => {
      const inv = await one(
        db,
        `INSERT INTO invitations(family_id, email, display_name, token_hash, invited_by, expires_at, relationship, relationship_label, phone)
         VALUES ($1,$2,$3,$4,$5, now() + interval '7 days',$6,$7,$8) RETURNING id`,
        [u.familyId, b.email, b.displayName, sha256(token), u.id, b.relationship, label, b.phone || null],
      );
      await sendSystemEmail(db, {
        familyId: u.familyId,
        to: b.email,
        event: 'invitation',
        subject: `${whoText(u.displayName, u.relationship, u.relationshipLabel)} te invita a ${fam.name} en DiploP`,
        body: relative
          ? `Hola, ${b.displayName}. ${u.displayName} te invita a ver cómo van las tareas y la mesada de ${fam.name} y a animar a los niños con felicitaciones y aportes a sus metas de ahorro. Crea tu usuario con el enlace; caduca en 7 días.`
          : `Hola, ${b.displayName}. ${u.displayName} te invita a gestionar las tareas y la mesada de ${fam.name}. Crea tu usuario con el enlace; caduca en 7 días.`,
        link: absoluteLink(`/invitacion?token=${token}`) ?? `/invitacion?token=${token}`,
        dedupeKey: `invitation:${inv.id}`,
      });
      await audit(db, u.familyId, u.id, 'invitation.create', 'invitation', inv.id, { relationship: b.relationship });
    });
    return { ok: true };
  });

  app.get('/api/invitations', async (req) => {
    const u = requirePrincipal(req);
    return {
      invitations: await many(
        getPool(),
        `SELECT id, email, display_name, relationship, relationship_label, expires_at, accepted_at, created_at FROM invitations WHERE family_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [u.familyId],
      ),
    };
  });

  // Anular una invitación que aún no se ha usado.
  app.post('/api/invitations/:id/cancel', async (req) => {
    const u = requirePrincipal(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await getPool().query('DELETE FROM invitations WHERE id = $1 AND family_id = $2 AND accepted_at IS NULL', [id, u.familyId]);
    if (!r.rowCount) throw notFound('Invitación no encontrada o ya usada');
    await audit(getPool(), u.familyId, u.id, 'invitation.cancel', 'invitation', id);
    return { ok: true };
  });

  app.post('/api/invitations/lookup', async (req) => {
    const b = z.object({ token: z.string().min(20).max(200) }).parse(req.body);
    enforceLimit(req, 'invite-lookup', config.limits.inviteAcceptPerHour * 2);
    const inv = await one(
      getPool(),
      `SELECT i.email, i.display_name, i.relationship, i.relationship_label, f.name AS family_name FROM invitations i JOIN families f ON f.id = i.family_id
        WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`,
      [sha256(b.token)],
    );
    if (!inv) throw notFound('La invitación no es válida o ha caducado');
    return { invitation: inv };
  });

  app.post('/api/invitations/accept', { config: { rateLimit: { max: Math.min(config.authRateLimit, 10), timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z
      .object({
        token: z.string().min(20).max(200), username: usernameSchema, password: adultPassword,
        acceptTerms: z.literal(true, { error: 'Debes aceptar la política de privacidad y las condiciones' }),
        termsVersion: z.string().max(40),
      })
      .parse(req.body);
    enforceLimit(req, 'invite-accept', config.limits.inviteAcceptPerHour);
    if (b.termsVersion !== LEGAL_VERSION) throw new HttpError(409, 'Los textos legales han cambiado. Recarga la página para leerlos y aceptarlos.', 'terms_outdated');
    const created = await tx(async (db) => {
      const inv = await one(db, `SELECT * FROM invitations WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(b.token)]);
      if (!inv) throw notFound('La invitación no es válida o ha caducado');
      if (await one(db, 'SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.username])) throw badRequest('Ese nombre de usuario ya existe', 'username_taken');
      if (await one(db, 'SELECT 1 FROM users WHERE lower(email) = lower($1)', [inv.email])) throw badRequest('Ese correo ya tiene una cuenta');
      const members = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users WHERE family_id = $1', [inv.family_id]))!.n;
      if (members >= config.caps.maxMembers) throw conflict('La familia ya tiene el máximo de personas.', 'too_many_members');
      const user = await one(
        db,
        `INSERT INTO users(family_id, role, display_name, username, password_hash, email, phone, relationship, relationship_label, avatar, color, terms_version, terms_accepted_at)
         VALUES ($1,'adult',$2,$3,$4,$5,$6,$7,$8,'bear','sky',$9, now()) RETURNING id`,
        [inv.family_id, inv.display_name, b.username, await hashPassword(b.password), inv.email, inv.phone, inv.relationship ?? 'partner', inv.relationship_label, LEGAL_VERSION],
      );
      await db.query('UPDATE invitations SET accepted_at = now(), accepted_user_id = $2 WHERE id = $1', [inv.id, user.id]);
      await audit(db, inv.family_id, user.id, 'invitation.accept', 'invitation', inv.id, { displayName: inv.display_name, relationship: inv.relationship });
      const s = await createSession(db, user.id, req.headers['user-agent']);
      return { userId: user.id as string, ...s };
    });
    setSessionCookie(reply, created.token, created.expires);
    return { user: await publicUser(created.userId) };
  });
}
