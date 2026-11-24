import { one, tx } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, notFound } from './errors.js';
import { familyToday, getFamily } from './family.js';
import { addPoints, lockUser } from './ledger.js';
import { addScreen } from './screen.js';
import { audit } from './audit.js';
import { notify } from './notify/dispatch.js';
import { evaluateBadges } from './gamification.js';
import { grantBonus, voidBonus } from './bonus.js';

const keyFor = (base: string, seq: number) => (seq <= 1 ? base : `${base}:${seq}`);

/**
 * Tarea de comprobación: la marca un adulto («Cumplida» / «No cumplida»), el hijo no la reporta.
 * Estados: cumplida → approved; no cumplida → expired con nota. `check_met` guarda la decisión (NULL = sin decidir).
 * Es idempotente y corregible: cada cambio compensa lo anterior con movimientos nuevos (los libros no se editan).
 */
export async function checkInstance(adult: AuthUser, instanceId: string, met: boolean, opts: { now?: Date } = {}) {
  return tx(async (db) => {
    const fam = await getFamily(db, adult.familyId);
    const today = familyToday(fam, opts.now);
    const inst = await one<any>(
      db,
      `SELECT i.*, t.title, t.check_mode, t.penalty_minutes, t.success_minutes
         FROM task_instances i JOIN tasks t ON t.id = i.task_id
        WHERE i.id = $1 AND i.family_id = $2 FOR UPDATE OF i`,
      [instanceId, adult.familyId],
    );
    if (!inst) throw notFound('Tarea no encontrada');
    if (!inst.check_mode) throw badRequest('Esta tarea la marca el propio hijo', 'not_check_task');
    const kid: string | null = inst.assignee_id;
    if (!kid) throw badRequest('Esta tarea no tiene a nadie asignado');
    if (inst.due_date > today) throw badRequest('Esta tarea todavía no toca', 'not_due');
    if (inst.check_met === met) {
      return { id: inst.id, status: inst.status, met, duplicate: true, penaltyApplied: inst.check_penalty_applied };
    }
    await lockUser(db, kid);
    const seq: number = inst.check_seq + 1;
    const ctx = { instanceId: inst.id, userId: kid, familyId: adult.familyId, actorId: adult.id, onTime: null as boolean | null, seq };

    // 1) Deshacer la decisión anterior, si la había.
    if (inst.check_met === true) {
      if (inst.points > 0) {
        await addPoints(db, { familyId: adult.familyId, userId: kid, delta: -inst.points, kind: 'adjustment', refId: inst.id, note: `Corrección: «${inst.title}» no cumplida`, createdBy: adult.id, idempotencyKey: `task-rev:${inst.id}:${seq}`, reversesEarning: true });
      }
      if (inst.check_minutes_applied > 0) {
        await addScreen(db, { familyId: adult.familyId, userId: kid, delta: -inst.check_minutes_applied, kind: 'adjustment', refId: inst.id, note: `Corrección: «${inst.title}» no cumplida`, createdBy: adult.id, idempotencyKey: `task-min-rev:${inst.id}:${seq}` });
      }
      await voidBonus(db, ctx);
    } else if (inst.check_met === false && inst.check_penalty_applied > 0) {
      // Se devuelven exactamente los minutos que se restaron (si el saldo estaba en 0 no se restó nada).
      await addScreen(db, { familyId: adult.familyId, userId: kid, delta: inst.check_penalty_applied, kind: 'refund', refId: inst.id, note: `Devolución: «${inst.title}» sí cumplida`, createdBy: adult.id, idempotencyKey: `task-refund:${inst.id}:${seq}` });
    }

    // 2) Aplicar la nueva.
    let penaltyApplied = 0;
    let minutesApplied = 0;
    let grant: any = null;
    if (met) {
      if (inst.points > 0) {
        await addPoints(db, { familyId: adult.familyId, userId: kid, delta: inst.points, kind: 'task', refId: inst.id, note: inst.title, createdBy: adult.id, idempotencyKey: keyFor(`task:${inst.id}`, seq) });
      }
      if (inst.success_minutes > 0) {
        await addScreen(db, { familyId: adult.familyId, userId: kid, delta: inst.success_minutes, kind: 'task', refId: inst.id, note: inst.title, createdBy: adult.id, idempotencyKey: keyFor(`task-min:${inst.id}`, seq) });
        minutesApplied = inst.success_minutes;
      }
      grant = await grantBonus(db, ctx);
    } else if (inst.penalty_minutes > 0) {
      const r = await addScreen(db, { familyId: adult.familyId, userId: kid, delta: -inst.penalty_minutes, kind: 'penalty', refId: inst.id, note: inst.title, createdBy: adult.id, idempotencyKey: `task-pen:${inst.id}:${seq}` });
      penaltyApplied = -r.applied;
    }

    const status = met ? 'approved' : 'expired';
    await db.query(
      `UPDATE task_instances
          SET check_met = $2, check_seq = $3, check_penalty_applied = $4, check_minutes_applied = $5, status = $6,
              completed_by = $7, completed_at = CASE WHEN $2 THEN now() END,
              reviewed_by = $8, reviewed_at = now(), review_note = $9, on_time = NULL, deadline_at = NULL
        WHERE id = $1`,
      [inst.id, met, seq, penaltyApplied, minutesApplied, status, met ? kid : null, adult.id, met ? null : 'No cumplida'],
    );
    await audit(db, adult.familyId, adult.id, met ? 'task.check_met' : 'task.check_not_met', 'task_instance', inst.id, { was: inst.check_met, penaltyApplied, minutesApplied });

    if (met) {
      const parts = [inst.points > 0 ? `+${inst.points} puntos` : '', minutesApplied ? `+${minutesApplied} min de pantalla` : '', grant ? (grant.surprise ? '🎁 ¡y una sorpresa!' : grant.label) : ''].filter(Boolean);
      await notify(db, { userId: kid, event: 'task_approved', title: `¡«${inst.title}» cumplida! Bien hecho`, body: parts.join(' · '), link: '/', dedupeKey: `check:${inst.id}:${seq}` });
      await evaluateBadges(db, kid, today, fam.timezone, (await one(db, 'SELECT weekly_goal_points FROM users WHERE id=$1', [kid]))!.weekly_goal_points);
    } else {
      await notify(db, {
        userId: kid, event: 'screen_changed', emoji: '😕', title: `«${inst.title}» no cumplida`,
        body: penaltyApplied > 0 ? `−${penaltyApplied} min de pantalla. ¡La próxima la bordas! 💪` : 'Sin cambios en tu pantalla. ¡La próxima la bordas! 💪',
        link: '/', dedupeKey: `check:${inst.id}:${seq}`,
      });
    }
    return { id: inst.id, status, met, duplicate: false, penaltyApplied, minutesApplied };
  });
}
