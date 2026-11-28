import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one } from '../lib/db.js';
import { requireAdult, requireUser, type AuthUser } from '../lib/auth.js';
import { forbidden, notFound } from '../lib/errors.js';
import { familyToday, getFamily, pointsToCents, type Family } from '../lib/family.js';
import { addDays, addMonthsStart, periodBounds, startOfWeek } from '../lib/dates.js';
import { ensureInstancesThrottled } from '../lib/instances.js';
import { BADGES, badgeText, computeStreak, levelFor, lifetimePoints, pointsEarnedBetween } from '../lib/gamification.js';
import { walletSummary } from '../lib/money.js';

const ASSIGNED = `(i.assignee_id = $U OR i.completed_by = $U OR (i.assignee_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = $U)))`;
/** Lo que cuenta para el % cumplido y el «hoy»: ni los trabajos extra, ni las repeticiones, ni las de «cuando haga falta» aún sin hacer. */
const COUNTED = `NOT i.is_extra AND i.repeat_no = 1 AND NOT (i.status = 'pending' AND EXISTS (SELECT 1 FROM tasks tn WHERE tn.id = i.task_id AND tn.recurrence = 'as_needed'))`;
const assigned = (param: string) => ASSIGNED.replaceAll('$U', param);

export async function progressFor(fam: Family, userId: string) {
  const db = getPool();
  const today = familyToday(fam);
  const user = await one(db, 'SELECT id, display_name, avatar, color, weekly_goal_points FROM users WHERE id = $1', [userId]);
  const weekStart = startOfWeek(today);
  const period = periodBounds(fam.settlement_period, today);
  const [lifetime, weekPoints, streak, badges, potential] = await Promise.all([
    lifetimePoints(db, userId),
    pointsEarnedBetween(db, userId, weekStart, today, fam.timezone),
    computeStreak(db, userId, today),
    many(db, 'SELECT badge, awarded_at FROM user_badges WHERE user_id = $1', [userId]),
    one(
      db,
      `SELECT COALESCE(SUM(i.points),0)::int AS max,
              COALESCE(SUM(i.points) FILTER (WHERE i.status = 'approved'),0)::int AS earned,
              COALESCE(SUM(i.points) FILTER (WHERE i.status IN ('expired','rejected','declined') AND i.due_date < $4),0)::int AS missed,
              COALESCE(SUM(i.points) FILTER (WHERE i.status = 'submitted'),0)::int AS waiting
         FROM task_instances i WHERE i.family_id = $2 AND i.due_date BETWEEN $3 AND $5 AND ${assigned('$1')} AND ${COUNTED}
          AND (i.assignee_id IS NOT NULL OR i.completed_by IS NULL OR i.completed_by = $1)`,
      [userId, fam.id, period.start, today, period.end],
    ),
  ]);
  const earnedMap = new Map(badges.map((b) => [b.badge, b.awarded_at]));
  return {
    user,
    level: levelFor(lifetime),
    lifetimePoints: lifetime,
    streak,
    week: { start: weekStart, points: weekPoints, goal: user.weekly_goal_points, cents: pointsToCents(fam, Math.max(0, weekPoints)) },
    period: {
      ...period,
      type: fam.settlement_period,
      maxPoints: potential.max,
      earnedPoints: potential.earned,
      missedPoints: potential.missed,
      waitingPoints: potential.waiting,
      maxCents: Math.min(pointsToCents(fam, potential.max), fam.cap_cents ?? Infinity),
      earnedCents: pointsToCents(fam, potential.earned),
    },
    badges: Object.entries(BADGES).map(([key, b]) => ({ key, ...b, description: badgeText(b.description, fam.currency), awardedAt: earnedMap.get(key) ?? null })),
  };
}

function assertSelfOrAdult(u: AuthUser, userId: string) {
  if (u.role === 'child' && u.id !== userId) throw forbidden();
}

/** Sobre quién recae una acción del historial: el hijo indicado en los datos o, si la entidad es un usuario, ese usuario. */
const FOR_USER = `COALESCE(NULLIF(a.data->>'for', '')::uuid, CASE WHEN a.entity = 'user' THEN a.entity_id END)`;

