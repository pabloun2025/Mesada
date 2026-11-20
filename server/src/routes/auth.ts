import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, one, tx } from '../lib/db.js';
import { config } from '../lib/config.js';
import {
  createSession, destroySession, dummyVerify, hashPassword, requireUser, SESSION_COOKIE, setSessionCookie, verifyPassword,
} from '../lib/auth.js';
import { badRequest, forbidden, unauthorized } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getFamily } from '../lib/family.js';

export const usernameSchema = z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9._-]+$/, 'solo letras, números, punto, guion y guion bajo');
export const adultPassword = z.string().min(8, 'mínimo 8 caracteres').max(200);
export const childSecret = z.string().min(4, 'mínimo 4 caracteres').max(200);

export async function publicUser(userId: string) {
  return one(
    getPool(),
    `SELECT id, family_id, role, display_name, username, avatar, color, birth_year, weekly_goal_points, active FROM users WHERE id = $1`,
    [userId],
  );
}

export default async function authRoutes(app: FastifyInstance) {
  app.get('/api/setup/status', async () => {
    const r = await one(getPool(), 'SELECT count(*)::int AS n FROM families');
    return { needsSetup: r.n === 0, registrationOpen: r.n === 0 || config.allowRegistration };
  });

  app.post('/api/setup', { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = z
      .object({
        familyName: z.string().trim().min(1).max(80),
        displayName: z.string().trim().min(1).max(60),
        username: usernameSchema,
        password: adultPassword,
      })
      .parse(req.body);
    const created = await tx(async (db) => {
      // Bloqueo para que dos peticiones simultáneas no creen dos familias "iniciales".
      await db.query('LOCK TABLE families IN EXCLUSIVE MODE');
      const n = (await one(db, 'SELECT count(*)::int AS n FROM families')).n;
      if (n > 0 && !config.allowRegistration) throw forbidden('El registro de nuevas familias está cerrado');
      if (await one(db, 'SELECT 1 FROM users WHERE lower(username) = lower($1)', [body.username])) {
        throw badRequest('Ese nombre de usuario ya existe', 'username_taken');
      }
      const fam = await one(db, 'INSERT INTO families(name) VALUES ($1) RETURNING id', [body.familyName]);
      const u = await one(
        db,
        `INSERT INTO users(family_id, role, display_name, username, password_hash, avatar, color) VALUES ($1,'adult',$2,$3,$4,'owl','indigo') RETURNING id`,
        [fam.id, body.displayName, body.username, await hashPassword(body.password)],
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
    const u = await one(getPool(), 'SELECT id, password_hash, active FROM users WHERE lower(username) = lower($1)', [body.username]);
    if (!u) {
      await dummyVerify(body.password);
      throw unauthorized('Usuario o contraseña incorrectos');
    }
    if (!(await verifyPassword(body.password, u.password_hash)) || !u.active) throw unauthorized('Usuario o contraseña incorrectos');
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
    const body = z.object({ avatar: z.string().max(32).optional(), color: z.string().max(32).optional() }).parse(req.body);
    await getPool().query('UPDATE users SET avatar = COALESCE($2, avatar), color = COALESCE($3, color) WHERE id = $1', [u.id, body.avatar ?? null, body.color ?? null]);
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
