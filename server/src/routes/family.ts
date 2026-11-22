import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { hashPassword, requireAdult, requirePrincipal, requireUser, verifyPassword } from '../lib/auth.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { getFamily } from '../lib/family.js';
import { adultPassword, childSecret, publicUser, resetLoginFailures, usernameSchema } from './auth.js';
import { CURRENCIES } from '../lib/currency.js';
import { isRelativeKind } from '../lib/kinship.js';
import { relationshipLabelSchema, relationshipSchema } from '../lib/schemas.js';
import { notify } from '../lib/notify/dispatch.js';
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
      `SELECT id, role, display_name, username, avatar, color, birth_year, weekly_goal_points, active, phone, email, whatsapp_consent_at,
              relationship, relationship_label, is_principal, is_relative
         FROM users WHERE family_id = $1 ${u.role === 'child' ? 'AND active' : ''} ORDER BY role, created_at`,
      [u.familyId],
    );
    // Los hijos no necesitan ver los usuarios ni los teléfonos de los demás.
    return {
      family: fam,
      members: u.role === 'adult' && !u.isRelative ? members : members.map(({ username, phone, email, whatsapp_consent_at, ...m }) => (m.id === u.id ? { ...m, username } : m)),
    };
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
        currency: z.enum(CURRENCIES).optional(),
        bankExchangeEnabled: z.boolean().optional(),
        bankExchangeMinPoints: z.number().int().min(1).max(100000).optional(),
        bankWithdrawEnabled: z.boolean().optional(),
        bankWithdrawPerWeek: z.number().int().min(1).max(14).optional(),
        bankAdvanceEnabled: z.boolean().optional(),
        bankAdvancePercent: z.number().int().min(1).max(100).optional(),
        bankLoanEnabled: z.boolean().optional(),
        bankLoanMaxPercent: z.number().int().min(1).max(1000).optional(),
        bankLoanMaxWeeks: z.number().int().min(1).max(52).optional(),
        bankLoanInterestPoints: z.number().int().min(0).max(1000).optional(),
        bankSavingsEnabled: z.boolean().optional(),
        bankSavingsRatePercent: z.number().min(0.01).max(100).optional(),
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
         timezone = COALESCE($10, timezone), currency = COALESCE($11, currency)
       WHERE id = $1`,
      [u.familyId, b.name ?? null, b.ratePoints ?? null, b.rateCents ?? null, b.settlementPeriod ?? null, b.capCents !== undefined, b.capCents ?? null, b.leaderboardEnabled ?? null, b.celebrationsEnabled ?? null, b.timezone ?? null, b.currency ?? null],
    );
    // Ajustes del banco: columna por campo, solo los que llegan.
    const bankCols: Record<string, string> = {
      bankExchangeEnabled: 'bank_exchange_enabled', bankExchangeMinPoints: 'bank_exchange_min_points', bankWithdrawEnabled: 'bank_withdraw_enabled',
      bankWithdrawPerWeek: 'bank_withdraw_per_week', bankAdvanceEnabled: 'bank_advance_enabled', bankAdvancePercent: 'bank_advance_percent',
      bankLoanEnabled: 'bank_loan_enabled', bankLoanMaxPercent: 'bank_loan_max_percent', bankLoanMaxWeeks: 'bank_loan_max_weeks',
      bankLoanInterestPoints: 'bank_loan_interest_points', bankSavingsEnabled: 'bank_savings_enabled', bankSavingsRatePercent: 'bank_savings_rate_percent',
    };
    for (const [key, col] of Object.entries(bankCols)) {
      const v = (b as Record<string, unknown>)[key];
      if (v !== undefined) await getPool().query(`UPDATE families SET ${col} = $2 WHERE id = $1`, [u.familyId, v]);
    }
    const after = await getFamily(getPool(), u.familyId);
    await audit(getPool(), u.familyId, u.id, 'family.update', 'family', u.familyId, { before, after });
    return { family: after };
  });

  app.post('/api/members', async (req) => {
    const u = requireAdult(req);
    const b = z
      .object({ role: z.enum(['adult', 'child']), username: usernameSchema, password: z.string().max(200), relationship: relationshipSchema.optional(), relationshipLabel: relationshipLabelSchema.optional(), ...memberFields })
      .parse(req.body);
    // Añadir adultos y parientes es cosa de la cuenta principal (D59). La vía normal es la invitación por correo.
    if (b.role === 'adult') requirePrincipal(req);
    (b.role === 'adult' ? adultPassword : childSecret).parse(b.password);
    const id = await tx(async (db) => {
      const count = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users WHERE family_id = $1', [u.familyId]))!.n;
      if (count >= config.caps.maxMembers) throw conflict(`Una familia puede tener hasta ${config.caps.maxMembers} personas. Borra a quien ya no use la app.`, 'too_many_members');
      if (await one(db, 'SELECT 1 FROM users WHERE lower(username) = lower($1)', [b.username])) throw badRequest('Ese nombre de usuario ya existe', 'username_taken');
      const r = await one(
        db,
        `INSERT INTO users(family_id, role, display_name, username, password_hash, avatar, color, birth_year, weekly_goal_points, relationship, relationship_label)
         VALUES ($1,$2,$3,$4,$5,COALESCE($6,'fox'),COALESCE($7,'teal'),$8,COALESCE($9,0),$10,$11) RETURNING id`,
        [u.familyId, b.role, b.displayName, b.username, await hashPassword(b.password), b.avatar ?? null, b.color ?? null, b.birthYear ?? null, b.weeklyGoalPoints ?? null,
          b.role === 'adult' ? (b.relationship ?? 'partner') : null, b.role === 'adult' && b.relationship === 'other' ? (b.relationshipLabel || null) : null],
      );
      await audit(db, u.familyId, u.id, 'member.create', 'user', r.id, { role: b.role, displayName: b.displayName, relationship: b.role === 'adult' ? (b.relationship ?? 'partner') : undefined });
      return r.id as string;
    });
    return { member: await publicUser(id) };
  });

  app.patch('/api/members/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        ...memberFields, displayName: memberFields.displayName.optional(), active: z.boolean().optional(), password: z.string().max(200).optional(),
        relationship: relationshipSchema.optional(), relationshipLabel: relationshipLabelSchema.nullable().optional(),
      })
      .parse(req.body);
    const m = await one(getPool(), 'SELECT id, role, is_principal FROM users WHERE id = $1 AND family_id = $2', [id, u.familyId]);
    if (!m) throw notFound('Miembro no encontrado');
    // Tocar a otro adulto (o quitarlo) es solo de la cuenta principal; cada uno edita su propio perfil en Mi perfil.
    if (m.role === 'adult' && id !== u.id) requirePrincipal(req);
    if (m.role === 'adult' && (b.relationship !== undefined || b.relationshipLabel !== undefined)) {
      requirePrincipal(req);
      if (m.is_principal && isRelativeKind(b.relationship)) throw badRequest('La cuenta principal no puede ser pariente. Cede antes el papel.', 'relationship_invalid');
    }
    if (m.role === 'child' && b.relationship !== undefined) throw badRequest('Los hijos no tienen parentesco');
    if (b.active === false && id === u.id) throw badRequest('No puedes desactivar tu propia cuenta');
    if (b.active === false && m.is_principal) throw badRequest('Cede antes el papel de cuenta principal');
    if (b.active === false && m.role === 'adult') {
      const n = (await one(getPool(), `SELECT count(*)::int AS n FROM users WHERE family_id = $1 AND role = 'adult' AND active AND NOT is_relative`, [u.familyId])).n;
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
         active = COALESCE($8, active), password_hash = COALESCE($9, password_hash),
         relationship = COALESCE($10, relationship),
         relationship_label = CASE WHEN $10::text IS NOT NULL THEN CASE WHEN $10 = 'other' THEN $11 ELSE NULL END WHEN $12::boolean THEN $11 ELSE relationship_label END
       WHERE id = $1`,
      [id, b.displayName ?? null, b.avatar ?? null, b.color ?? null, b.birthYear !== undefined, b.birthYear ?? null, b.weeklyGoalPoints ?? null, b.active ?? null, hash,
        b.relationship ?? null, b.relationshipLabel || null, b.relationshipLabel !== undefined],
    );
    if (hash || b.active === false) await getPool().query('DELETE FROM sessions WHERE user_id = $1', [id]);
    if (hash) resetLoginFailures();
    invalidateThrottle(u.familyId);
    await audit(getPool(), u.familyId, u.id, 'member.update', 'user', id, { ...b, password: b.password ? '***' : undefined });
    return { member: await publicUser(id) };
  });

  /** La cuenta principal cede el papel a otro adulto completo (pide su contraseña). */
  app.post('/api/family/principal', async (req) => {
    const u = requirePrincipal(req);
    const b = z.object({ userId: z.string().uuid(), password: z.string().min(1).max(200) }).parse(req.body);
    const me = await one(getPool(), 'SELECT password_hash FROM users WHERE id = $1', [u.id]);
    if (!(await verifyPassword(b.password, me.password_hash))) throw badRequest('La contraseña no es correcta');
    if (b.userId === u.id) throw badRequest('Elige a otro adulto');
    await tx(async (db) => {
      const t = await one(db, `SELECT id, display_name FROM users WHERE id = $1 AND family_id = $2 AND role = 'adult' AND active AND NOT is_relative FOR UPDATE`, [b.userId, u.familyId]);
      if (!t) throw badRequest('Solo puedes ceder el papel a otro adulto completo (madre, padre, pareja o tutor/a legal)', 'not_full_adult');
      await db.query('UPDATE users SET is_principal = false WHERE id = $1', [u.id]);
      await db.query('UPDATE users SET is_principal = true WHERE id = $1', [t.id]);
      await audit(db, u.familyId, u.id, 'family.principal_transfer', 'user', t.id, { to: t.display_name });
      await notify(db, { userId: t.id, event: 'family_change', title: `${u.displayName} te ha cedido la cuenta principal`, body: 'Ahora puedes añadir y quitar adultos y parientes.', link: '/familia', dedupeKey: `principal:${t.id}:${Date.now()}` });
    });
    return { ok: true };
  });
}
