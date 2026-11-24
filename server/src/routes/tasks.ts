import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getPool, many, one, tx } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { enforceLimit } from '../lib/limits.js';
import { looksLikeImage, processPhoto, removePhotoFile, storePhoto } from '../lib/photos.js';
import { audit } from '../lib/audit.js';
import { config } from '../lib/config.js';
import { familyToday, getFamily } from '../lib/family.js';
import { ensureInstancesThrottled, regenerateTask } from '../lib/instances.js';
import { completeInstance, reviewInstance, unmarkInstance } from '../lib/task-actions.js';
import { checkInstance } from '../lib/check-tasks.js';
import { bonusView, bonusLabel, BONUS_COLUMNS } from '../lib/bonus.js';
import { deadlineAt, deadlineTime, holidaysBetween, reducedPoints } from '../lib/deadline.js';
import { addDays, isValidDate, todayIn } from '../lib/dates.js';
import { notify } from '../lib/notify/dispatch.js';

export const dateStr = z.string().refine(isValidDate, 'fecha no válida');

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const bonusBody = z
  .object({
    kind: z.enum(['points', 'screen', 'text', 'reward']),
    points: z.number().int().min(1).max(10000).optional(),
    minutes: z.number().int().min(1).max(1440).optional(),
    text: z.string().trim().min(1).max(200).optional(),
    rewardId: z.string().uuid().optional(),
    surprise: z.boolean().default(false),
    onTimeOnly: z.boolean().default(false),
  })
  .refine((b) => (b.kind === 'points' ? b.points : b.kind === 'screen' ? b.minutes : b.kind === 'text' ? b.text : b.rewardId) !== undefined, {
    message: 'completa el bono',
    path: ['kind'],
  });

const taskBody = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(''),
    icon: z.string().max(16).default('✅'),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
    points: z.number().int().min(0).max(10000),
    recurrence: z.enum(['once', 'daily', 'weekly', 'monthly', 'as_needed']),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    monthDay: z.number().int().min(1).max(31).nullable().default(null),
    startDate: dateStr,
    endDate: dateStr.nullable().default(null),
    dueTime: hhmm.nullable().default(null),
    dueTimeWeekend: hhmm.nullable().default(null),
    latePercent: z.number().int().min(0).max(100).default(100),
    checkMode: z.boolean().default(false),
    penaltyMinutes: z.number().int().min(0).max(1440).default(0),
    successMinutes: z.number().int().min(0).max(1440).default(0),
    bonus: bonusBody.nullable().default(null),
    assignmentMode: z.enum(['individual', 'shared', 'rotation']).default('individual'),
    assignees: z.array(z.string().uuid()).min(1, 'asigna la tarea al menos a una persona').max(20),
    requiresApproval: z.boolean().default(true),
    requiresPhoto: z.boolean().default(false),
    repeatable: z.boolean().default(false),
    maxPerDay: z.number().int().min(2).max(50).nullable().default(null),
    cooldownDays: z.number().int().min(1).max(365).nullable().default(null),
  })
  .refine((t) => !t.endDate || t.endDate >= t.startDate, { message: 'la fecha de fin es anterior al inicio', path: ['endDate'] })
  .refine((t) => t.recurrence !== 'weekly' || t.weekdays.length > 0, { message: 'elige al menos un día de la semana', path: ['weekdays'] })
  .refine((t) => !t.checkMode || t.assignmentMode !== 'shared', { message: 'una tarea que marca un adulto no puede ser compartida', path: ['assignmentMode'] });

