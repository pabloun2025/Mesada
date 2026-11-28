import { many, type Db } from './db.js';
import { addDays } from './dates.js';
import { occursOn, occurrenceIndex, type TaskSchedule } from './recurrence.js';
import { familyToday, getFamily } from './family.js';
import { scheduleReminders } from './notify/reminders.js';

interface TaskRow extends TaskSchedule {
  id: string;
  title: string;
  points: number;
  assignment_mode: 'individual' | 'shared' | 'rotation';
  assignees: string[]; // ordenados por position
}

/**
 * Repeticiones en el día (I13): si una tarea repetible ya tiene hechas y ninguna abierta, abre la siguiente
 * hasta el máximo. El ámbito es el reparto: compartida = todos los hijos juntos; el resto, por hijo.
 */
export async function spawnRepeats(db: Db, familyId: string, day: string, taskId?: string) {
  await db.query(
    `INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points, repeat_no)
     SELECT g.task_id, g.family_id, g.assignee_id, g.due_date, t.points, g.mx + 1
       FROM (SELECT task_id, family_id, assignee_id, due_date, max(repeat_no) AS mx,
                    count(*) FILTER (WHERE status IN ('submitted','approved')) AS done,
                    count(*) FILTER (WHERE status IN ('pending','rejected')) AS open
               FROM task_instances WHERE family_id = $1 AND due_date = $2 AND NOT is_extra AND ($3::uuid IS NULL OR task_id = $3)
              GROUP BY task_id, family_id, assignee_id, due_date) g
       JOIN tasks t ON t.id = g.task_id AND t.active AND t.repeatable AND NOT t.check_mode AND t.cooldown_days IS NULL
      WHERE g.done >= 1 AND g.open = 0 AND (t.max_per_day IS NULL OR g.done < t.max_per_day)
     ON CONFLICT DO NOTHING`,
    [familyId, day, taskId ?? null],
  );
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
      WHERE t.family_id = $1 AND t.active AND NOT t.is_extra AND ($2::uuid IS NULL OR t.id = $2)
      GROUP BY t.id`,
    [familyId, opts.taskId ?? null],
  );

  const rows: [string, string | null, string, number, boolean][] = []; // task_id, assignee, date, points, reconstructed_history
  for (const t of tasks) {
    if (t.assignees.length === 0) continue;
    // Las tareas puntuales vencidas también se materializan aunque queden fuera de la ventana.
    const start = t.recurrence === 'once' ? t.start_date : from;
    const end = t.recurrence === 'once' ? t.start_date : to;
    if (t.recurrence === 'once' && (t.start_date > to)) continue;
    if (t.recurrence === 'as_needed') {
      // Una sola ocurrencia compartida, la de hoy; las de días anteriores sin hacer se borran abajo (no son fallo).
      if (occursOn(t, today)) rows.push([t.id, null, today, t.points, false]);
      continue;
    }
    for (let d = start; d <= end; d = addDays(d, 1)) {
      if (!occursOn(t, d)) continue;
      // Las puntuales llevan una fecha elegida explícitamente. Una recurrente añadida a un día pasado usa el reparto actual.
      const reconstructed = d < today && t.recurrence !== 'once';
      if (t.assignment_mode === 'individual') {
        for (const a of t.assignees) rows.push([t.id, a, d, t.points, reconstructed]);
      } else if (t.assignment_mode === 'shared') {
        rows.push([t.id, null, d, t.points, reconstructed]);
      } else {
        const idx = occurrenceIndex(t, d) % t.assignees.length;
        rows.push([t.id, t.assignees[idx], d, t.points, reconstructed]);
      }
    }
  }

  if (rows.length) {
    // Inserción por lotes con unnest; el índice único evita duplicados.
    await db.query(
      `INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points, reconstructed_history)
       SELECT x.task_id, $1, x.assignee_id, x.due_date, x.points, x.reconstructed_history
         FROM unnest($2::uuid[], $3::uuid[], $4::date[], $5::int[], $6::boolean[]) AS x(task_id, assignee_id, due_date, points, reconstructed_history)
       ON CONFLICT DO NOTHING`,
      [familyId, rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), rows.map((r) => r[4])],
    );
  }

  // Repeticiones sin hacer de días pasados: opcionales, se borran (no son fallo).
  await db.query(`DELETE FROM task_instances WHERE family_id = $1 AND status = 'pending' AND due_date < $2 AND repeat_no > 1`, [familyId, today]);
  await spawnRepeats(db, familyId, today);
  // «Cuando haga falta» sin hacer y trabajos extra: nunca vencen como fallo; las ocurrencias vacías se borran.
  await db.query(
    `DELETE FROM task_instances i USING tasks t
      WHERE t.id = i.task_id AND i.family_id = $1 AND i.status = 'pending' AND i.due_date < $2 AND t.recurrence = 'as_needed' AND NOT i.is_extra`,
    [familyId, today],
  );
  // Extra con plazo vencido sin terminar: sale del tablón en silencio y vuelve al catálogo.
  await db.query(
    `DELETE FROM task_instances WHERE family_id = $1 AND is_extra AND status IN ('pending','rejected') AND extra_deadline IS NOT NULL AND extra_deadline < $2`,
    [familyId, today],
  );
  await db.query(
    `UPDATE task_instances SET status = 'expired' WHERE family_id = $1 AND status = 'pending' AND due_date < $2 AND NOT is_extra`,
    [familyId, today],
  );

  await scheduleReminders(db, familyId);
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
export async function regenerateTask(db: Db, familyId: string, taskId: string, preservePromotion = false) {
  const fam = await getFamily(db, familyId);
  const today = familyToday(fam);
  await db.query(`DELETE FROM task_instances i WHERE task_id = $1 AND status = 'pending' AND due_date >= $2
    AND NOT ($3::boolean AND EXISTS (SELECT 1 FROM task_promotions p WHERE p.instance_id = i.id AND p.day = $2 AND p.expires_at > clock_timestamp()))`,
  [taskId, today, preservePromotion]);
  await ensureInstances(db, familyId, { taskId, from: today });
  invalidateThrottle(familyId);
}
