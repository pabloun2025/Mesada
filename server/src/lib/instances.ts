import { many, type Db } from './db.js';
import { addDays } from './dates.js';
import { occursOn, occurrenceIndex, type TaskSchedule } from './recurrence.js';
import { familyToday, getFamily } from './family.js';
import { notify } from './audit.js';

interface TaskRow extends TaskSchedule {
  id: string;
  title: string;
  points: number;
  assignment_mode: 'individual' | 'shared' | 'rotation';
  assignees: string[]; // ordenados por position
}

export const LOOKBACK_DAYS = 7;
export const LOOKAHEAD_DAYS = 14;

/**
 * Materializa (idempotentemente) las ocurrencias de las tareas activas de una familia en [from, to],
 * marca como vencidas las pendientes anteriores a hoy y crea el recordatorio diario.
 */
export async function ensureInstances(db: Db, familyId: string, opts: { from?: string; to?: string; taskId?: string } = {}) {
  const fam = await getFamily(db, familyId);
  const today = familyToday(fam);
  const from = opts.from ?? addDays(today, -LOOKBACK_DAYS);
  const to = opts.to ?? addDays(today, LOOKAHEAD_DAYS);

  const tasks = await many<TaskRow>(
    db,
    `SELECT t.id, t.title, t.points, t.recurrence, t.weekdays, t.month_day, t.start_date, t.end_date, t.assignment_mode,
            COALESCE(array_agg(a.user_id ORDER BY a.position, a.user_id) FILTER (WHERE a.user_id IS NOT NULL AND u.active), '{}') AS assignees
       FROM tasks t
       LEFT JOIN task_assignees a ON a.task_id = t.id
       LEFT JOIN users u ON u.id = a.user_id
      WHERE t.family_id = $1 AND t.active AND ($2::uuid IS NULL OR t.id = $2)
      GROUP BY t.id`,
    [familyId, opts.taskId ?? null],
  );

  const rows: [string, string | null, string, number][] = []; // task_id, assignee, date, points
  for (const t of tasks) {
    if (t.assignees.length === 0) continue;
    // Las tareas puntuales vencidas también se materializan aunque queden fuera de la ventana.
    const start = t.recurrence === 'once' ? t.start_date : from;
    const end = t.recurrence === 'once' ? t.start_date : to;
    if (t.recurrence === 'once' && (t.start_date > to)) continue;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!occursOn(t, d)) continue;
      if (t.assignment_mode === 'individual') {
        for (const a of t.assignees) rows.push([t.id, a, d, t.points]);
      } else if (t.assignment_mode === 'shared') {
        rows.push([t.id, null, d, t.points]);
      } else {
        const idx = occurrenceIndex(t, d) % t.assignees.length;
        rows.push([t.id, t.assignees[idx], d, t.points]);
      }
    }
  }

  if (rows.length) {
    // Inserción por lotes con unnest; el índice único evita duplicados.
    await db.query(
      `INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points)
       SELECT x.task_id, $1, x.assignee_id, x.due_date, x.points
         FROM unnest($2::uuid[], $3::uuid[], $4::date[], $5::int[]) AS x(task_id, assignee_id, due_date, points)
       ON CONFLICT DO NOTHING`,
      [familyId, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3])],
    );
  }

  await db.query(
    `UPDATE task_instances SET status = 'expired' WHERE family_id = $1 AND status = 'pending' AND due_date < $2`,
    [familyId, today],
  );

  // Recordatorio diario (uno por niño y día).
  const counts = await many<{ user_id: string; n: number }>(
    db,
    `SELECT u.id AS user_id, count(i.id)::int AS n
       FROM users u
       JOIN task_instances i ON i.family_id = u.family_id AND i.due_date = $2 AND i.status = 'pending'
        AND (i.assignee_id = u.id OR (i.assignee_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = u.id)))
      WHERE u.family_id = $1 AND u.role = 'child' AND u.active
      GROUP BY u.id`,
    [familyId, today],
  );
  for (const c of counts) {
    await notify(
      db,
      c.user_id,
      'reminder',
      c.n === 1 ? 'Tienes 1 tarea para hoy' : `Tienes ${c.n} tareas para hoy`,
      'Échales un vistazo cuando puedas.',
      '/hoy',
      `daily:${c.user_id}:${today}`,
    );
  }
  return { today, created: rows.length };
}

// Limitador sencillo para no regenerar en cada petición.
const lastRun = new Map<string, number>();
export async function ensureInstancesThrottled(db: Db, familyId: string, minMs = 60_000) {
  const t = lastRun.get(familyId) ?? 0;
  if (Date.now() - t < minMs) return;
  lastRun.set(familyId, Date.now());
  await ensureInstances(db, familyId);
}

export function invalidateThrottle(familyId: string) {
  lastRun.delete(familyId);
}

/** Regenera las ocurrencias futuras pendientes de una tarea tras editarla. */
export async function regenerateTask(db: Db, familyId: string, taskId: string) {
  const fam = await getFamily(db, familyId);
  const today = familyToday(fam);
  await db.query(`DELETE FROM task_instances WHERE task_id = $1 AND status = 'pending' AND due_date >= $2`, [taskId, today]);
  await ensureInstances(db, familyId, { taskId, from: today });
  invalidateThrottle(familyId);
}
