import { one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { addDays } from './dates.js';
import { badRequest, conflict, forbidden, notFound } from './errors.js';
import { familyToday, getFamily } from './family.js';
import { addPoints, lockUser } from './ledger.js';
import { addScreen } from './screen.js';
import { audit } from './audit.js';
import { notify, notifyAdults } from './notify/dispatch.js';
import { removePhotoFile } from './photos.js';
import { evaluateBadges, revokeBadgesFrom } from './gamification.js';
import { dayEnd, deadlineAt, isHoliday, reducedPoints } from './deadline.js';
import { grantBonus, voidBonus } from './bonus.js';
import { applyRecovery, reverseRecovery } from './screen-adjust.js';
import { todayIn } from './dates.js';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { spawnRepeats } from './instances.js';

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
  first_submitted_at: string | null;
  is_extra: boolean;
  extra_deadline: string | null;
  repeatable: boolean;
  max_per_day: number | null;
  cooldown_days: number | null;
  unmark_count: number;
  completed_at: string | null;
  reviewed_by: string | null;
  returned_at: string | null;
  returned_note: string | null;
  photo_path: string | null;
}

async function loadInstance(db: Db, id: string, familyId: string, lock = false) {
  const row = await one<InstanceRow>(
    db,
    `SELECT i.*, t.title, t.requires_approval, t.requires_photo, t.check_mode, t.due_time, t.due_time_weekend, t.late_percent, t.points AS task_points, t.repeatable, t.max_per_day, t.cooldown_days
       FROM task_instances i JOIN tasks t ON t.id = i.task_id
      WHERE i.id = $1 AND i.family_id = $2 ${lock ? 'FOR UPDATE OF i' : ''}`,
    [id, familyId],
  );
  if (!row) throw notFound('Tarea no encontrada');
  return row;
}

/** ¿Puede este usuario completar la ocurrencia? */
async function canComplete(db: Db, inst: InstanceRow, user: AuthUser) {
  if (inst.is_extra) return inst.assignee_id === user.id; // un trabajo extra solo lo hace quien lo reservó
  if (inst.assignee_id) return inst.assignee_id === user.id;
  const r = await one(db, 'SELECT 1 FROM task_assignees WHERE task_id = $1 AND user_id = $2', [inst.task_id, user.id]);
  return !!r;
}

/** La clave de los puntos lleva el nº de desmarcados: tras desmarcar y volver a marcar, se conceden otra vez. */
const awardKey = (inst: { id: string; unmark_count: number }) => (inst.unmark_count ? `task:${inst.id}:u${inst.unmark_count}` : `task:${inst.id}`);

async function award(db: Db, inst: InstanceRow, userId: string, points: number, actorId: string | null) {
  await addPoints(db, {
    familyId: inst.family_id,
    userId,
    delta: points,
    kind: 'task',
    refId: inst.id,
    note: inst.title,
    createdBy: actorId,
    idempotencyKey: awardKey(inst),
  });
}

