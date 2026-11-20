import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getPool, many, one, tx } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { config } from '../lib/config.js';
import { familyToday, getFamily } from '../lib/family.js';
import { ensureInstancesThrottled, regenerateTask } from '../lib/instances.js';
import { completeInstance, reviewInstance } from '../lib/task-actions.js';
import { isValidDate } from '../lib/dates.js';

const dateStr = z.string().refine(isValidDate, 'fecha no válida');

const taskBody = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().max(1000).default(''),
    icon: z.string().max(16).default('✅'),
    difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
    points: z.number().int().min(0).max(10000),
    recurrence: z.enum(['once', 'daily', 'weekly', 'monthly']),
    weekdays: z.array(z.number().int().min(1).max(7)).max(7).default([]),
    monthDay: z.number().int().min(1).max(31).nullable().default(null),
    startDate: dateStr,
    endDate: dateStr.nullable().default(null),
    dueTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().default(null),
    assignmentMode: z.enum(['individual', 'shared', 'rotation']).default('individual'),
    assignees: z.array(z.string().uuid()).min(1, 'asigna la tarea al menos a una persona').max(20),
    requiresApproval: z.boolean().default(true),
    requiresPhoto: z.boolean().default(false),
  })
  .refine((t) => !t.endDate || t.endDate >= t.startDate, { message: 'la fecha de fin es anterior al inicio', path: ['endDate'] })
  .refine((t) => t.recurrence !== 'weekly' || t.weekdays.length > 0, { message: 'elige al menos un día de la semana', path: ['weekdays'] });

const TASK_SELECT = `
  SELECT t.*, COALESCE(json_agg(json_build_object('id', u.id, 'display_name', u.display_name, 'avatar', u.avatar, 'color', u.color) ORDER BY a.position)
         FILTER (WHERE u.id IS NOT NULL), '[]') AS assignees
    FROM tasks t LEFT JOIN task_assignees a ON a.task_id = t.id LEFT JOIN users u ON u.id = a.user_id`;

async function validateAssignees(familyId: string, ids: string[]) {
  const rows = await many(getPool(), `SELECT id FROM users WHERE family_id = $1 AND id = ANY($2::uuid[]) AND active`, [familyId, ids]);
  if (rows.length !== new Set(ids).size) throw badRequest('Alguna persona asignada no pertenece a la familia');
}

const INSTANCE_SELECT = `
  SELECT i.id, i.task_id, i.assignee_id, i.due_date, i.status, i.points, i.completed_by, i.completed_at, i.child_note,
         (i.photo_path IS NOT NULL) AS has_photo, i.reviewed_at, i.review_note,
         t.title, t.icon, t.description, t.difficulty, t.recurrence, t.assignment_mode, t.requires_approval, t.requires_photo, t.due_time,
         au.display_name AS assignee_name, au.avatar AS assignee_avatar, au.color AS assignee_color,
         cu.display_name AS completed_by_name
    FROM task_instances i
    JOIN tasks t ON t.id = i.task_id
    LEFT JOIN users au ON au.id = i.assignee_id
    LEFT JOIN users cu ON cu.id = i.completed_by`;

