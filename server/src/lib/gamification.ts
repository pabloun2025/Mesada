import { many, one, type Db } from './db.js';
import { addDays, startOfWeek } from './dates.js';
import { notify } from './notify/dispatch.js';
import { LIFETIME_POINTS_SQL } from './ledger.js';

export const LEVEL_TITLES = ['Novato', 'Aprendiz', 'Colaborador', 'Constante', 'Fiable', 'Experto', 'Crack', 'Maestro', 'Referente', 'Leyenda'];

/** Nivel según puntos ganados de por vida: nivel n requiere 25·(n-1)² puntos. */
export function levelFor(lifetime: number) {
  const level = Math.floor(Math.sqrt(Math.max(0, lifetime) / 25)) + 1;
  const floor = 25 * (level - 1) ** 2;
  const next = 25 * level ** 2;
  return {
    level,
    title: LEVEL_TITLES[Math.min(level - 1, LEVEL_TITLES.length - 1)],
    current: lifetime - floor,
    needed: next - floor,
    nextAt: next,
  };
}

export const BADGES: Record<string, { title: string; description: string; icon: string }> = {
  first_task: { title: 'Primera tarea', description: 'Completaste tu primera tarea aprobada', icon: '🌱' },
  tasks_10: { title: 'En marcha', description: '10 tareas aprobadas', icon: '🚲' },
  tasks_50: { title: 'Imparable', description: '50 tareas aprobadas', icon: '🚀' },
  tasks_100: { title: 'Centenario', description: '100 tareas aprobadas', icon: '💯' },
  streak_3: { title: 'Tres seguidos', description: 'Racha de 3 días', icon: '🔥' },
  streak_7: { title: 'Semana redonda', description: 'Racha de 7 días', icon: '📅' },
  streak_30: { title: 'Hábito de hierro', description: 'Racha de 30 días', icon: '🏆' },
  weekly_goal: { title: 'Objetivo cumplido', description: 'Alcanzaste tu objetivo semanal', icon: '🎯' },
  first_reward: { title: 'Primer capricho', description: 'Canjeaste tu primera recompensa', icon: '🎁' },
  saver: { title: 'Ahorrador', description: 'Tienes 10 € o más en la hucha', icon: '🐷' },
};

export async function lifetimePoints(db: Db, userId: string) {
  const r = await one<{ p: number }>(
    db,
    `SELECT ${LIFETIME_POINTS_SQL} AS p FROM points_ledger WHERE user_id = $1`,
    [userId],
  );
  return r!.p;
}

export async function pointsEarnedBetween(db: Db, userId: string, from: string, to: string, tz: string) {
  const r = await one<{ p: number }>(
    db,
    `SELECT COALESCE(SUM(delta),0)::int AS p FROM points_ledger
      WHERE user_id = $1 AND kind IN ('task','bonus','adjustment')
        AND (created_at AT TIME ZONE $4)::date BETWEEN $2 AND $3`,
    [userId, from, to, tz],
  );
  return r!.p;
}

/**
 * Racha: días consecutivos con al menos una tarea hecha. Los días sin tareas asignadas son neutros
 * (no suman ni rompen). Se rompe un día que tenía tareas y no se hizo ninguna. Hoy solo suma si ya hay algo hecho.
 */
export async function computeStreak(db: Db, userId: string, today: string): Promise<number> {
  const from = addDays(today, -400);
  const rows = await many<{ d: string; assigned: number; done: number }>(
    db,
    `SELECT i.due_date AS d,
            count(*)::int AS assigned,
            count(*) FILTER (WHERE i.status IN ('submitted','approved') AND (i.assignee_id = $1 OR i.completed_by = $1))::int AS done
       FROM task_instances i JOIN tasks t ON t.id = i.task_id
      WHERE i.due_date BETWEEN $2 AND $3
        AND NOT i.is_extra AND i.repeat_no = 1 AND (t.recurrence <> 'as_needed' OR i.completed_by = $1) -- lo opcional no rompe la racha
        AND (i.assignee_id = $1 OR (i.assignee_id IS NULL AND (i.completed_by = $1 OR EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = $1))))
      GROUP BY i.due_date`,
    [userId, from, today],
  );
  const byDay = new Map(rows.map((r) => [r.d, r]));
  let streak = 0;
  for (let d = today; d >= from; d = addDays(d, -1)) {
    const r = byDay.get(d);
    if (!r || r.assigned === 0) continue; // neutro
    if (r.done > 0) streak++;
    else if (d === today) continue; // hoy aún hay tiempo
    else break;
  }
  return streak;
}