export async function completeInstance(
  user: AuthUser,
  instanceId: string,
  opts: { note?: string; photoPath?: string | null; now?: Date },
) {
  const now = opts.now ?? new Date();
  let replaced: string | null = null;
  const result = await tx(async (db) => {
    const fam = await getFamily(db, user.familyId);
    const today = familyToday(fam, now);
    const inst = await loadInstance(db, instanceId, user.familyId, true);
    // Si sustituye una foto anterior (tarea devuelta y reenviada), el archivo viejo se borra al confirmar.
    if (opts.photoPath && inst.photo_path && inst.photo_path !== opts.photoPath) replaced = inst.photo_path;
    if (!(await canComplete(db, inst, user))) {
      if (inst.is_extra) throw forbidden(inst.assignee_id ? 'Este trabajo lo tiene otra persona' : 'Primero pulsa «Me la pido»');
      throw forbidden('Esta tarea no está asignada a ti');
    }
    if (inst.check_mode) throw forbidden('Esta tarea la marca un adulto');
    if (inst.is_extra) {
      if (inst.extra_deadline && inst.extra_deadline < today) throw conflict('El plazo de este trabajo ha terminado.', 'expired');
    }
    if (inst.due_date > today) throw badRequest('Esta tarea todavía no toca', 'not_due');
    if (!['pending', 'rejected', 'expired'].includes(inst.status)) throw conflict('Esta tarea ya está marcada', 'already_done');
    if (inst.status === 'expired' && inst.due_date < today) {
      // Las vencidas solo puede marcarlas un adulto (vía revisión).
      throw conflict('El plazo de esta tarea ha terminado. Pide a un adulto que la revise.', 'expired');
    }
    if (inst.cooldown_days) {
      // Cuenta la pulsación de «Hecha», no la validación; una rechazada ya no cuenta.
      const last = await one<{ d: string | null }>(db, `SELECT max((completed_at AT TIME ZONE $3)::date)::text AS d FROM task_instances WHERE task_id = $1 AND id <> $2 AND status IN ('submitted','approved')`, [inst.task_id, inst.id, fam.timezone]);
      if (last?.d && addDays(last.d, inst.cooldown_days) > today) throw conflict('Esta tarea todavía no vuelve', 'cooldown');
    }
    if (inst.repeatable && inst.max_per_day !== null) {
      // Tope diario: compartida = entre todos; si no, por hijo. Las rechazadas no cuentan.
      await db.query('SELECT 1 FROM tasks WHERE id = $1 FOR UPDATE', [inst.task_id]); // serializa a los hijos de una tarea compartida
      const n = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1 AND due_date = $2 AND id <> $3 AND status IN ('submitted','approved') AND assignee_id IS NOT DISTINCT FROM $4::uuid`, [inst.task_id, inst.due_date, inst.id, inst.assignee_id]);
      if (n!.n >= inst.max_per_day) throw conflict('Ya se ha hecho el máximo de veces de hoy', 'max_per_day');
    }
    if (inst.requires_photo && !opts.photoPath) throw badRequest('Esta tarea necesita una foto como prueba', 'photo_required');

    // Hora límite: cuenta el momento de pulsar «Hecha». Hasta las 23:59 se puede hacer con el % de tarde.
    const holiday = await isHoliday(db, user.familyId, inst.due_date);
    const dl = deadlineAt(inst, inst.due_date, holiday, fam.timezone);
    let points = inst.points;
    let onTime: boolean | null = null;
    if (dl) {
      // Devuelta para repasar: ya se envió una vez dentro de plazo, así que puede reenviarla aunque haya acabado el día.
      if (!inst.first_submitted_at && now >= dayEnd(inst.due_date, fam.timezone)) throw conflict('El plazo de esta tarea ha terminado. Pide a un adulto que la revise.', 'expired');
      // La hora límite se juzga con la PRIMERA vez que la envió: si llegó a tiempo, sigue a tiempo al reenviarla.
      onTime = (inst.first_submitted_at ? new Date(inst.first_submitted_at) : now) <= dl;
      // Tras un rechazo, `inst.points` ya puede venir reducido: se parte de los puntos de la tarea.
      const base = inst.first_submitted_at ? inst.task_points : inst.points;
      points = onTime ? base : reducedPoints(base, inst.late_percent);
    }

    const autoApprove = !inst.requires_approval;
    const status = autoApprove ? 'approved' : 'submitted';
    await db.query(
      `UPDATE task_instances
          SET status = $2, completed_by = $3, completed_at = $6, first_submitted_at = COALESCE(first_submitted_at, $6), child_note = $4,
              photo_path = COALESCE($5, photo_path), photo_deleted_at = CASE WHEN $5::text IS NOT NULL THEN NULL ELSE photo_deleted_at END,
              reviewed_at = CASE WHEN $2 = 'approved' THEN $6::timestamptz END,
              review_note = NULL, review_outcome = NULL, points = $7, deadline_at = $8, on_time = $9
        WHERE id = $1`,
      [inst.id, status, user.id, opts.note?.slice(0, 500) ?? null, opts.photoPath ?? null, now, points, dl, onTime],
    );
    if (autoApprove) {
      await award(db, inst, user.id, points, null);
      await grantBonus(db, { instanceId: inst.id, userId: user.id, familyId: user.familyId, actorId: null, onTime, seq: inst.unmark_count + 1 });
      if (inst.is_extra) await applyRecovery(db, inst, user.id, today, null);
      await evaluateBadges(db, user.id, today, fam.timezone, (await one(db, 'SELECT weekly_goal_points FROM users WHERE id=$1', [user.id]))!.weekly_goal_points, inst.id);
    } else {
      await notifyAdults(db, user.familyId, { event: 'task_submitted', title: `${user.displayName} ha terminado «${inst.title}»`, body: 'Pendiente de validar', link: '/validar', dedupeKey: `submitted:${inst.id}:${Date.now()}` });
    }
    if (inst.repeatable) await spawnRepeats(db, user.familyId, inst.due_date, inst.task_id);
    await audit(db, user.familyId, user.id, 'task.complete', 'task_instance', inst.id, { status });
    return { id: inst.id, status, points: autoApprove ? points : 0, onTime, potentialPoints: points };
  });
  removePhotoFile(replaced);
  return result;
}

export type ReviewAction = 'approve' | 'partial' | 'return' | 'reject' | 'reject_penalty';

export interface ReviewDecision {
  /** Compatibilidad: `approve: true` = aprobar; `approve: false` = devolver para repasar. */
  approve?: boolean;
  action?: ReviewAction;
  points?: number;
  note?: string;
  /** Solo «rechazar con penalidad»: por defecto, los puntos de la tarea. */
  penaltyPoints?: number;
  penaltyMinutes?: number;
}

export async function reviewInstance(adult: AuthUser, instanceId: string, decision: ReviewDecision) {
  const action: ReviewAction = decision.action ?? (decision.approve === false ? 'return' : 'approve');
  const note = decision.note?.trim() || undefined;
  // Con las acciones nuevas el motivo es obligatorio (el hijo lo ve); el «devolver» antiguo sigue admitiéndolo vacío.
  if (decision.action && action !== 'approve' && !note) throw badRequest('Escribe el motivo: el hijo lo verá', 'reason_required');
  return tx(async (db) => {
    const fam = await getFamily(db, adult.familyId);
    const inst = await loadInstance(db, instanceId, adult.familyId, true);
    const beneficiary = inst.completed_by ?? inst.assignee_id;
    if (inst.check_mode) throw badRequest('Las tareas de comprobación se marcan como cumplidas o no cumplidas', 'check_task');

    if (action === 'approve') {
      // Un adulto puede validar lo enviado, o dar por hecha una pendiente/vencida.
      if (!['submitted', 'pending', 'expired', 'rejected'].includes(inst.status)) throw conflict('Esta tarea ya se ha revisado', 'already_reviewed');
      if (!beneficiary) throw badRequest('Nadie ha marcado esta tarea compartida todavía');
      const points = decision.points ?? inst.points;
      if (!Number.isInteger(points) || points < 0 || points > 10000) throw badRequest('Puntos no válidos');
      await db.query(
        `UPDATE task_instances SET status = 'approved', review_outcome = 'approved', points = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4,
                completed_by = COALESCE(completed_by, $5), completed_at = COALESCE(completed_at, now())
          WHERE id = $1`,
        [inst.id, points, adult.id, note ?? null, beneficiary],
      );
      await award(db, inst, beneficiary, points, adult.id);
      if (inst.repeatable) await spawnRepeats(db, adult.familyId, inst.due_date, inst.task_id);
      const grant = await grantBonus(db, { instanceId: inst.id, userId: beneficiary, familyId: adult.familyId, actorId: adult.id, onTime: inst.on_time, seq: inst.unmark_count + 1 });
      if (inst.is_extra) await applyRecovery(db, inst, beneficiary, familyToday(fam), adult.id);
      if (points !== inst.points) {
        await audit(db, adult.familyId, adult.id, 'task.points_changed', 'task_instance', inst.id, { from: inst.points, to: points });
      }
      await notify(db, { userId: beneficiary, event: 'task_approved', title: `«${inst.title}» aprobada`, body: `+${points} puntos${grant ? (grant.surprise ? ' · 🎁 ¡y una sorpresa!' : ` · ${grant.label}`) : ''}`, link: '/progreso', dedupeKey: `approved:${inst.id}` });
      await evaluateBadges(db, beneficiary, familyToday(fam), fam.timezone, (await one(db, 'SELECT weekly_goal_points FROM users WHERE id=$1', [beneficiary]))!.weekly_goal_points, inst.id);
      await audit(db, adult.familyId, adult.id, 'task.approve', 'task_instance', inst.id, { points, note: note ?? null });
      return { id: inst.id, status: 'approved' };
    }

    // El resto solo se aplica a lo que el hijo ha enviado.
    if (inst.status !== 'submitted') throw conflict('Solo se pueden revisar tareas enviadas', 'not_submitted');
    if (!beneficiary) throw badRequest('Nadie ha marcado esta tarea compartida todavía');

    if (action === 'partial') {
      const points = decision.points;
      if (points === undefined || !Number.isInteger(points) || points < 0 || points > 10000) throw badRequest('Puntos no válidos');
      await db.query(
        `UPDATE task_instances SET status = 'approved', review_outcome = 'partial', points = $2, reviewed_by = $3, reviewed_at = now(), review_note = $4 WHERE id = $1`,
        [inst.id, points, adult.id, note],
      );
      await award(db, inst, beneficiary, points, adult.id);
      if (inst.repeatable) await spawnRepeats(db, adult.familyId, inst.due_date, inst.task_id);
      if (inst.is_extra) await applyRecovery(db, inst, beneficiary, familyToday(fam), adult.id);
      // Sin bono: ni el visible ni la sorpresa (que no se revela ni se gasta) se conceden con un premio parcial.
      await notify(db, { userId: beneficiary, event: 'task_approved', title: `«${inst.title}»: premio parcial`, body: `+${points} de ${inst.points} puntos · ${note}`, link: '/', dedupeKey: `approved:${inst.id}` });
      await evaluateBadges(db, beneficiary, familyToday(fam), fam.timezone, (await one(db, 'SELECT weekly_goal_points FROM users WHERE id=$1', [beneficiary]))!.weekly_goal_points, inst.id);
      await audit(db, adult.familyId, adult.id, 'task.partial', 'task_instance', inst.id, { points, of: inst.points, note: note ?? null });
      return { id: inst.id, status: 'approved', outcome: 'partial', points };
    }

    if (action === 'return') {
      await db.query(`UPDATE task_instances SET status = 'rejected', review_outcome = 'returned', reviewed_by = $2, reviewed_at = now(), review_note = $3, returned_at = now(), returned_note = $3 WHERE id = $1`, [inst.id, adult.id, note ?? null]);
      await notify(db, { userId: beneficiary, event: 'task_rejected', title: `«${inst.title}» necesita un repaso`, body: note ?? '', link: '/' });
      await audit(db, adult.familyId, adult.id, 'task.return', 'task_instance', inst.id, { note: note ?? null });
      return { id: inst.id, status: 'rejected' };
    }

    // Rechazo definitivo (sin o con penalidad): no cuenta como hecha ni da nada.
    let penaltyPoints = 0;
    let penaltyApplied = 0;
    if (action === 'reject_penalty') {
      penaltyPoints = decision.penaltyPoints ?? inst.task_points;
      const minutes = decision.penaltyMinutes ?? 0;
      if (!Number.isInteger(penaltyPoints) || penaltyPoints < 0 || penaltyPoints > 10000) throw badRequest('Puntos de penalidad no válidos');
      if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) throw badRequest('Minutos de penalidad no válidos');
      if (penaltyPoints === 0 && minutes === 0) throw badRequest('Indica cuántos puntos o minutos se restan', 'penalty_required');
      if (penaltyPoints > 0) {
        // Puede dejar el saldo por debajo de 0, como el resto del banco (D30).
        await addPoints(db, { familyId: adult.familyId, userId: beneficiary, delta: -penaltyPoints, kind: 'adjustment', refId: inst.id, note: `Penalidad: ${inst.title}`, createdBy: adult.id, idempotencyKey: `penalty-points:${inst.id}` });
      }
      if (minutes > 0) {
        // Los minutos se recortan al saldo: nunca bajan de 0 (D26/D27).
        const r = await addScreen(db, { familyId: adult.familyId, userId: beneficiary, delta: -minutes, kind: 'penalty', refId: inst.id, note: `«${inst.title}» rechazada`, createdBy: adult.id, idempotencyKey: `penalty-screen:${inst.id}` });
        penaltyApplied = -r.applied;
      }
    }
    await db.query(
      `UPDATE task_instances SET status = 'declined', review_outcome = $2, penalty_points = $3, penalty_screen = $4, reviewed_by = $5, reviewed_at = now(), review_note = $6 WHERE id = $1`,
      [inst.id, action === 'reject_penalty' ? 'penalized' : 'declined', penaltyPoints, penaltyApplied, adult.id, note],
    );
    const lost = [penaltyPoints ? `−${penaltyPoints} puntos` : '', penaltyApplied ? `−${penaltyApplied} min de pantalla` : ''].filter(Boolean).join(' y ');
    await notify(db, { userId: beneficiary, event: 'task_rejected', title: `«${inst.title}» rechazada`, body: `${note}${lost ? ` · ${lost}` : ''}`, link: '/' });
    await audit(db, adult.familyId, adult.id, action === 'reject' ? 'task.reject' : 'task.reject_penalty', 'task_instance', inst.id, { note, penaltyPoints, penaltyMinutes: penaltyApplied });
    return { id: inst.id, status: 'declined', penaltyPoints, penaltyMinutes: penaltyApplied };
  });
}

/**
 * El hijo desmarca una tarea que marcó por error (I17). Vuelve a pendiente como si nunca la hubiera marcado:
 * se deshacen puntos, bono y minutos con movimientos compensatorios (los libros no se editan), se borra la hora de envío
 * (si la vuelve a marcar cuenta la hora nueva) y, si es compartida, «cuando haga falta», repetible o extra, queda libre otra vez.
 * Solo vale mientras ningún adulto la haya validado; si no pedía validación, hasta el final del día en que se marcó.
 * Si un adulto la había devuelto para repasar, vuelve a «devuelta» y conserva la primera hora de envío.
 */
export async function unmarkInstance(user: AuthUser, instanceId: string, opts: { now?: Date } = {}) {
  if (user.role !== 'child') throw forbidden('Solo el hijo puede desmarcar su tarea');
  const now = opts.now ?? new Date();
  const out = await tx(async (db) => {
    const fam = await getFamily(db, user.familyId);
    const today = familyToday(fam, now);
    const inst = await loadInstance(db, instanceId, user.familyId, true);
    if (inst.check_mode) throw forbidden('Esta tarea la marca un adulto');
    if (!['submitted', 'approved'].includes(inst.status)) throw conflict('Esta tarea no está marcada', 'not_marked');
    if (inst.completed_by !== user.id) throw forbidden('Solo quien la marcó puede desmarcarla');
    if (inst.status === 'approved') {
      if (inst.reviewed_by) throw conflict('Un adulto ya la ha validado', 'already_validated');
      if (!inst.completed_at || todayIn(fam.timezone, new Date(inst.completed_at)) !== today) throw conflict('Ya ha pasado el día en que la marcaste', 'day_over');
    }
    if (inst.repeatable) {
      const later = await one(db, `SELECT 1 FROM task_instances WHERE task_id = $1 AND due_date = $2 AND assignee_id IS NOT DISTINCT FROM $3::uuid AND repeat_no > (SELECT repeat_no FROM task_instances WHERE id = $4) AND status IN ('submitted','approved')`, [inst.task_id, inst.due_date, inst.assignee_id, inst.id]);
      if (later) throw conflict('Primero desmarca la última vez que la hiciste', 'later_repeat_done');
    }
    if (inst.is_extra && inst.status === 'approved') {
      const open = await one(db, `SELECT 1 FROM task_instances WHERE task_id = $1 AND is_extra AND id <> $2 AND status IN ('pending','submitted','rejected')`, [inst.task_id, inst.id]);
      if (open) throw conflict('Este trabajo ya se ha vuelto a publicar', 'reactivated');
    }
    const grant = await one(db, 'SELECT fulfilled_at FROM bonus_grants WHERE instance_id = $1 AND voided_at IS NULL', [inst.id]);
    if (grant?.fulfilled_at) throw conflict('Ya se te entregó el premio de esta tarea', 'bonus_fulfilled');

    await lockUser(db, user.id);
    const n = inst.unmark_count + 1;
    let pointsBack = 0;
    if (inst.status === 'approved') {
      const earned = await one<{ delta: number }>(db, 'SELECT delta FROM points_ledger WHERE idempotency_key = $1', [awardKey(inst)]);
      if (earned && earned.delta !== 0) {
        pointsBack = earned.delta;
        await addPoints(db, { familyId: inst.family_id, userId: user.id, delta: -earned.delta, kind: 'adjustment', refId: inst.id, note: `Desmarcada: «${inst.title}»`, createdBy: user.id, idempotencyKey: `unmark:${inst.id}:${n}`, reversesEarning: true });
      }
      await voidBonus(db, { instanceId: inst.id, userId: user.id, familyId: inst.family_id, actorId: user.id, onTime: null, seq: n, releaseClaim: true, reason: 'tarea desmarcada' });
      if (inst.is_extra) await reverseRecovery(db, { ...inst, unmark_count: inst.unmark_count }, user.id, today, user.id);
    }

    if (inst.returned_at) {
      // Devuelta por un adulto: vuelve a «devuelta» con su motivo y su primera hora de envío.
      await db.query(
        `UPDATE task_instances SET status = 'rejected', review_outcome = 'returned', review_note = returned_note, reviewed_at = returned_at,
                completed_by = NULL, completed_at = NULL, child_note = NULL, photo_path = NULL, deadline_at = NULL, on_time = NULL, unmark_count = $2 WHERE id = $1`,
        [inst.id, n],
      );
    } else {
      await db.query(
        `UPDATE task_instances SET status = 'pending', review_outcome = NULL, review_note = NULL, reviewed_by = NULL, reviewed_at = NULL, first_submitted_at = NULL,
                points = $3, completed_by = NULL, completed_at = NULL, child_note = NULL, photo_path = NULL, deadline_at = NULL, on_time = NULL, unmark_count = $2 WHERE id = $1`,
        [inst.id, n, inst.task_points],
      );
    }
    // Una repetición ya abierta detrás de esta sobra: la que queda abierta es esta.
    if (inst.repeatable) {
      await db.query(
        `DELETE FROM task_instances WHERE task_id = $1 AND due_date = $2 AND assignee_id IS NOT DISTINCT FROM $3::uuid AND NOT is_extra AND status = 'pending'
            AND repeat_no > (SELECT repeat_no FROM task_instances WHERE id = $4)`,
        [inst.task_id, inst.due_date, inst.assignee_id, inst.id],
      );
    }
    // Insignias que dio esta tarea y que ya no se cumplen: se retiran (D55).
    const badgesRevoked = await revokeBadgesFrom(db, user.id, inst.id, today, fam.timezone, (await one(db, 'SELECT weekly_goal_points FROM users WHERE id=$1', [user.id]))!.weekly_goal_points);
    // Sin aviso a los adultos: solo queda en el historial.
    await audit(db, user.familyId, user.id, 'task.unmark', 'task_instance', inst.id, { title: inst.title, wasStatus: inst.status, pointsBack, badgesRevoked });
    return { id: inst.id, status: inst.returned_at ? 'rejected' : 'pending', pointsBack, badgesRevoked, photo: inst.photo_path };
  });
  removePhotoFile(out.photo);
  return { id: out.id, status: out.status, pointsBack: out.pointsBack, badgesRevoked: out.badgesRevoked };
}
