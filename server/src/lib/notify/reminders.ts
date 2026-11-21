import { many, type Db } from '../db.js';
import { familyToday, getFamily } from '../family.js';
import { hhmmToMinutes, localMinutes } from './time.js';
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
         JOIN task_instances i ON i.family_id = u.family_id AND i.due_date = $2 AND i.status IN ('pending','rejected')
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
    const due = await many<{ id: string; title: string; due_min: number; user_id: string }>(
      db,
      `SELECT i.id, t.title, (extract(hour FROM t.due_time) * 60 + extract(minute FROM t.due_time))::int AS due_min, u.id AS user_id
         FROM task_instances i JOIN tasks t ON t.id = i.task_id
         JOIN users u ON u.family_id = i.family_id AND u.active AND u.role = 'child'
          AND (u.id = i.assignee_id OR (i.assignee_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = u.id)))
        WHERE i.family_id = $1 AND i.due_date = $2 AND i.status IN ('pending','rejected') AND t.due_time IS NOT NULL`,
      [familyId, today],
    );
    for (const d of due) {
      if (nowMin >= d.due_min - f.due_soon_minutes && nowMin < d.due_min) {
        const hh = `${String(Math.floor(d.due_min / 60)).padStart(2, '0')}:${String(d.due_min % 60).padStart(2, '0')}`;
        await notify(db, {
          userId: d.user_id,
          event: 'task_due_soon',
          title: `«${d.title}» vence a las ${hh}`,
          body: 'Todavía estás a tiempo.',
          link: '/',
          dedupeKey: `duesoon:${d.id}:${d.user_id}`,
        });
      }
    }
  }
}