/** Insignias que se ganan con tareas hechas: son las únicas que se retiran al desmarcar una tarea (D55). */
const TASK_BADGES = ['first_task', 'tasks_10', 'tasks_50', 'tasks_100', 'streak_3', 'streak_7', 'streak_30', 'weekly_goal'];

/** Insignias que se cumplen ahora mismo. */
async function currentBadges(db: Db, userId: string, today: string, tz: string, weeklyGoal: number): Promise<string[]> {
  const stats = await one<{ approved: number; redemptions: number; savings: number }>(
    db,
    `SELECT
       (SELECT count(*) FROM task_instances WHERE status = 'approved' AND (assignee_id = $1 OR completed_by = $1))::int AS approved,
       (SELECT count(*) FROM redemptions WHERE user_id = $1 AND status IN ('approved','delivered'))::int AS redemptions,
       (SELECT COALESCE(SUM(delta_cents),0) FROM money_ledger WHERE user_id = $1 AND account = 'savings')::int AS savings`,
    [userId],
  );
  const streak = await computeStreak(db, userId, today);
  const weekPts = await pointsEarnedBetween(db, userId, startOfWeek(today), today, tz);
  const earned: string[] = [];
  const s = stats!;
  if (s.approved >= 1) earned.push('first_task');
  if (s.approved >= 10) earned.push('tasks_10');
  if (s.approved >= 50) earned.push('tasks_50');
  if (s.approved >= 100) earned.push('tasks_100');
  if (streak >= 3) earned.push('streak_3');
  if (streak >= 7) earned.push('streak_7');
  if (streak >= 30) earned.push('streak_30');
  if (weeklyGoal > 0 && weekPts >= weeklyGoal) earned.push('weekly_goal');
  if (s.redemptions >= 1) earned.push('first_reward');
  if (s.savings >= 1000) earned.push('saver');
  return earned;
}

/**
 * Evalúa y concede insignias nuevas. Devuelve las concedidas.
 * `sourceInstanceId`: la tarea que las provoca; se anota para poder retirarlas si esa tarea se desmarca.
 */
export async function evaluateBadges(db: Db, userId: string, today: string, tz: string, weeklyGoal: number, sourceInstanceId: string | null = null): Promise<string[]> {
  const earned = await currentBadges(db, userId, today, tz, weeklyGoal);
  if (!earned.length) return [];
  const r = await db.query(
    `INSERT INTO user_badges(user_id, badge, source_instance_id) SELECT $1, unnest($2::text[]), $3 ON CONFLICT DO NOTHING RETURNING badge`,
    [userId, earned, sourceInstanceId],
  );
  const fresh = r.rows.map((x) => x.badge as string);
  for (const b of fresh) {
    await notify(db, { userId, event: 'badge', title: `Nueva insignia: ${BADGES[b].title}`, body: BADGES[b].description, link: '/progreso', dedupeKey: `badge:${userId}:${b}` });
  }
  return fresh;
}

/**
 * Al desmarcar una tarea: retira las insignias que ESA tarea concedió y que, sin ella, ya no se cumplen.
 * Las que se ganaron antes con otras tareas (o por otro motivo, como canjear o ahorrar) no se tocan,
 * y las que siguen cumpliéndose gracias a otras tareas se quedan. Devuelve las retiradas.
 */
export async function revokeBadgesFrom(db: Db, userId: string, instanceId: string, today: string, tz: string, weeklyGoal: number): Promise<string[]> {
  const still = await currentBadges(db, userId, today, tz, weeklyGoal);
  const r = await db.query(
    `DELETE FROM user_badges WHERE user_id = $1 AND source_instance_id = $2 AND badge = ANY($3::text[]) AND badge <> ALL($4::text[]) RETURNING badge`,
    [userId, instanceId, TASK_BADGES, still],
  );
  const revoked = r.rows.map((x) => x.badge as string);
  // Las que siguen cumpliéndose pasan a apoyarse en otra tarea hecha (si no, al desmarcar esa quedarían sin sostén).
  await db.query(
    `UPDATE user_badges SET source_instance_id = (
       SELECT id FROM task_instances WHERE id <> $2 AND status = 'approved' AND (assignee_id = $1 OR completed_by = $1) ORDER BY completed_at DESC NULLS LAST LIMIT 1)
      WHERE user_id = $1 AND source_instance_id = $2 AND badge = ANY($3::text[])`,
    [userId, instanceId, TASK_BADGES],
  );
  // El aviso de «Nueva insignia» ya no es verdad: se quita (si la vuelve a ganar, se avisa de nuevo).
  if (revoked.length) await db.query('DELETE FROM notifications WHERE user_id = $1 AND dedupe_key = ANY($2::text[])', [userId, revoked.map((b) => `badge:${userId}:${b}`)]);
  return revoked;
}
