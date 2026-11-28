import { audit } from './audit.js';
import type { AuthUser } from './auth.js';
import { getPool, many, one, tx, type Db } from './db.js';
import { dayEnd } from './deadline.js';
import { conflict, notFound } from './errors.js';
import { familyToday, getFamily, type Family } from './family.js';
import { ensureInstancesThrottled } from './instances.js';
import { addPoints } from './ledger.js';

interface Suggestion {
  task_id: string;
  instance_id: string;
  title: string;
  icon: string;
  base_points: number;
  can_promote: boolean;
  promotion: { base_points: number; extra_points: number; percentage: 30 | 50; day: string } | null;
}

async function suggestions(db: Db, fam: Family, now: Date, options: { childId?: string; taskId?: string } = {}) {
  return many<Suggestion>(db, `SELECT t.id AS task_id, i.id AS instance_id, t.title, t.icon, i.points AS base_points,
    p.id IS NULL AS can_promote,
    CASE WHEN p.instance_id = i.id AND p.reserved_by IS NULL AND p.granted_at IS NULL AND p.expires_at > $4
         THEN jsonb_build_object('base_points', p.base_points, 'extra_points', p.extra_points, 'percentage', p.percentage, 'day', p.day) END AS promotion
    FROM tasks t JOIN task_instances i ON i.task_id = t.id AND i.due_date = $2 AND i.status = 'pending' AND NOT i.is_extra
    LEFT JOIN LATERAL (
      SELECT max(CASE WHEN h.adult_logged THEN h.due_date ELSE (h.completed_at AT TIME ZONE $3)::date END) AS last_done
      FROM task_instances h WHERE h.task_id = t.id AND h.status IN ('submitted','approved')
    ) h ON true
    LEFT JOIN task_promotions p ON p.task_id = t.id AND p.day = $2
    WHERE t.family_id = $1 AND t.active AND t.recurrence = 'as_needed' AND NOT t.is_extra
      AND t.start_date <= $2 AND (t.end_date IS NULL OR t.end_date >= $2)
      AND GREATEST(t.start_date, h.last_done) <= $2::date - 7
      AND (t.cooldown_days IS NULL OR h.last_done IS NULL OR h.last_done + t.cooldown_days <= $2::date)
      AND ($5::uuid IS NULL OR t.id = $5)
      AND EXISTS (SELECT 1 FROM task_assignees a JOIN users u ON u.id = a.user_id
          WHERE a.task_id = t.id AND u.active AND u.role = 'child' AND ($6::uuid IS NULL OR u.id = $6))
    ORDER BY t.title, i.id`, [fam.id, familyToday(fam, now), fam.timezone, now, options.taskId ?? null, options.childId ?? null]);
}

export async function taskSuggestions(actor: AuthUser) {
  const db = getPool();
  await ensureInstancesThrottled(db, actor.familyId);
  const fam = await getFamily(db, actor.familyId);
  return { suggestions: await suggestions(db, fam, new Date(), { childId: actor.role === 'child' ? actor.id : undefined }) };
}

export async function activateTaskPromotion(adult: AuthUser, taskId: string, percentage: 30 | 50) {
  await ensureInstancesThrottled(getPool(), adult.familyId);
  return tx(async (db) => {
    if (!(await one(db, `SELECT id FROM tasks WHERE id = $1 AND family_id = $2 FOR NO KEY UPDATE`, [taskId, adult.familyId]))) throw notFound('Tarea no encontrada');
    const fam = await getFamily(db, adult.familyId);
    const now = new Date();
    const [task] = await suggestions(db, fam, now, { taskId });
    if (!task) throw conflict('Esta tarea ya no está disponible para promoción', 'promotion_unavailable');
    const extra = Math.round(task.base_points * percentage / 100);
    if (!extra) throw conflict('La promoción debe añadir al menos un punto', 'promotion_no_points');
    const day = familyToday(fam, now);
    const promotion = await one(db, `INSERT INTO task_promotions (family_id, task_id, instance_id, day, base_points, percentage, extra_points, activated_by, activated_at, expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (task_id, day) DO NOTHING
      RETURNING id, day, base_points, percentage, extra_points`, [adult.familyId, taskId, task.instance_id, day, task.base_points, percentage, extra, adult.id, now, dayEnd(day, fam.timezone)]);
    if (!promotion) throw conflict('Esta tarea ya tiene una promoción para hoy', 'promotion_exists');
    await audit(db, adult.familyId, adult.id, 'task.promotion', 'task', taskId, { percentage, points: extra, day, title: task.title });
    return { promotion };
  });
}

export async function reservePromotion(db: Db, instanceId: string, childId: string, completedAt: Date, receivedAt = completedAt) {
  const row = await one<{ extra_points: number }>(db, `UPDATE task_promotions
    SET reserved_by = $2, reserved_at = COALESCE(reserved_at, $3)
    WHERE instance_id = $1 AND granted_at IS NULL
      AND (reserved_by = $2 OR (reserved_by IS NULL AND activated_at <= $3 AND expires_at > $3 AND expires_at > $4))
    RETURNING extra_points`, [instanceId, childId, completedAt, receivedAt]);
  return row?.extra_points ?? 0;
}

export async function hasOpenPromotion(db: Db, instanceId: string, now: Date) {
  return !!(await one(db, `SELECT 1 FROM task_promotions WHERE instance_id = $1 AND reserved_by IS NULL AND granted_at IS NULL AND activated_at <= $2 AND expires_at > $2`, [instanceId, now]));
}

type PromotedInstance = { id: string; family_id: string; title: string; unmark_count: number };

export async function grantPromotion(db: Db, inst: PromotedInstance, childId: string, actorId: string | null) {
  const row = await one<{ id: string; extra_points: number }>(db, `UPDATE task_promotions SET granted_at = now()
    WHERE instance_id = $1 AND reserved_by = $2 AND granted_at IS NULL RETURNING id, extra_points`, [inst.id, childId]);
  if (!row) return 0;
  await addPoints(db, { familyId: inst.family_id, userId: childId, delta: row.extra_points, kind: 'bonus', refId: inst.id,
    note: `Promoción: «${inst.title}»`, createdBy: actorId, idempotencyKey: `promotion:${row.id}:${inst.unmark_count}` });
  return row.extra_points;
}

export async function undoPromotion(db: Db, inst: PromotedInstance, childId: string) {
  const row = await one<{ id: string; extra_points: number; granted_at: Date | null }>(db,
    `SELECT id, extra_points, granted_at FROM task_promotions WHERE instance_id = $1 AND reserved_by = $2 FOR UPDATE`, [inst.id, childId]);
  if (!row) return 0;
  await db.query('UPDATE task_promotions SET reserved_by = NULL, reserved_at = NULL, granted_at = NULL WHERE id = $1', [row.id]);
  if (!row.granted_at) return 0;
  await addPoints(db, { familyId: inst.family_id, userId: childId, delta: -row.extra_points, kind: 'adjustment', refId: inst.id,
    note: `Promoción desmarcada: «${inst.title}»`, createdBy: childId, idempotencyKey: `promotion-undo:${row.id}:${inst.unmark_count}`, reversesEarning: true });
  return row.extra_points;
}
