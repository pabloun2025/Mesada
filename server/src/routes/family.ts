import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { hashPassword, requireAdult, requireUser } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { getFamily } from '../lib/family.js';
import { adultPassword, childSecret, publicUser, resetLoginFailures, usernameSchema } from './auth.js';
import { invalidateThrottle } from '../lib/instances.js';

const memberFields = {
  displayName: z.string().trim().min(1).max(60),
  avatar: z.string().max(32).optional(),
  color: z.string().max(32).optional(),
  birthYear: z.number().int().min(1900).max(2100).nullable().optional(),
  weeklyGoalPoints: z.number().int().min(0).max(100000).optional(),
};

export default async function familyRoutes(app: FastifyInstance) {
  app.get('/api/family', async (req) => {
    const u = requireUser(req);
    const fam = await getFamily(getPool(), u.familyId);
    const members = await many(
      getPool(),
      `SELECT id, role, display_name, username, avatar, color, birth_year, weekly_goal_points, active
         FROM users WHERE family_id = $1 ${u.role === 'child' ? 'AND active' : ''} ORDER BY role, created_at`,
      [u.familyId],
    );
    // Los hijos no necesitan ver los nombres de usuario de los demás.
    return { family: fam, members: u.role === 'adult' ? members : members.map(({ username, ...m }) => (m.id === u.id ? { ...m, username } : m)) };
  });

  app.patch('/api/family', async (req) => {
    const u = requireAdult(req);
    const b = z
      .object({
        name: z.string().trim().min(1).max(80).optional(),
        ratePoints: z.number().int().min(1).max(100000).optional(),
        rateCents: z.number().int().min(0).max(1000000).optional(),
        settlementPeriod: z.enum(['week', 'month']).optional(),
        capCents: z.number().int().min(0).max(10000000).nullable().optional(),
        leaderboardEnabled: z.boolean().optional(),
        celebrationsEnabled: z.boolean().optional(),
        timezone: z.string().max(64).optional(),
      })
      .parse(req.body);
    if (b.timezone) {
      try {
        new Intl.DateTimeFormat('es', { timeZone: b.timezone });
      } catch {
        throw badRequest('Zona horaria no válida');
      }
    }
    const before = await getFamily(getPool(), u.familyId);
    await getPool().query(
      `UPDATE families SET
         name = COALESCE($2, name), rate_points = COALESCE($3, rate_points), rate_cents = COALESCE($4, rate_cents),
         settlement_period = COALESCE($5, settlement_period),
         cap_cents = CASE WHEN $6::boolean THEN $7 ELSE cap_cents END,
         leaderboard_enabled = COALESCE($8, leaderboard_enabled), celebrations_enabled = COALESCE($9, celebrations_enabled),
         timezone = COALESCE($10, timezone)
       WHERE id = $1`,
      [u.familyId, b.name ?? null, b.ratePoints ?? null, b.rateCents ?? null, b.settlementPeriod ?? null, b.capCents !== undefined, b.capCents ?? null, b.leaderboardEnabled ?? null, b.celebrationsEnabled ?? null, b.timezone ?? null],
    );
    const after = await getFamily(getPool(), u.familyId);
    await audit(getPool(), u.familyId, u.id, 'family.update', 'family', u.familyId, { before, after });
    return { family: after };
  });

  app.post('/api/members', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ role: z.enum(['adult', 'child']), username: usernameSchema, password: z.string().max(200), ...memberFields }).parse(req.body);
    (b.role === 'adult' ? adultPassword : childSecret).parse(b.password);
    const id = await tx(async (db) => {
      if (await one(db, 'SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.username])) throw badRequest('Ese nombre de usuario ya existe', 'username_taken');
      const r = await one(
        db,
        `INSERT INTO users(family_id, role, display_name, username, password_hash, avatar, color, birth_year, weekly_goal_points)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'fox'),COALESCE($7,'teal'),$8,COALESCE($9,0)) RETURNING id`,
        [u.familyId, b.role, b.displayName, b.username, await hashPassword(b.password), b.avatar ?? null, b.color ?? null, b.birthYear ?? null, b.weeklyGoalPoints ?? null],
      );
      await audit(db, u.familyId, u.id, 'member.create', 'user', r.id, { role: b.role, displayName: b.displayName });
      return r.id as string;
    });
    return { member: await publicUser(id) };
  });

  app.patch('/api/members/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({ ...memberFields, displayName: memberFields.displayName.optional(), active: z.boolean().optional(), password: z.string().max(200).optional() })
      .parse(req.body);
    const m = await one(getPool(), 'SELECT id, role FROM users WHERE id = $1 AND family_id = $2', [id, u.familyId]);
    if (!m) throw notFound('Miembro no encontrado');
    if (b.active === false && id === u.id) throw badRequest('No puedes desactivar tu propia cuenta');
    if (b.active === false && m.role === 'adult') {
      const n = (await one(getPool(), `SELECT count(*)::int AS n FROM users WHERE family_id = $1 AND role = 'adult' AND active`, [u.familyId])).n;
      if (n <= 1) throw badRequest('Debe quedar al menos un adulto activo');
    }
    let hash: string | null = null;
    if (b.password) {
      (m.role === 'adult' ? adultPassword : childSecret).parse(b.password);
      hash = await hashPassword(b.password);
    }
    await getPool().query(
      `UPDATE users SET display_name = COALESCE($2, display_name), avatar = COALESCE($3, avatar), color = COALESCE($4, color),
         birth_year = CASE WHEN $5::boolean THEN $6 ELSE birth_year END, weekly_goal_points = COALESCE($7, weekly_goal_points),
         active = COALESCE($8, active), password_hash = COALESCE($9, password_hash)
       WHERE id = $1`,
      [id, b.displayName ?? null, b.avatar ?? null, b.color ?? null, b.birthYear !== undefined, b.birthYear ?? null, b.weeklyGoalPoints ?? null, b.active ?? null, hash],
    );
    if (hash || b.active === false) await getPool().query('DELETE FROM sessions WHERE user_id = $1', [id]);
    if (hash) resetLoginFailures();
    invalidateThrottle(u.familyId);
    await audit(getPool(), u.familyId, u.id, 'member.update', 'user', id, { ...b, password: b.password ? '***' : undefined });
    return { member: await publicUser(id) };
  });
}