/** Columnas a guardar. En tareas de comprobación no hay hora límite ni foto ni validación: las marca un adulto. */
function taskParams(b0: z.infer<typeof taskBody>) {
  // «Cuando haga falta»: compartida entre los asignados, sin hora límite ni comprobación (nunca vence).
  const b = b0.recurrence === 'as_needed'
    ? { ...b0, assignmentMode: 'shared' as const, dueTime: null, dueTimeWeekend: null, latePercent: 100, checkMode: false }
    : b0;
  const c = b.checkMode;
  return [
    b.title, b.description, b.icon, b.difficulty, b.points, b.recurrence, b.weekdays, b.monthDay, b.startDate, b.endDate,
    c ? null : b.dueTime, c ? null : b.dueTimeWeekend, c ? 100 : b.latePercent, b.assignmentMode, c ? false : b.requiresApproval, c ? false : b.requiresPhoto,
    c, c ? b.penaltyMinutes : 0, c ? b.successMinutes : 0,
    b.bonus?.kind ?? null, b.bonus?.kind === 'points' ? b.bonus.points : null, b.bonus?.kind === 'screen' ? b.bonus.minutes : null,
    b.bonus?.kind === 'text' ? b.bonus.text : null, b.bonus?.kind === 'reward' ? b.bonus.rewardId : null,
    b.bonus?.surprise ?? false, b.bonus?.onTimeOnly ?? false,
    // Repetir en el día: no aplica a las que marca un adulto. Sin tope = ilimitado.
    c ? false : b.repeatable, c || !b.repeatable ? null : b.maxPerDay,
    // Espera tras hacerla: solo «Cuando haga falta» y manda sobre las repeticiones del día.
    b.recurrence === 'as_needed' ? b.cooldownDays : null,
  ];
}

async function validateReward(familyId: string, b: z.infer<typeof taskBody>) {
  if (b.bonus?.kind !== 'reward') return;
  const r = await one(getPool(), 'SELECT 1 FROM rewards WHERE id = $1 AND family_id = $2 AND active', [b.bonus.rewardId, familyId]);
  if (!r) throw badRequest('La recompensa del bono no existe');
}

export const TASK_SELECT = `
  SELECT t.*, rw.title AS bonus_reward_title, COALESCE(json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'avatar', u.avatar, 'color', u.color) ORDER BY a.position)
         FILTER (WHERE u.id IS NOT NULL), '[]') AS assignees
    FROM tasks t LEFT JOIN task_assignees a ON a.task_id = t.id LEFT JOIN users u ON u.id = a.user_id LEFT JOIN rewards rw ON rw.id = t.bonus_reward_id`;

async function validateAssignees(familyId: string, ids: string[]) {
  const rows = await many(getPool(), `SELECT id FROM users WHERE family_id = $1 AND id = ANY($2::uuid[]) AND active`, [familyId, ids]);
  if (rows.length !== new Set(ids).size) throw badRequest('Alguna persona asignada no pertenece a la familia');
}

export const INSTANCE_SELECT = `
  SELECT i.id, i.task_id, i.assignee_id, i.due_date, i.status, i.points, i.completed_by, i.completed_at, i.child_note,
         (i.photo_path IS NOT NULL) AS has_photo, (i.photo_deleted_at IS NOT NULL) AS photo_deleted, i.reviewed_at, i.review_note,
         i.deadline_at, i.on_time, i.check_met, (i.reviewed_by IS NOT NULL) AS adult_reviewed, i.review_outcome, i.penalty_points, i.penalty_screen, i.repeat_no, t.repeatable, t.max_per_day, t.cooldown_days,
         (SELECT count(*)::int FROM task_instances x WHERE x.task_id = i.task_id AND x.due_date = i.due_date AND x.status IN ('submitted','approved') AND x.assignee_id IS NOT DISTINCT FROM i.assignee_id) AS done_count,
         t.title, t.icon, t.description, t.difficulty, t.recurrence, t.assignment_mode, t.requires_approval, t.requires_photo, t.due_time,
         t.due_time_weekend, t.late_percent, t.points AS task_points, t.check_mode, t.penalty_minutes, t.success_minutes,
         (CASE WHEN t.check_mode THEN COALESCE(t.success_minutes, 0) ELSE 0 END + CASE WHEN t.bonus_kind = 'screen' AND NOT t.bonus_surprise THEN COALESCE(t.bonus_minutes, 0) ELSE 0 END)::int AS minutes_reward,
         t.bonus_kind, t.bonus_points, t.bonus_minutes, t.bonus_text, t.bonus_reward_id, t.bonus_surprise, t.bonus_on_time_only, rw.title AS bonus_reward_title,
         au.display_name AS assignee_name, au.avatar AS assignee_avatar, au.color AS assignee_color,
         cu.display_name AS completed_by_name
    FROM task_instances i
    JOIN tasks t ON t.id = i.task_id
    LEFT JOIN users au ON au.id = i.assignee_id
    LEFT JOIN users cu ON cu.id = i.completed_by
    LEFT JOIN rewards rw ON rw.id = t.bonus_reward_id`;

