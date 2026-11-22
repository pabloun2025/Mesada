import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { familyToday, getFamily } from '../lib/family.js';
import { ensureInstancesThrottled } from '../lib/instances.js';
import { notify } from '../lib/notify/dispatch.js';
import { bonusBody, canUnmark, claimedTasks, dateStr, shapeBonus } from './tasks.js';

/**
 * Trabajos extra (I11). El catálogo son filas de `tasks` con is_extra (sin asignados); cada activación es una
 * ocurrencia en `task_instances` con is_extra: así se reutilizan puntos, bonos, foto y validación sin sistema paralelo.
 * Libre = assignee_id NULL; reservada = assignee_id del hijo que la pidió.
 */

const extraBody = z.object({
  title: z.string().trim().min(1).max(100),
  description: z.string().max(1000).default(''),
  icon: z.string().max(16).default('🧰'),
  points: z.number().int().min(0).max(10000),
  requiresApproval: z.boolean().default(true),
  requiresPhoto: z.boolean().default(false),
  bonus: bonusBody.nullable().default(null),
});

const CATALOG_SELECT = `
  SELECT t.id, t.title, t.description, t.icon, t.points, t.requires_approval, t.requires_photo,
         t.bonus_kind, t.bonus_points, t.bonus_minutes, t.bonus_text, t.bonus_reward_id, t.bonus_surprise, t.bonus_on_time_only,
         rw.title AS bonus_reward_title,
         (SELECT i.id FROM task_instances i WHERE i.task_id = t.id AND i.is_extra AND i.status IN ('pending','submitted','rejected') LIMIT 1) AS open_instance_id
    FROM tasks t LEFT JOIN rewards rw ON rw.id = t.bonus_reward_id`;

const BOARD_SELECT = `
  SELECT i.id, i.task_id, i.status, i.points, i.due_date, i.extra_deadline, i.reserved_at, i.assignee_id, i.completed_by,
         (i.photo_path IS NOT NULL) AS has_photo, i.review_note, i.completed_at, (i.reviewed_by IS NOT NULL) AS adult_reviewed,
         t.title, t.icon, t.description, t.requires_photo, t.requires_approval, t.points AS task_points,
         t.bonus_kind, t.bonus_points, t.bonus_minutes, t.bonus_text, t.bonus_reward_id, t.bonus_surprise, t.bonus_on_time_only,
         rw.title AS bonus_reward_title,
         COALESCE(au.display_name, cu.display_name) AS holder_name, COALESCE(au.avatar, cu.avatar) AS holder_avatar
    FROM task_instances i
    JOIN tasks t ON t.id = i.task_id
    LEFT JOIN users au ON au.id = i.assignee_id
    LEFT JOIN users cu ON cu.id = i.completed_by
    LEFT JOIN rewards rw ON rw.id = t.bonus_reward_id
   WHERE i.family_id = $1 AND i.is_extra AND i.status IN ('pending','submitted','rejected')
   ORDER BY i.extra_deadline NULLS LAST, i.created_at`;

async function validateReward(familyId: string, b: z.infer<typeof extraBody>) {
  if (b.bonus?.kind !== 'reward') return;
  const r = await one(getPool(), 'SELECT 1 FROM rewards WHERE id = $1 AND family_id = $2 AND active', [b.bonus.rewardId, familyId]);
  if (!r) throw badRequest('La recompensa del bono no existe');
}

function params(b: z.infer<typeof extraBody>) {
  return [
    b.title, b.description, b.icon, b.points, b.requiresApproval, b.requiresPhoto,
    b.bonus?.kind ?? null, b.bonus?.kind === 'points' ? b.bonus.points : null, b.bonus?.kind === 'screen' ? b.bonus.minutes : null,
    b.bonus?.kind === 'text' ? b.bonus.text : null, b.bonus?.kind === 'reward' ? b.bonus.rewardId : null,
    b.bonus?.surprise ?? false, b.bonus?.onTimeOnly ?? false,
  ];
}

