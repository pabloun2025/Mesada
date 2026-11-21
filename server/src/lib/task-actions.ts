import { one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { familyToday, getFamily } from './family.js';
import { addPoints } from './ledger.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { evaluateBadges } from './gamification.js';
import { dayEnd, deadlineAt, isHoliday, reducedPoints } from './deadline.js';
import { grantBonus } from './bonus.js';

interface InstanceRow {
  id: string;
  task_id: string;
  family_id: string;
  assignee_id: string | null;
  due_date: string;
  status: string;
  points: number;
  completed_by: string | null;
  title: string;
  requires_approval: boolean;
  requires_photo: boolean;
  check_mode: boolean;
  due_time: string | null;
  due_time_weekend: string | null;
  late_percent: number;
  task_points: number;
  on_time: boolean | null;
}

async function loadInstance(db: Db, id: string, familyId: string, lock = false) {
  const row = await one<InstanceRow>(
    db,
    `SELECT i.*, t.title, t.requires_approval, t.requires_photo, t.check_mode, t.due_time, t.due_time_weekend, t.late_percent, t.points AS task_points
       FROM task_instances i JOIN tasks t ON t.id = i.task_id
      WHERE i.id = $1 AND i.family_id = $2 ${lock ? 'FOR UPDATE OF i' : ''}`,
    [id, familyId],
  );
  if (!row) throw notFound('Tarea no encontrada');
  return row;
}

/** ¿Puede este usuario completar la ocurrencia? */
async function canComplete(db: Db, inst: InstanceRow, user: AuthUser) {
  if (inst.assignee_id) return inst.assignee_id === user.id;
  const r = await one(db, 'SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2', [inst.task_id, user.id]);
  return !!r;
}

async function award(db: Db, inst: InstanceRow, userId: string, points: number, actorId: string | null) {
  await addPoints(db, {
    familyId: inst.family_id,
    userId,
    delta: points,
    kind: 'task',
    refId: inst.id,
    note: inst.title,
    createdBy: actorId,
    idempotencyKey: `task:${inst.id}`,
  });
}

export async function completeInstance(
  user: AuthUser,
  instanceId: string,
  opts: { note?: string; photoPath?: string | null; now?: Date },
) {
  const now = opts.now ?? new Date();
  return tx(async (db) => {
    const fam = await getFamily(db, user.familyId);
    const today = familyToday(fam, now);
    const inst = await loadInstance(db, instanceId, user.familyId, true);
    if (!(await canComplete(db, inst, user))) throw forbidden('Esta tarea no está asignada a ti');
    if (inst.check_mode) throw forbidden('Esta tarea la marca un adulto');
    if (inst.due_date > today) throw badRequest('Esta tarea todavía no toca', 'not_due');
    if (!['pending', 'rejected', 'expired'].includes(inst.status)) throw conflict('Esta tarea ya está marcada', 'already_done');
    if (inst.status === 'expired' && inst.due_date < today) {
      // Las vencidas solo puede marcarlas un adulto (vía revisión).
      throw conflict('El plazo de esta tarea ha terminado. Pide a un adulto que la revise.', 'expired');
    }
    if (inst.requires_photo && !opts.photoPath) throw badRequest('Esta tarea necesita una foto como prueba', 'photo_required');

    // Hora límite: cuenta el momento de pulsar «Hecha». Hasta las 23:59 se puede hacer con el % de tarde.
    const holiday = await isHoliday(db, user.familyId, inst.due_date);
    const dl = deadlineAt(inst, inst.due_date, holiday, fam.timezone);
    let points = inst.points;
    let onTime: boolean | null = null;
    if (dl) {
      if (now >= dayEnd(inst.due_date, fam.timezone)) throw conflict('El plazo de esta tarea ha terminado. Pide a un adulto que la revise.', 'expired');
      // Si ya la hizo a tiempo y la devolvieron para repasar, no pierde el valor completo.
      onTime = inst.on_time === true || now <= dl;
      // Tras un rechazo, `inst.points` ya puede venir reducido: se parte de los puntos de la tarea.
      const base = inst.on_time === null ? inst.points : inst.task_points;
      points = onTime ? base : reducedPoints(base, inst.late_percent);
    }

    const autoApprove = !inst.requires_approval;
    const status = autoApprove ? 'approved' : 'submitted';
    await db.query(
      `UPDATE task_instances
          SET status = $2, completed_by = $3, completed_at = $6, child_note = $4,
              photo_path = COALESCE($5, photo_path),
              reviewed_at = CASE WHEN $2 = 'approved' THEN $6::timestamptz END,
              review_note = NULL, points = $7, deadline_at = $8, on_time = $9
        WHERE id = $1`,
      [inst.id, status, user.id, opts.note?.slice(0, 500) ?? null, opts.photoPath ?? null, now, points, dl, onTime],
    );
    if (autoApprove) {
      await award(db, inst, user.id, points, null);
      await grantBonus(db, { instanceId: inst.id, userId: user.id, familyId: user.familyId, actorId: null, onTime });
      await evaluateBadges(db, user.id, today, fam.timezone, (await one(db, 'SELECT weekly_goal_points FROM users WHERE id=$1', [user.id]))!.weekly_goal_points);
    } else {
      await notifyAdults(db, user.familyId, { event: 'task_submitted', title: `${user.displayName} ha terminado «${inst.title}»`, body: 'Pendiente de validar', link: '/validar', dedupeKey: `submitted:${inst.id}:${Date.now()}` });
    }
    await audit(db, user.familyId, user.id, 'task.complete', 'task_instance', inst.id, { status });
    return { id: inst.id, status, points: autoApprove ? points : 0, onTime, potentialPoints: points };
  });
}

export async function reviewInstance(
  adult: AuthUser,
  instanceId: string,
  decision: { approve: boolean; points?: number; note?: string },
) {
  return tx(async (db) => {
    const fam = await getFamily(db, adult.familyId);
    const inst = await loadInstance(db, instanceId, adult.familyId, true);
    // Un adulto puede validar lo enviado, o dar por hecha una pendiente/vencida.
    if (!['submitted', 'pending', 'expired', 'rejected'].includes(inst.status)) {
      throw conflict('Esta tarea ya se ha revisado', 'already_reviewed');
    }
    if (inst.check_mode) throw badRequest('Las tareas de comprobación se marcan como cumplidas o no cumplidas', 'check_task');
    const beneficiary = inst.completed_by ?? inst.assignee_id;
    if (decision.approve) {
      if (!beneficiary) throw badRequest('Nadie ha marcado esta tarea compartida todavía');
      const points = decision.points ?? inst.points;
      if (!Number.isInteger(points) || points < 0 || points > 10000) throw badRequest('Puntos no válidos');
      await db.query(
        `UPDATE task_instances SET status = 'approved', points = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4,
                completed_by = COALESCE(completed_by, $5), completed_at = COALESCE(completed_at, now())
          WHERE id = $1`,
        [inst.id, points, adult.id, decision.note ?? null, beneficiary],
      );
      await award(db, inst, beneficiary, points, adult.id);
      const grant = await grantBonus(db, { instanceId: inst.id, userId: beneficiary, familyId: adult.familyId, actorId: adult.id, onTime: inst.on_time });
      if (points !== inst.points) {
        await audit(db, adult.familyId, adult.id, 'task.points_changed', 'task_instance', inst.id, { from: inst.points, to: points });
      }
      await notify(db, { userId: beneficiary, event: 'task_approved', title: `«${inst.title}» aprobada`, body: `+${points} puntos${grant ? (grant.surprise ? ' · 🎁 ¡y una sorpresa!' : ` · ${grant.label}`) : ''}`, link: '/progreso', dedupeKey: `approved:${inst.id}` });
      await evaluateBadges(db, beneficiary, familyToday(fam), fam.timezone, (await one(db, 'SELECT weekly_goal_points FROM users WHERE id=$1', [beneficiary]))!.weekly_goal_points);
    } else {
      if (inst.status !== 'submitted') throw conflict('Solo se pueden rechazar tareas enviadas', 'not_submitted');
      await db.query(
        `UPDATE task_instances SET status = 'rejected', reviewed_by = $2, reviewed_at = now(), review_note = $3 WHERE id = $1`,
        [inst.id, adult.id, decision.note ?? null],
      );
      if (beneficiary) {
        await notify(db, { userId: beneficiary, event: 'task_rejected', title: `«${inst.title}» necesita un repaso`, body: decision.note ?? '', link: '/' });
      }
    }
    await audit(db, adult.familyId, adult.id, decision.approve ? 'task.approve' : 'task.reject', 'task_instance', inst.id, {
      points: decision.points ?? inst.points,
      note: decision.note ?? null,
    });
    return { id: inst.id, status: decision.approve ? 'approved' : 'rejected' };
  });
}
