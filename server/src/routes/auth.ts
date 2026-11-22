import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, one, tx } from '../lib/db.js';
import { config } from '../lib/config.js';
import {
  createSession, destroySession, dummyVerify, hashPassword, requireUser, SESSION_COOKIE, setSessionCookie, verifyPassword,
} from '../lib/auth.js';
import { badRequest, forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getFamily } from '../lib/family.js';
import { getSetting } from '../lib/settings.js';
import { LEGAL_VERSION } from '../lib/legal.js';
import { enforceLimit } from '../lib/limits.js';
import { CURRENCIES } from '../lib/currency.js';
import { phoneSchema, relationshipSchema, relationshipLabelSchema } from '../lib/schemas.js';
import { isRelativeKind } from '../lib/kinship.js';

export const usernameSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9._-]+$/, 'solo letras, números, punto, guion y guion bajo');
export const adultPassword = z.string().min(8, 'mínimo 8 caracteres').max(200);
export const childSecret = z.string().min(4, 'mínimo 4 caracteres').max(200);

// Bloqueo por cuenta: protege los PIN cortos frente a intentos desde muchas IP.
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60 * 1000;
const failures = new Map<string, { count: number; first: number; lockedUntil: number }>();
function isLocked(username: string) {
  const f = failures.get(username.toLowerCase());
  return !!f && f.lockedUntil > Date.now();
}
function registerFailure(username: string) {
  const key = username.toLowerCase();
  const now = Date.now();
  const f = failures.get(key);
  if (!f || now - f.first > WINDOW_MS) {
    failures.set(key, { count: 1, first: now, lockedUntil: 0 });
    return;
  }
  f.count++;
  if (f.count >= MAX_FAILS) f.lockedUntil = now + WINDOW_MS;
}
export function resetLoginFailures() {
  failures.clear();
}