export default async function extraRoutes(app: FastifyInstance) {
  // Tablón (todos) y catálogo (solo adultos).
  app.get('/api/extras', async (req) => {
    const u = requireUser(req);
    await ensureInstancesThrottled(getPool(), u.familyId); // retira las de plazo vencido
    const rows = await many(getPool(), BOARD_SELECT, [u.familyId]);
    const claimed = u.role === 'child' ? await claimedTasks(u.id) : new Set<string>();
    const fam = await getFamily(getPool(), u.familyId);
    const today = familyToday(fam);
    const board = rows.map((r) => {
      const s = shapeBonus(r, u.role, claimed, r.task_id) as any;
      return { ...s, mine: r.assignee_id === u.id || r.completed_by === u.id, can_unmark: canUnmark(u, r, fam.timezone, today) };
    });
    if (u.role === 'child') return { board };
    const catalog = (await many(getPool(), `${CATALOG_SELECT} WHERE t.family_id = $1 AND t.is_extra AND t.active ORDER BY t.title`, [u.familyId])).map((r) => shapeBonus(r, 'adult', new Set(), r.id));
    return { board, catalog };
  });

  app.post('/api/extras', async (req) => {
    const u = requireAdult(req);
    const b = extraBody.parse(req.body);
    await validateReward(u.familyId, b);
    const fam = await getFamily(getPool(), u.familyId);
    const id = await tx(async (db) => {
      const t = await one(
        db,
        `INSERT INTO tasks(family_id, is_extra, recurrence, start_date, assignment_mode, title, description, icon, points, requires_approval, requires_photo,
                           bonus_kind, bonus_points, bonus_minutes, bonus_text, bonus_reward_id, bonus_surprise, bonus_on_time_only, created_by)
         VALUES ($1, true, 'once', $2, 'individual', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $3) RETURNING id`,
        [u.familyId, familyToday(fam), u.id, ...params(b)],
      );
      await audit(db, u.familyId, u.id, 'extra.create', 'task', t.id, { title: b.title, points: b.points });
      return t.id as string;
    });
    return { id };
  });

  app.put('/api/extras/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = extraBody.parse(req.body);
    await validateReward(u.familyId, b);
    await tx(async (db) => {
      const r = await db.query(
        `UPDATE tasks SET title=$3, description=$4, icon=$5, points=$6, requires_approval=$7, requires_photo=$8, bonus_kind=$9, bonus_points=$10, bonus_minutes=$11,
                bonus_text=$12, bonus_reward_id=$13, bonus_surprise=$14, bonus_on_time_only=$15, updated_at=now()
          WHERE id=$1 AND family_id=$2 AND is_extra AND active`,
        [id, u.familyId, ...params(b)],
      );
      if (!r.rowCount) throw notFound('Trabajo extra no encontrado');
      // Lo ya publicado y sin hacer toma los puntos nuevos; lo enviado conserva los suyos.
      await db.query(`UPDATE task_instances SET points = $2 WHERE task_id = $1 AND is_extra AND status = 'pending'`, [id, b.points]);
      await audit(db, u.familyId, u.id, 'extra.update', 'task', id, { title: b.title, points: b.points });
    });
    return { ok: true };
  });

  app.delete('/api/extras/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await tx(async (db) => {
      const r = await db.query('UPDATE tasks SET active = false, updated_at = now() WHERE id = $1 AND family_id = $2 AND is_extra AND active', [id, u.familyId]);
      if (!r.rowCount) throw notFound('Trabajo extra no encontrado');
      await db.query(`DELETE FROM task_instances WHERE task_id = $1 AND is_extra AND status IN ('pending','rejected')`, [id]);
      await audit(db, u.familyId, u.id, 'extra.archive', 'task', id);
    });
    return { ok: true };
  });

  // El adulto lo pone en el tablón, con plazo opcional.
  app.post('/api/extras/:id/activate', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ deadline: dateStr.nullable().default(null) }).parse(req.body ?? {});
    return tx(async (db) => {
      const fam = await getFamily(db, u.familyId);
      const today = familyToday(fam);
      if (b.deadline && b.deadline < today) throw badRequest('El plazo ya ha pasado');
      const t = await one(db, 'SELECT id, title, points FROM tasks WHERE id = $1 AND family_id = $2 AND is_extra AND active FOR UPDATE', [id, u.familyId]);
      if (!t) throw notFound('Trabajo extra no encontrado');
      const open = await one(db, `SELECT 1 FROM task_instances WHERE task_id = $1 AND is_extra AND status IN ('pending','submitted','rejected')`, [id]);
      if (open) throw conflict('Este trabajo ya está en el tablón', 'already_active');
      const inst = await one(
        db,
        `INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points, is_extra, extra_deadline) VALUES ($1, $2, NULL, $3, $4, true, $5) RETURNING id`,
        [id, u.familyId, today, t.points, b.deadline],
      );
      const kids = await many(db, `SELECT id FROM users WHERE family_id = $1 AND role = 'child' AND active`, [u.familyId]);
      for (const k of kids) {
        await notify(db, {
          userId: k.id, event: 'task_assigned', title: `Trabajo extra: ${t.title}`, body: `+${t.points} puntos · ¡el primero que se la pida se la queda!`,
          link: '/extras', dedupeKey: `extra:${inst.id}:${k.id}`,
        });
      }
      await audit(db, u.familyId, u.id, 'extra.activate', 'task_instance', inst.id, { title: t.title, deadline: b.deadline });
      return { id: inst.id as string };
    });
  });

  // «Me la pido»: gana el primero; quien llega después recibe 409 con el nombre de quien la tiene.
  app.post('/api/extra-instances/:id/claim', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo los hijos se piden trabajos extra');
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return tx(async (db) => {
      const today = familyToday(await getFamily(db, u.familyId));
      const up = await db.query(
        `UPDATE task_instances SET assignee_id = $3, reserved_at = now()
          WHERE id = $1 AND family_id = $2 AND is_extra AND status = 'pending' AND assignee_id IS NULL
            AND (extra_deadline IS NULL OR extra_deadline >= $4)`,
        [id, u.familyId, u.id, today],
      );
      if (!up.rowCount) {
        const cur = await one(
          db,
          `SELECT i.assignee_id, i.extra_deadline, i.status, a.display_name FROM task_instances i LEFT JOIN users a ON a.id = i.assignee_id
            WHERE i.id = $1 AND i.family_id = $2 AND i.is_extra`,
          [id, u.familyId],
        );
        if (!cur) throw notFound('Ese trabajo ya no está en el tablón');
        if (cur.assignee_id === u.id) return { id, reserved: true }; // repetido: idempotente
        if (cur.assignee_id) throw conflict(`La tiene ${cur.display_name}`, 'taken');
        throw new HttpError(409, 'El plazo de este trabajo ha terminado', 'expired');
      }
      await audit(db, u.familyId, u.id, 'extra.claim', 'task_instance', id);
      return { id, reserved: true };
    });
  });

  // El adulto la libera (si aún no la han enviado) o la retira del tablón.
  app.post('/api/extra-instances/:id/release', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await getPool().query(
      `UPDATE task_instances SET assignee_id = NULL, reserved_at = NULL, status = 'pending', review_note = NULL
        WHERE id = $1 AND family_id = $2 AND is_extra AND status IN ('pending','rejected')`,
      [id, u.familyId],
    );
    if (!r.rowCount) throw conflict('Ya se ha enviado o no está en el tablón', 'not_releasable');
    return { ok: true };
  });

  app.delete('/api/extra-instances/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await getPool().query(`DELETE FROM task_instances WHERE id = $1 AND family_id = $2 AND is_extra AND status IN ('pending','rejected')`, [id, u.familyId]);
    if (!r.rowCount) throw conflict('Ya se ha enviado o no está en el tablón', 'not_removable');
    return { ok: true };
  });
}