export default async function insightRoutes(app: FastifyInstance) {
  app.get('/api/progress/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    assertSelfOrAdult(u, userId);
    const m = await one(getPool(), `SELECT 1 FROM users WHERE id = $1 AND family_id = $2 AND role = 'child'`, [userId, u.familyId]);
    if (!m) throw notFound('Miembro no encontrado');
    await ensureInstancesThrottled(getPool(), u.familyId);
    const fam = await getFamily(getPool(), u.familyId);
    return progressFor(fam, userId);
  });

  app.get('/api/leaderboard', async (req) => {
    const u = requireUser(req);
    const fam = await getFamily(getPool(), u.familyId);
    if (!fam.leaderboard_enabled) return { enabled: false, entries: [] };
    const today = familyToday(fam);
    const rows = await many(
      getPool(),
      `SELECT u.id, u.display_name, u.avatar, u.color, u.weekly_goal_points,
              COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = u.id AND l.kind IN ('task','bonus','adjustment')
                         AND (l.created_at AT TIME ZONE $3)::date >= $2), 0)::int AS points
         FROM users u WHERE u.family_id = $1 AND u.role = 'child' AND u.active ORDER BY points DESC, u.display_name`,
      [u.familyId, startOfWeek(today), fam.timezone],
    );
    return { enabled: true, weekStart: startOfWeek(today), entries: rows };
  });

  app.get('/api/dashboard', async (req) => {
    const u = requireAdult(req);
    const db = getPool();
    await ensureInstancesThrottled(db, u.familyId);
    const fam = await getFamily(db, u.familyId);
    const today = familyToday(fam);
    const children = await many(db, `SELECT id, display_name, avatar, color, weekly_goal_points FROM users WHERE family_id = $1 AND role = 'child' AND active ORDER BY created_at`, [u.familyId]);
    const kids = await Promise.all(
      children.map(async (c) => {
        const [todayStats, weekPoints, wallet, streak] = await Promise.all([
          one(
            db,
            `SELECT count(*)::int AS total,
                    count(*) FILTER (WHERE i.status = 'approved')::int AS approved,
                    count(*) FILTER (WHERE i.status = 'submitted')::int AS submitted,
                    count(*) FILTER (WHERE i.status IN ('pending','rejected'))::int AS pending
               FROM task_instances i WHERE i.family_id = $2 AND i.due_date = $3 AND ${assigned('$1')} AND ${COUNTED}
                AND (i.assignee_id IS NOT NULL OR i.completed_by IS NULL OR i.completed_by = $1)`,
            [c.id, u.familyId, today],
          ),
          pointsEarnedBetween(db, c.id, startOfWeek(today), today, fam.timezone),
          walletSummary(db, u.familyId, c.id),
          computeStreak(db, c.id, today),
        ]);
        return { ...c, today: todayStats, weekPoints, weekCents: pointsToCents(fam, Math.max(0, weekPoints)), wallet, streak };
      }),
    );
    const [pendingApprovals, pendingRedemptions, overdue, pendingChecks, pendingGrants, pendingRequests, pendingUsage, pendingBank, pendingProposals, activity] = await Promise.all([
      many(
        db,
        `SELECT i.id, i.due_date, i.points, i.completed_at, i.child_note, (i.photo_path IS NOT NULL) AS has_photo, t.title, t.icon,
                cu.id AS user_id, cu.display_name, cu.avatar, cu.color
           FROM task_instances i JOIN tasks t ON t.id = i.task_id LEFT JOIN users cu ON cu.id = i.completed_by
          WHERE i.family_id = $1 AND i.status = 'submitted' ORDER BY i.completed_at LIMIT 50`,
        [u.familyId],
      ),
      one(db, `SELECT count(*)::int AS n FROM redemptions WHERE family_id = $1 AND status = 'requested'`, [u.familyId]),
      // Las tareas de comprobación no cumplidas quedan como «vencidas» pero no se pueden «dar por hechas»: no cuentan aquí.
      one(db, `SELECT count(*)::int AS n FROM task_instances i JOIN tasks t ON t.id = i.task_id WHERE i.family_id = $1 AND i.status = 'expired' AND i.due_date >= $2 AND NOT t.check_mode`, [u.familyId, addDays(today, -7)]),
      one(db, `SELECT count(*)::int AS n FROM task_instances i JOIN tasks t ON t.id = i.task_id WHERE i.family_id = $1 AND t.check_mode AND i.check_met IS NULL AND i.status IN ('pending','expired') AND i.due_date BETWEEN $2 AND $3`, [u.familyId, addDays(today, -7), today]),
      one(db, `SELECT count(*)::int AS n FROM bonus_grants WHERE family_id = $1 AND kind IN ('text','reward') AND fulfilled_at IS NULL AND voided_at IS NULL`, [u.familyId]),
      one(db, `SELECT ((SELECT count(*) FROM payout_requests WHERE family_id = $1 AND status = 'pending') + (SELECT count(*) FROM screen_sessions WHERE family_id = $1 AND status = 'pending') + (SELECT count(*) FROM screen_blocks WHERE family_id = $1 AND status = 'active' AND challenge_status = 'submitted'))::int AS n`, [u.familyId]),
      one(db, `SELECT count(*)::int AS n FROM screen_usage_logs WHERE family_id = $1 AND status = 'pending'`, [u.familyId]),
      one(db, `SELECT ((SELECT count(*) FROM loans WHERE family_id = $1 AND status = 'pending') + (SELECT count(*) FROM goal_requests WHERE family_id = $1 AND status = 'pending') + (SELECT count(*) FROM savings_goals WHERE family_id = $1 AND NOT archived AND (status = 'proposed' OR (status = 'active' AND auto_pending_percent IS NOT NULL))))::int AS n`, [u.familyId]),
      one(db, `SELECT count(*)::int AS n FROM catalog_proposals WHERE family_id = $1 AND status = 'pending'`, [u.familyId]),
      many(
        db,
        `SELECT a.id, a.action, a.entity, a.data, a.created_at, u.display_name AS actor_name, u.avatar AS actor_avatar, u.color AS actor_color, fu.display_name AS for_name
           FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id LEFT JOIN users fu ON fu.family_id = a.family_id AND fu.id = ${FOR_USER}
          WHERE a.family_id = $1 ORDER BY a.created_at DESC LIMIT 15`,
        [u.familyId],
      ),
    ]);
    return {
      today,
      family: fam,
      kids,
      pendingApprovals,
      pendingRedemptions: pendingRedemptions.n,
      overdueLastWeek: overdue.n,
      pendingChecks: pendingChecks.n,
      pendingGrants: pendingGrants.n,
      pendingRequests: pendingRequests.n,
      pendingUsage: pendingUsage.n,
      pendingBank: pendingBank.n,
      pendingProposals: pendingProposals.n,
      activity,
      totals: {
        weekCents: kids.reduce((s, k) => s + k.weekCents, 0),
        pendingCents: kids.reduce((s, k) => s + k.wallet.cents_pending, 0),
        owedCents: kids.reduce((s, k) => s + k.wallet.cents_pending + k.wallet.cents_savings, 0),
      },
    };
  });

  app.get('/api/stats', async (req) => {
    const u = requireUser(req);
    const q = z.object({ range: z.enum(['weeks', 'months']).default('weeks'), userId: z.string().uuid().optional() }).parse(req.query);
    if (q.userId) assertSelfOrAdult(u, q.userId);
    const fam = await getFamily(getPool(), u.familyId);
    const today = familyToday(fam);
    const n = q.range === 'weeks' ? 8 : 6;
    const first = q.range === 'weeks' ? addDays(startOfWeek(today), -7 * (n - 1)) : addMonthsStart(today, -(n - 1));
    const unit = q.range === 'weeks' ? 'week' : 'month';
    const who = u.role === 'child' ? u.id : q.userId ?? null;
    const rows = await many(
      getPool(),
      `WITH buckets AS (SELECT generate_series(date_trunc($3, $2::date), date_trunc($3, $4::date), ('1 ' || $3)::interval)::date AS b),
            kids AS (SELECT id, display_name, color FROM users WHERE family_id = $1 AND role = 'child' AND active AND ($5::uuid IS NULL OR id = $5))
       SELECT k.id AS user_id, k.display_name, k.color, b.b AS bucket,
              COALESCE((SELECT SUM(delta) FROM points_ledger l WHERE l.user_id = k.id AND l.kind IN ('task','bonus','adjustment')
                         AND date_trunc($3, (l.created_at AT TIME ZONE $6))::date = b.b), 0)::int AS points,
              COALESCE((SELECT count(*) FROM task_instances i WHERE i.status = 'approved' AND (i.assignee_id = k.id OR i.completed_by = k.id)
                         AND date_trunc($3, i.due_date)::date = b.b), 0)::int AS tasks
         FROM kids k CROSS JOIN buckets b ORDER BY k.display_name, b.b`,
      [u.familyId, first, unit, today, who, fam.timezone],
    );
    return { range: q.range, rows };
  });

  // Historial. Los adultos ven todo lo de la familia; un hijo, solo lo que ha hecho él (nada de lo que otros adultos hacen sobre
  // sus hermanos, como los ajustes de pantalla).
  app.get('/api/activity', async (req) => {
    const u = requireUser(req);
    const q = z.object({ before: z.coerce.number().int().optional() }).parse(req.query);
    const rows = await many(
      getPool(),
      `SELECT a.id, a.action, a.entity, a.entity_id, a.data, a.created_at, u.display_name AS actor_name, fu.display_name AS for_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
         LEFT JOIN users fu ON fu.family_id = a.family_id AND fu.id = ${FOR_USER}
        WHERE a.family_id = $1 AND ($2::bigint IS NULL OR a.id < $2) AND ($3::uuid IS NULL OR a.actor_id = $3)
        ORDER BY a.id DESC LIMIT 100`,
      [u.familyId, q.before ?? null, u.role === 'child' ? u.id : null],
    );
    return { entries: rows };
  });

  app.get('/api/notifications', async (req) => {
    const u = requireUser(req);
    await ensureInstancesThrottled(getPool(), u.familyId);
    const rows = await many(getPool(), 'SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [u.id]);
    return { notifications: rows, unread: rows.filter((r) => !r.read_at).length };
  });

  app.post('/api/notifications/read', async (req) => {
    const u = requireUser(req);
    const b = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    await getPool().query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))',
      [u.id, b.ids ?? null],
    );
    return { ok: true };
  });
}