/** Sorpresas que este hijo ya ganó (tras ganarlas la tarea vuelve a ser normal). */
export async function claimedTasks(userId: string): Promise<Set<string>> {
  const rows = await many(getPool(), 'SELECT task_id FROM bonus_claims WHERE user_id = $1', [userId]);
  return new Set(rows.map((r) => r.task_id));
}

/** Sustituye las columnas crudas del bono por la vista segura: a un hijo nunca le llega el contenido de una sorpresa sin ganar. */
export function shapeBonus<T extends Record<string, any>>(row: T, role: 'adult' | 'child', claimed: Set<string>, taskId: string) {
  const bonus = bonusView(row as any, role, claimed.has(taskId));
  if (role === 'child') {
    const out: Record<string, any> = { ...row };
    for (const c of [...BONUS_COLUMNS, 'bonus_on_time_only', 'bonus_reward_title']) delete out[c];
    return { ...out, bonus };
  }
  return { ...row, bonus };
}

/** Aviso de tarea nueva a cada hijo asignado (una vez por tarea y persona, aunque se edite). */
async function notifyAssigned(db: any, taskId: string, title: string, points: number, assignees: string[]) {
  const kids = await many(db, `SELECT id FROM users WHERE id = ANY($1::uuid[]) AND role = 'child'`, [assignees]);
  for (const k of kids) {
    await notify(db, { userId: k.id, event: 'task_assigned', title: `Nueva tarea: ${title}`, body: `+${points} puntos`, link: '/', dedupeKey: `assigned:${taskId}:${k.id}` });
  }
}

/** Aviso de «cuando haga falta» activada: anima a ser el primero (se la lleva quien la haga antes). */
async function notifyAvailable(db: any, taskId: string, title: string, points: number, today: string) {
  const kids = await many<{ id: string }>(
    db,
    `SELECT u.id FROM task_assignees a JOIN users u ON u.id = a.user_id WHERE a.task_id = $1 AND u.role = 'child' AND u.active`,
    [taskId],
  );
  const prize = points > 0 ? `+${points} puntos para su paga` : 'el mérito';
  const body = kids.length > 1
    ? `El primero que la haga se lleva ${prize}. ¡A por ella!`
    : points > 0 ? `Hazla y suma +${points} puntos para tu paga.` : '¡A por ella!';
  for (const k of kids) {
    await notify(db, { userId: k.id, event: 'task_available', title: `¡Toca «${title}»!`, body, link: '/', dedupeKey: `available:${taskId}:${today}:${k.id}` });
  }
}

/** ¿Puede este hijo desmarcar la ocurrencia? Enviada y sin validar; si no pedía validación, hasta el final del día en que la marcó. */
export function canUnmark(u: { id: string; role: string }, r: { completed_by: string | null; status: string; check_mode?: boolean; adult_reviewed?: boolean; completed_at: string | Date | null }, tz: string, today: string) {
  if (u.role !== 'child' || r.completed_by !== u.id || r.check_mode) return false;
  if (r.status === 'submitted') return true;
  return r.status === 'approved' && !r.adult_reviewed && !!r.completed_at && todayIn(tz, new Date(r.completed_at)) === today;
}