export async function publicUser(userId: string) {
  return one(
    getPool(),
    `SELECT id, family_id, role, display_name, username, avatar, color, birth_year, weekly_goal_points, active, email, phone, whatsapp_consent_at, is_superadmin, terms_version, terms_accepted_at, relationship, relationship_label, is_principal, is_relative FROM users WHERE id = $1`,
    [userId],
  );
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/setup/status', async () => {
    const r = await one(getPool(), 'SELECT count(*)::int AS n FROM families');
    return { needsSetup: r.n === 0, registrationOpen: r.n === 0 || (await getSetting('registration_open')), legalVersion: LEGAL_VERSION };
  });

  app.post('/api/setup', { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } }, async (req, reply) => {
    const b = z
      .object({
        familyName: z.string().trim().min(1).max(80),
        displayName: z.string().trim().min(1).max(60),
        username: usernameSchema,
        password: adultPassword,
        email: z.string().trim().toLowerCase().email('correo no válido').max(200),
        /** Moneda de la familia: solo cambia el símbolo y el formato (se puede cambiar en Ajustes). */
        currency: z.enum(CURRENCIES).default('EUR'),
        /** Parentesco de quien crea la familia (opcional). Quien crea la familia es siempre un adulto completo. */
        relationship: relationshipSchema.optional(),
        relationshipLabel: relationshipLabelSchema.optional(),
        /** Casilla obligatoria: acepta la política de privacidad y las condiciones, también en nombre de los menores a su cargo. */
        acceptTerms: z.literal(true, { error: 'Debes aceptar la política de privacidad y las condiciones' }),
        termsVersion: z.string().max(40),
        /** Campo trampa: lo rellenan los robots, nunca una persona (está oculto). */
        website: z.string().max(200).optional(),
      })
      .parse(req.body);
    enforceLimit(req, 'setup', config.limits.setupPerHour);
    if (b.website) return { user: null }; // robot: se hace como que ha ido bien y no se crea nada
    if (b.termsVersion !== LEGAL_VERSION) throw new HttpError(409, 'Los textos legales han cambiado. Recarga la página para leerlos y aceptarlos.', 'terms_outdated');
    const created = await tx(async (db) => {
      // Bloqueo para que dos peticiones simultáneas no creen dos familias "iniciales".
      await db.query('LOCK TABLE families IN EXCLUSIVE MODE');
      const n = (await one(db, 'SELECT count(*)::int AS n FROM families')).n;
      if (n > 0 && !(await getSetting('registration_open', db))) throw forbidden('El registro de nuevas familias está cerrado');
      if (await one(db, 'SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.username])) {
        throw badRequest('Ese nombre de usuario ya existe', 'username_taken');
      }
      if (isRelativeKind(b.relationship)) throw badRequest('Quien crea la familia es madre, padre, pareja o tutor/a legal', 'relationship_invalid');
      const fam = await one(db, 'INSERT INTO families(name, currency) VALUES ($1,$2) RETURNING id', [b.familyName, b.currency]);
      const u = await one(
        db,
        `INSERT INTO users(family_id, role, display_name, username, password_hash, avatar, color, email, is_superadmin, terms_version, terms_accepted_at, is_principal, relationship)
         VALUES ($1,'adult',$2,$3,$4,'owl','indigo',$5,$6,$7, now(), true, $8) RETURNING id`,
        // Quien crea la primera familia administra la instalación; quien crea cualquier familia es su cuenta principal.
        [fam.id, b.displayName, b.username, await hashPassword(b.password), b.email, n === 0, LEGAL_VERSION, b.relationship ?? null],
      );
      await audit(db, fam.id, u.id, 'family.create', 'family', fam.id, {});
      const s = await createSession(db, u.id, req.headers['user-agent']);
      return { userId: u.id, ...s };
    });
    setSessionCookie(reply, created.token, created.expires);
    return { user: await publicUser(created.userId) };
  });

  app.post('/api/auth/login', { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200) }).parse(req.body);
    if (isLocked(body.username)) {
      throw new HttpError(429, 'Demasiados intentos fallidos. Espera 15 minutos o pide a un adulto que cambie el PIN.', 'locked');
    }
    const u = await one(
      getPool(),
      'SELECT u.id, u.password_hash, u.active, f.blocked_at FROM users u JOIN families f ON f.id = u.family_id WHERE lower(u.username) = lower($1)',
      [body.username],
    );
    if (!u) {
      await dummyVerify(body.password);
      registerFailure(body.username);
      throw unauthorized('Usuario o contraseña incorrectos');
    }
    if (!(await verifyPassword(body.password, u.password_hash)) || !u.active) {
      registerFailure(body.username);
      throw unauthorized('Usuario o contraseña incorrectos');
    }
    failures.delete(body.username.toLowerCase());
    if (u.blocked_at) throw forbidden('Esta familia está bloqueada. Contacta con quien administra DiploP.');
    await getPool().query('UPDATE users SET last_login_at = now() WHERE id = $1', [u.id]);
    const s = await createSession(getPool(), u.id, req.headers['user-agent']);
    setSessionCookie(reply, s.token, s.expires);
    return { user: await publicUser(u.id) };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const t = req.cookies[SESSION_COOKIE];
    if (t) await destroySession(getPool(), t);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => {
    const u = requireUser(req);
    const fam = await getFamily(getPool(), u.familyId);
    return { user: await publicUser(u.id), family: fam };
  });

  app.patch('/api/me', async (req) => {
    const u = requireUser(req);
    const body = z
      .object({
        avatar: z.string().max(32).optional(),
        color: z.string().max(32).optional(),
        /** Nombre y teléfono: solo los adultos (también los parientes) los cambian ellos mismos. */
        displayName: z.string().trim().min(1).max(60).optional(),
        phone: z.union([z.literal(''), phoneSchema]).nullable().optional(),
      })
      .parse(req.body);
    if ((body.displayName !== undefined || body.phone !== undefined) && u.role !== 'adult') throw forbidden('Los datos de los hijos los cambia un adulto');
    const keepPhone = body.phone === undefined;
    const tel = body.phone || null;
    await getPool().query(
      `UPDATE users SET avatar = COALESCE($2, avatar), color = COALESCE($3, color), display_name = COALESCE($4, display_name),
         phone = CASE WHEN $5 THEN phone ELSE $6 END,
         whatsapp_consent_at = CASE WHEN $5 THEN whatsapp_consent_at WHEN $6::text IS NULL THEN NULL ELSE whatsapp_consent_at END
       WHERE id = $1`,
      [u.id, body.avatar ?? null, body.color ?? null, body.displayName ?? null, keepPhone, tel],
    );
    if (body.displayName !== undefined || body.phone !== undefined) await audit(getPool(), u.familyId, u.id, 'user.profile_update', 'user', u.id, { name: body.displayName !== undefined, phone: body.phone !== undefined });
    return { user: await publicUser(u.id) };
  });

  app.put('/api/me/email', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'adult') throw forbidden('El correo de los hijos lo gestiona un adulto');
    const b = z.object({ email: z.string().trim().toLowerCase().email('correo no válido').max(200) }).parse(req.body);
    if (await one(getPool(), 'SELECT 1 FROM users WHERE lower(email) = $1 AND id <> $2', [b.email, u.id])) throw badRequest('Ese correo ya lo usa otra cuenta');
    await getPool().query('UPDATE users SET email = $2 WHERE id = $1', [u.id, b.email]);
    await audit(getPool(), u.familyId, u.id, 'user.email_change', 'user', u.id);
    return { user: await publicUser(u.id) };
  });

  app.post('/api/me/password', { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireUser(req);
    const body = z.object({ current: z.string().min(1), next: z.string().max(200) }).parse(req.body);
    (u.role === 'adult' ? adultPassword : childSecret).parse(body.next);
    const row = await one(getPool(), 'SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (!(await verifyPassword(body.current, row.password_hash))) throw badRequest('La contraseña actual no es correcta');
    await getPool().query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(body.next)]);
    // Cierra el resto de sesiones.
    await getPool().query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> encode(sha256(convert_to($2, \'UTF8\')), \'hex\')', [u.id, req.cookies[SESSION_COOKIE] ?? '']);
    await audit(getPool(), u.familyId, u.id, 'user.password_change', 'user', u.id);
    return { ok: true };
  });
}