export default async function taskRoutes(app: FastifyInstance) {
  app.get('/api/tasks', async (req) => {
    const u = requireUser(req);
    const rows = await many(
      getPool(),
      `${TASK_SELECT} WHERE t.family_id = $1 AND t.active
         ${u.role === 'child' ? 'AND EXISTS (SELECT 1 FROM task_assignees x WHERE x.task_id = t.id AND x.user_id = $2)' : 'AND $2::uuid IS NOT NULL'}
       GROUP BY t.id ORDER BY t.created_at DESC`,
      [u.familyId, u.id],
    );
    return { tasks: rows };
  });

  app.post('/api/tasks', async (req) => {
    const u = requireAdult(req);
    const b = taskBody.parse(req.body);
    await validateAssignees(u.familyId, b.assignees);
    const id = await tx(async (db) => {
      const t = await one(
        db,
        `INSERT INTO tasks(family_id, title, description, icon, difficulty, points, recurrence, weekdays, month_day, start_date, end_date, due_time,
                           assignment_mode, requires_approval, requires_photo, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [u.familyId, b.title, b.description, b.icon, b.difficulty, b.points, b.recurrence, b.weekdays, b.monthDay, b.startDate, b.endDate, b.dueTime, b.assignmentMode, b.requiresApproval, b.requiresPhoto, u.id],
      );
      await db.query(`INSERT INTO task_assignees(task_id, user_id, position) SELECT $1, x, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS y(x, ord)`, [t.id, b.assignees]);
      await audit(db, u.familyId, u.id, 'task.create', 'task', t.id, { title: b.title, points: b.points });
      await regenerateTask(db, u.familyId, t.id);
      return t.id as string;
    });
    return { task: await one(getPool(), `${TASK_SELECT} WHERE t.id = $1 GROUP BY t.id`, [id]) };
  });

  app.put('/api/tasks/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = taskBody.parse(req.body);
    await validateAssignees(u.familyId, b.assignees);
    await tx(async (db) => {
      const r = await db.query(
        `UPDATE tasks SET title=$3, description=$4, icon=$5, difficulty=$6, points=$7, recurrence=$8, weekdays=$9, month_day=$10, start_date=$11,
                end_date=$12, due_time=$13, assignment_mode=$14, requires_approval=$15, requires_photo=$16, updated_at=now()
          WHERE id=$1 AND family_id=$2 AND active`,
        [id, u.familyId, b.title, b.description, b.icon, b.difficulty, b.points, b.recurrence, b.weekdays, b.monthDay, b.startDate, b.endDate, b.dueTime, b.assignmentMode, b.requiresApproval, b.requiresPhoto],
      );
      if (!r.rowCount) throw notFound('Tarea no encontrada');
      await db.query('DELETE FROM task_assignees WHERE task_id = $1', [id]);
      await db.query(`INSERT INTO task_assignees(task_id, user_id, position) SELECT $1, x, ord FROM unnest($2::uuid[]) WITH ORDINALITY AS y(x, ord)`, [id, b.assignees]);
      await audit(db, u.familyId, u.id, 'task.update', 'task', id, { title: b.title, points: b.points });
      await regenerateTask(db, u.familyId, id);
    });
    return { task: await one(getPool(), `${TASK_SELECT} WHERE t.id = $1 GROUP BY t.id`, [id]) };
  });

  app.delete('/api/tasks/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await tx(async (db) => {
      const r = await db.query('UPDATE tasks SET active = false, updated_at = now() WHERE id = $1 AND family_id = $2 AND active', [id, u.familyId]);
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
          AND ($4::text[] IS NULL OR i.status = ANY($4))
          AND ($5::uuid IS NULL OR i.assignee_id = $5 OR i.completed_by = $5
               OR (i.assignee_id IS NULL AND EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = i.task_id AND a.user_id = $5)))
        ORDER BY i.due_date, t.due_time NULLS LAST, t.title
        LIMIT 1000`,
      [u.familyId, q.from ?? today, q.to ?? q.from ?? today, statuses, who],
    );
    return { today, instances: rows };
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
          const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[part.mimetype];
          const rel = path.join(u.familyId, `${crypto.randomUUID()}.${ext}`);
          const abs = path.join(config.uploadDir, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          await pipeline(part.file, fs.createWriteStream(abs, { mode: 0o600 }));
          if (part.file.truncated) {
            fs.rmSync(abs, { force: true });
            throw badRequest('La foto es demasiado grande');
          }
          photoPath = rel;
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
      if (photoPath) fs.rmSync(path.join(config.uploadDir, photoPath), { force: true });
      throw e;
    }
  });

  app.post('/api/instances/:id/review', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ approve: z.boolean(), points: z.number().int().min(0).max(10000).optional(), note: z.string().max(500).optional() }).parse(req.body);
    return reviewInstance(u, id, b);
  });

  // Foto de evidencia: solo adultos de la familia o quien la subió.
  app.get('/api/instances/:id/photo', async (req, reply) => {
    const u = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const row = await one(getPool(), 'SELECT photo_path, completed_by FROM task_instances WHERE id = $1 AND family_id = $2', [id, u.familyId]);
    if (!row?.photo_path) throw notFound('Sin foto');
    if (u.role !== 'adult' && row.completed_by !== u.id) throw forbidden();
    const abs = path.resolve(config.uploadDir, row.photo_path);
    if (!abs.startsWith(path.resolve(config.uploadDir) + path.sep) || !fs.existsSync(abs)) throw notFound('Sin foto');
    const ext = path.extname(abs).slice(1);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    return reply.send(fs.createReadStream(abs));
  });
}