export default async function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (req) => {
    const u = requireUser(req);
    const rows = await many(
      getPool(),
      `${TASK_SELECT} WHERE t.family_id = $1 AND t.active AND NOT t.is_extra
         ${u.role === 'child' ? 'AND EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = $2)' : 'AND $2::uuid IS NOT NULL'}
       GROUP BY t.id, rw.id ORDER BY t.created_at DESC`,
      [u.familyId, u.id],
    );
    const claimed = u.role === 'child' ? await claimedTasks(u.id) : new Set<string>();
    return { tasks: rows.map((r) => shapeBonus(r, u.role, claimed, r.id)) };
  });

  app.post('/api/tasks', async (req) => {
    const u = requireAdult(req);
    const b = taskBody.parse(req.body);
    await validateAssignees(u.familyId, b.assignees);
    await validateReward(u.familyId, b);
    const id = await tx(async (db) => {
      const t = await one(
        db,
        `INSERT INTO tasks(family_id, title, description, icon, difficulty, points, recurrence, weekdays, month_day, start_date, end_date, due_time, due_time_weekend, late_percent, assignment_mode, requires_approval, requires_photo, check_mode, penalty_minutes, success_minutes, bonus_kind, bonus_points, bonus_minutes, bonus_text, bonus_reward_id, bonus_surprise, bonus_on_time_only, repeatable, max_per_day, cooldown_days, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31) RETURNING id`,
        [u.familyId, ...taskParams(b), u.id],
      );
      await db.query(`INSERT INTO task_assignees(task_id, user_id, position) SELECT $1, x, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS y(x, ord)`, [t.id, b.assignees]);
      await audit(db, u.familyId, u.id, 'task.create', 'task', t.id, { title: b.title, points: b.points });
      await regenerateTask(db, u.familyId, t.id);
      await notifyAssigned(db, t.id, b.title, b.points, b.assignees);
      return t.id as string;
    });
    return { task: await one(getPool(), `${TASK_SELECT} WHERE t.id = $1 GROUP BY t.id, rw.id`, [id]) };
  });

  app.put('/api/tasks/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = taskBody.parse(req.body);
    await validateAssignees(u.familyId, b.assignees);
    await validateReward(u.familyId, b);
    await tx(async (db) => {
      const r = await db.query(
        `UPDATE tasks SET title=$3, description=$4, icon=$5, difficulty=$6, points=$7, recurrence=$8, weekdays=$9, month_day=$10, start_date=$11, end_date=$12, due_time=$13, due_time_weekend=$14, late_percent=$15, assignment_mode=$16, requires_approval=$17, requires_photo=$18, check_mode=$19, penalty_minutes=$20, success_minutes=$21, bonus_kind=$22, bonus_points=$23, bonus_minutes=$24, bonus_text=$25, bonus_reward_id=$26, bonus_surprise=$27, bonus_on_time_only=$28, repeatable=$29, max_per_day=$30, cooldown_days=$31, updated_at=now()
          WHERE id=$1 AND family_id=$2 AND active AND NOT is_extra`,
        [id, u.familyId, ...taskParams(b)],
      );
      if (!r.rowCount) throw notFound('Tarea no encontrada');
      await db.query('DELETE FROM task_assignees WHERE task_id = $1', [id]);
      await db.query(`INSERT INTO task_assignees(task_id, user_id, position) SELECT $1, x, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS y(x, ord)`, [id, b.assignees]);
      await audit(db, u.familyId, u.id, 'task.update', 'task', id, { title: b.title, points: b.points });
      await regenerateTask(db, u.familyId, id);
      await notifyAssigned(db, id, b.title, b.points, b.assignees);
    });
    return { task: await one(getPool(), `${TASK_SELECT} WHERE t.id = $1 GROUP BY t.id, rw.id`, [id]) };
  });

  /**
   * «Cuando haga falta»: activar por unos días (o sin fin) o pausar en un toque.
   * Reutiliza las fechas de inicio y fin: pausar = terminó ayer; activar = desde hoy hasta hoy + días − 1.
   */
  app.post('/api/tasks/:id/availability', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.union([z.object({ pause: z.literal(true) }), z.object({ days: z.number().int().min(1).max(365).nullable() })]).parse(req.body);
    await tx(async (db) => {
      const t = await one<{ recurrence: string; title: string; points: number; start_date: string; end_date: string | null }>(db, 'SELECT recurrence, title, points, start_date, end_date FROM tasks WHERE id = $1 AND family_id = $2 AND active AND NOT is_extra FOR UPDATE', [id, u.familyId]);
      if (!t) throw notFound('Tarea no encontrada');
      if (t.recurrence !== 'as_needed') throw badRequest('Solo las tareas «cuando haga falta» se activan y pausan así', 'not_as_needed');
      const today = familyToday(await getFamily(db, u.familyId));
      const wasActive = t.start_date <= today && (!t.end_date || t.end_date >= today);
      if ('pause' in b) {
        const y = addDays(today, -1);
        await db.query('UPDATE tasks SET end_date = $3, start_date = LEAST(start_date, $3::date), updated_at = now() WHERE id = $1 AND family_id = $2', [id, u.familyId, y]);
      } else {
        await db.query('UPDATE tasks SET start_date = $3, end_date = $4, updated_at = now() WHERE id = $1 AND family_id = $2', [id, u.familyId, today, b.days ? addDays(today, b.days - 1) : null]);
      }
      await audit(db, u.familyId, u.id, 'pause' in b ? 'task.pause' : 'task.activate', 'task', id, 'pause' in b ? {} : { days: b.days });
      await regenerateTask(db, u.familyId, id);
      // Al pasar de pausa a activa se avisa a los hijos: quien llegue primero se lleva los puntos.
      if (!('pause' in b) && !wasActive) await notifyAvailable(db, id, t.title, t.points, today);
    });
    return { task: await one(getPool(), `${TASK_SELECT} WHERE t.id = $1 GROUP BY t.id, rw.id`, [id]) };
  });

  app.delete('/api/tasks/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await tx(async (db) => {
      const r = await db.query('UPDATE tasks SET active = false, updated_at = now() WHERE id = $1 AND family_id = $2 AND active AND NOT is_extra', [id, u.familyId]);
      if (!r.rowCount) throw notFound('Tarea no encontrada');
      const fam = await getFamily(db, u.familyId);
      await db.query(`DELETE FROM task_instances WHERE task_id = $1 AND status = 'pending' AND due_date >= $2`, [id, familyToday(fam)]);
      await audit(db, u.familyId, u.id, 'task.archive', 'task', id);
    });
    return { ok: true };
  });

  app.get('/api/instances', async (req) => {
    const u = requireUser(req);
    const q = z
      .object({
        from: dateStr.optional(),
        to: dateStr.optional(),
        status: z.string().optional(),
        userId: z.string().uuid().optional(),
      })
      .parse(req.query);
    await ensureInstancesThrottled(getPool(), u.familyId);
    const fam = await getFamily(getPool(), u.familyId);
    const today = familyToday(fam);
    const statuses = q.status ? q.status.split(',') : null;
    // Un hijo solo ve lo suyo (y las compartidas en las que participa).
    const who = u.role === 'child' ? u.id : q.userId ?? null;
    const rows = await many(
      getPool(),
      `${INSTANCE_SELECT}
        WHERE i.family_id = $1 AND i.due_date BETWEEN $2 AND $3
          AND NOT i.is_extra
          AND ($4::text[] IS NULL OR i.status = ANY($4))
          AND ($5::uuid IS NULL OR i.assignee_id = $5 OR i.completed_by = $5
               OR (i.assignee_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = $5)))
        ORDER BY i.due_date, t.due_time NULLS LAST, t.title
        LIMIT 1000`,
      [u.familyId, q.from ?? today, q.to ?? q.from ?? today, statuses, who],
    );
    const holidays = rows.length ? await holidaysBetween(getPool(), u.familyId, q.from ?? today, q.to ?? q.from ?? today) : new Set<string>();
    const claims = u.role === 'child'
      ? new Set((await claimedTasks(u.id)).values())
      : new Set((await many(getPool(), 'SELECT task_id, user_id FROM bonus_claims bc WHERE EXISTS (SELECT 1 FROM tasks t WHERE t.id = bc.task_id AND t.family_id = $1)', [u.familyId])).map((c) => `${c.task_id}:${c.user_id}`));
    // Espera tras hacerla: la última vez que se pulsó «Hecha» (día local, aunque aún no esté validada).
    const cdIds = [...new Set(rows.filter((r) => r.cooldown_days).map((r) => r.task_id))];
    const lastDone = new Map<string, string>();
    if (cdIds.length) {
      for (const x of await many(getPool(), `SELECT task_id, max((completed_at AT TIME ZONE $2)::date)::text AS d FROM task_instances WHERE task_id = ANY($1::uuid[]) AND status IN ('submitted','approved') GROUP BY task_id`, [cdIds, fam.timezone])) lastDone.set(x.task_id, x.d);
    }
    const instances = rows.map((r) => {
      const ld = r.cooldown_days ? lastDone.get(r.task_id) : undefined;
      const until = ld && ['pending', 'rejected'].includes(r.status) ? addDays(ld, r.cooldown_days) : null;
      const blockedUntil = until && until > r.due_date ? until : null;
      // Mientras no se complete, la hora límite se calcula al vuelo (así respeta festivos añadidos después).
      const dl = r.deadline_at ? new Date(r.deadline_at) : deadlineAt(r, r.due_date, holidays.has(r.due_date), fam.timezone);
      const claimed = new Set<string>();
      if (u.role === 'child' ? claims.has(r.task_id) : claims.has(`${r.task_id}:${r.assignee_id}`)) claimed.add(r.task_id);
      return {
        ...shapeBonus(r, u.role, claimed, r.task_id),
        deadline_at: dl ? dl.toISOString() : null,
        deadline_time: r.check_mode ? null : deadlineTime(r, r.due_date, holidays.has(r.due_date)),
        late_points: reducedPoints(r.task_points, r.late_percent),
        blocked_until: blockedUntil,
        can_unmark: canUnmark(u, r, fam.timezone, today),
      };
    });
    return { today, instances };
  });

  // Tarea de comprobación: la marca un adulto. Idempotente y corregible.
  app.post('/api/instances/:id/check', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ met: z.boolean() }).parse(req.body);
    return checkInstance(u, id, b.met);
  });

  app.post('/api/instances/:id/complete', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    let note: string | undefined;
    let photoPath: string | null = null;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(part.mimetype)) throw badRequest('La foto debe ser JPG, PNG o WebP');
          enforceLimit(req, 'upload', config.limits.uploadPerHour);
          const stored = (await one<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM task_instances WHERE family_id = $1 AND photo_path IS NOT NULL', [u.familyId]))!.n;
          if (stored >= config.caps.maxPhotos) throw conflict('La familia ha llegado al máximo de fotos guardadas. Un adulto puede descargarlas y borrar tareas antiguas.', 'too_many_photos');
          const raw = await part.toBuffer();
          if (part.file.truncated) throw new HttpError(413, `La foto pesa demasiado (máximo ${Math.round(config.maxUploadBytes / 1048576)} MB)`, 'too_large');
          // Se comprueba el contenido real, se reduce a 1280 px y se quitan EXIF y GPS.
          if (!looksLikeImage(raw, part.mimetype)) throw badRequest('El archivo no es una foto válida');
          const out = await processPhoto(raw, part.mimetype);
          photoPath = await storePhoto(u.familyId, out.data, out.ext);
        } else if (part.fieldname === 'note') {
          note = String(part.value).slice(0, 500);
        }
      }
    } else {
      note = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {}).note;
    }
    try {
      return await completeInstance(u, id, { note, photoPath });
    } catch (e) {
      removePhotoFile(photoPath);
      throw e;
    }
  });

  // El hijo desmarca una tarea que marcó por error (I17). Sin aviso a los adultos.
  app.post('/api/instances/:id/unmark', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return unmarkInstance(u, id);
  });

  app.post('/api/instances/:id/review', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z
      .object({
        approve: z.boolean().optional(),
        action: z.enum(['approve', 'partial', 'return', 'reject', 'reject_penalty']).optional(),
        points: z.number().int().min(0).max(10000).optional(),
        note: z.string().max(500).optional(),
        penaltyPoints: z.number().int().min(0).max(10000).optional(),
        penaltyMinutes: z.number().int().min(0).max(1440).optional(),
      })
      .refine((v) => v.approve !== undefined || v.action !== undefined, { message: 'falta la decisión' })
      .parse(req.body);
    return reviewInstance(u, id, b);
  });

  // Foto de evidencia: solo adultos de la familia o quien la subió.
  app.get('/api/instances/:id/photo', async (req, reply) => {
    const u = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await one(getPool(), 'SELECT photo_path, completed_by, photo_deleted_at FROM task_instances WHERE id = $1 AND family_id = $2', [id, u.familyId]);
    if (row && !row.photo_path && row.photo_deleted_at) throw new HttpError(410, 'Foto ya borrada', 'photo_deleted');
    if (!row?.photo_path) throw notFound('Sin foto');
    if (u.role !== 'adult' && row.completed_by !== u.id) throw forbidden();
    const abs = path.resolve(config.uploadDir, row.photo_path);
    if (!abs.startsWith(path.resolve(config.uploadDir) + path.sep)) throw notFound('Sin foto');
    if (!fs.existsSync(abs)) throw new HttpError(410, 'Foto ya borrada', 'photo_deleted');
    const ext = path.extname(abs).slice(1);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    return reply.send(fs.createReadStream(abs));
  });
}
