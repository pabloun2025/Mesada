import { many, type Db } from '../db.js';
import { familyToday, getFamily } from '../family.js';
import { hhmmToMinutes, localMinutes } from './time.js';
import { deadlineAt, deadlineTime, isHoliday } from '../deadline.js';
import { notify } from './dispatch.js';

/**
 * Recordatorios configurables por familia, idempotentes por clave:
 * - diario, a la hora `reminder_time`: tareas pendientes de hoy (uno por hijo y día);
 * - «a punto de vencer»: `due_soon_minutes` antes de la hora límite de cada tarea (uno por ocurrencia y persona).
 */
export async function scheduleReminders(db: Db, familyId: string, now = new Date()) {
  const fam = await getFamily(db, familyId);
  const f = fam as typeof fam & { reminder_time: string; due_soon_minutes: number };
  const today = familyToday(fam, now);
  const nowMin = localMinutes(now, fam.timezone);

  if (nowMin >= hhmmToMinutes(String(f.reminder_time).slice(0, 5))) {
    const rows = await many<{ user_id: string; n: number }>(
      db,
      `SELECT u.id AS user_id, count(i.id)::int AS n
         FROM users u
         JOIN task_instances i ON i.family_id = u.family_id AND i.due_date = $2 AND i.status IN ('pending','rejected') AND i.repeat_no = 1
          AND NOT EXISTS (SELECT 1 FROM tasks ck WHERE ck.id = i.task_id AND (ck.check_mode OR ck.is_extra OR ck.recurrence = 'as_needed'))
          AND (i.assignee_id = u.id OR (i.assignee_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = u.id)))
        WHERE u.family_id = $1 AND u.role = 'child' AND u.active
        GROUP BY u.id`,
      [familyId, today],
    );
    for (const r of rows) {
      await notify(db, {
        userId: r.user_id,
        event: 'task_reminder',
        title: r.n === 1 ? 'Te queda 1 tarea de hoy' : `Te quedan ${r.n} tareas de hoy`,
        body: 'Márcalas en DiploP cuando las termines.',
        link: '/',
        dedupeKey: `reminder:${r.user_id}:${today}`,
      });
    }
  }

  if (f.due_soon_minutes > 0) {
    // La hora límite depende del día (L–V, fin de semana o festivo), así que se calcula como instante.
    const due = await many<{ id: string; title: string; due_time: string | null; due_time_weekend: string | null; late_percent: number; user_id: string }>(
      db,
      `SELECT i.id, t.title, t.due_time, t.due_time_weekend, t.late_percent, u.id AS user_id
         FROM task_instances i JOIN tasks t ON t.id = i.task_id AND NOT t.check_mode
         JOIN users u ON u.family_id = i.family_id AND u.active AND u.role = 'child'
          AND (u.id = i.assignee_id OR (i.assignee_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = u.id)))
        WHERE i.family_id = $1 AND i.due_date = $2 AND i.status IN ('pending','rejected') AND (t.due_time IS NOT NULL OR t.due_time_weekend IS NOT NULL)`,
      [familyId, today],
    );
    const holiday = due.length ? await isHoliday(db, familyId, today) : false;
    for (const d of due) {
      const dl = deadlineAt(d, today, holiday, fam.timezone);
      if (!dl) continue;
      const startsAt = dl.getTime() - f.due_soon_minutes * 60_000;
      if (now.getTime() >= startsAt && now.getTime() < dl.getTime()) {
        await notify(db, {
          userId: d.user_id,
          event: 'task_due_soon',
          title: `«${d.title}» vence a las ${deadlineTime(d, today, holiday)}`,
          body: d.late_percent < 100 ? `Si llegas tarde, vale el ${d.late_percent} % de los puntos.` : 'Todavía estás a tiempo.',
          link: '/',
          dedupeKey: `duesoon:${d.id}:${d.user_id}`,
        });
      }
    }
  }
}
