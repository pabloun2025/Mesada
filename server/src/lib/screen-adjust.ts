import { many, one, tx, type Db } from './db.js';
import type { AuthUser } from './auth.js';
import { badRequest, conflict, notFound } from './errors.js';
import { addDays, diffDays } from './dates.js';
import { familyToday, getFamily } from './family.js';
import { lockUser } from './ledger.js';
import { activePause, addScreen, endLapsedPauses, expireLots, phraseUntil, shiftLots } from './screen.js';
import { audit } from './audit.js';
import { notify } from './notify/dispatch.js';

/** Motivos de partida, escritos en positivo (lo que se busca). El adulto puede crear, editar y archivar los suyos. */
const SEED_REASONS = [
  { title: 'Llegar a tiempo al cole', effect: 'minutes', minutes: 15, pause_days: null },
  { title: 'Habitación en orden', effect: 'minutes', minutes: 15, pause_days: null },
  { title: 'Esfuerzo en los estudios', effect: 'minutes', minutes: 30, pause_days: null },
  { title: 'Respeto en familia', effect: 'pause', minutes: null, pause_days: 1 },
] as const;

/** Siembra el catálogo la primera vez que se pide (una sola vez: si lo vacían, no reaparece). */
export async function ensureReasonSeeds(db: Db, familyId: string) {
  const has = await one(db, 'SELECT 1 FROM screen_adjust_reasons WHERE family_id = $1 LIMIT 1', [familyId]);
  if (has) return;
  for (const [i, r] of SEED_REASONS.entries()) {
    await db.query(
      'INSERT INTO screen_adjust_reasons(family_id, title, effect, minutes, pause_days, position) VALUES ($1,$2,$3,$4,$5,$6)',
      [familyId, r.title, r.effect, r.minutes, r.pause_days, i],
    );
  }
}

export interface ApplyAdjustment {
  userId: string;
  reasonId: string;
  effect: 'minutes' | 'pause';
  minutes?: number;
  pauseDays?: number;
  note?: string;
  recoveryTaskId?: string | null;
}

/** El adulto aplica un ajuste a un hijo: quita minutos (primero los que caducan antes) o pone una pausa. */
export async function applyAdjustment(adult: AuthUser, p: ApplyAdjustment, opts: { now?: Date } = {}) {
  return tx(async (db) => {
    const fam = await getFamily(db, adult.familyId);
    const today = familyToday(fam, opts.now);
    const child = await one(db, `SELECT id, display_name FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active`, [p.userId, adult.familyId]);
    if (!child) throw notFound('Miembro no encontrado');
    const reason = await one<{ id: string; title: string }>(db, 'SELECT id, title FROM screen_adjust_reasons WHERE id = $1 AND family_id = $2', [p.reasonId, adult.familyId]);
    if (!reason) throw notFound('Motivo no encontrado');
    const note = p.note?.trim() ?? '';
    await lockUser(db, p.userId);

    // «Forma de recuperar»: un trabajo extra que el hijo reserva ya para hacerlo.
    let recoveryTask: { id: string; title: string } | null = null;
    if (p.recoveryTaskId) {
      recoveryTask = (await one(db, 'SELECT id, title FROM tasks WHERE id = $1 AND family_id = $2 AND is_extra AND active', [p.recoveryTaskId, adult.familyId])) ?? null;
      if (!recoveryTask) throw notFound('Trabajo extra no encontrado');
      const open = await one<{ id: string; assignee_id: string | null; display_name: string | null }>(
        db,
        `SELECT i.id, i.assignee_id, u.display_name FROM task_instances i LEFT JOIN users u ON u.id = i.assignee_id
          WHERE i.task_id = $1 AND i.is_extra AND i.status IN ('pending','submitted','rejected') FOR UPDATE OF i`,
        [recoveryTask.id],
      );
      if (open && open.assignee_id && open.assignee_id !== p.userId) throw conflict(`Ese trabajo lo tiene ${open.display_name}`, 'taken');
      if (open) {
        await db.query(`UPDATE task_instances SET assignee_id = $2, reserved_at = COALESCE(reserved_at, now()) WHERE id = $1`, [open.id, p.userId]);
      } else {
        const t = await one(db, 'SELECT points FROM tasks WHERE id = $1', [recoveryTask.id]);
        await db.query(
          `INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points, is_extra, reserved_at) VALUES ($1,$2,$3,$4,$5,true,now())`,
          [recoveryTask.id, adult.familyId, p.userId, today, t!.points],
        );
      }
    }

    if (p.effect === 'minutes') {
      const minutes = p.minutes ?? 0;
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw badRequest('Indica entre 1 y 1440 minutos');
      const adj = await one(
        db,
        `INSERT INTO screen_adjustments(family_id, user_id, reason_id, reason_title, effect, minutes, note, recovery_task_id, created_by)
         VALUES ($1,$2,$3,$4,'minutes',$5,$6,$7,$8) RETURNING id`,
        [adult.familyId, p.userId, reason.id, reason.title, minutes, note, recoveryTask?.id ?? null, adult.id],
      );
      const r = await addScreen(db, { familyId: adult.familyId, userId: p.userId, delta: -minutes, kind: 'penalty', refId: adj!.id, note: reason.title, createdBy: adult.id, idempotencyKey: `adjust:${adj!.id}`, now: opts.now });
      // Sin minutos que ajustar no se anota nada: para eso está la pausa.
      if (r.applied === 0) throw conflict('No tiene minutos que ajustar. Puede usar una pausa.', 'insufficient_balance');
      await db.query('UPDATE screen_adjustments SET applied_minutes = $2 WHERE id = $1', [adj!.id, -r.applied]);
      await audit(db, adult.familyId, adult.id, 'screen_adjust.minutes', 'screen_adjustment', adj!.id, { userId: p.userId, for: p.userId, reason: reason.title, minutes: -r.applied, requested: minutes });
      await notify(db, {
        userId: p.userId, event: 'screen_changed', title: `Ajuste de pantalla: ${reason.title}`,
        body: `−${-r.applied} min.${note ? ` ${note}` : ''}${recoveryTask ? ` Puedes recuperarlos con «${recoveryTask.title}».` : ''}`, link: '/mesada',
      });
      return { id: adj!.id as string, effect: 'minutes' as const, applied: -r.applied, requested: minutes, balance: r.balance };
    }

    // Pausa: durante N días no gasta ni pide minutos, y lo que tiene no caduca.
    const days = p.pauseDays ?? 0;
    if (!Number.isInteger(days) || days < 1 || days > 30) throw badRequest('La pausa puede durar de 1 a 30 días');
    await endLapsedPauses(db, p.userId, today);
    if (await activePause(db, p.userId, today)) throw conflict('Ya tiene una pausa en marcha. Termínala antes de poner otra.', 'already_paused');
    const endsOn = addDays(today, days);
    const adj = await one(
      db,
      `INSERT INTO screen_adjustments(family_id, user_id, reason_id, reason_title, effect, pause_days, pause_starts_on, pause_ends_on, note, recovery_task_id, created_by)
       VALUES ($1,$2,$3,$4,'pause',$5,$6,$7,$8,$9,$10) RETURNING id`,
      [adult.familyId, p.userId, reason.id, reason.title, days, today, endsOn, note, recoveryTask?.id ?? null, adult.id],
    );
    await expireLots(db, adult.familyId, p.userId, opts.now); // lo que ya venció se pierde; lo demás se alarga
    await shiftLots(db, adult.familyId, p.userId, days, adj!.id, 'extend');
    await audit(db, adult.familyId, adult.id, 'screen_adjust.pause', 'screen_adjustment', adj!.id, { userId: p.userId, for: p.userId, reason: reason.title, days, until: endsOn });
    await notify(db, {
      userId: p.userId, event: 'screen_changed', title: `Pausa de pantalla hasta ${phraseUntil(endsOn, today)}`,
      body: `${reason.title}.${note ? ` ${note}` : ''} Tus minutos no caducan durante la pausa.${recoveryTask ? ` Puedes acortarla con «${recoveryTask.title}».` : ''}`, link: '/mesada',
    });
    return { id: adj!.id as string, effect: 'pause' as const, until: endsOn, days };
  });
}

/** Termina una pausa antes de tiempo (la decide un adulto, o la recuperación). Devuelve a los lotes los días que no se usaron. */
export async function endPauseTx(db: Db, familyId: string, adj: { id: string; user_id: string; pause_ends_on: string }, today: string, status: 'ended' | 'recovered', actorId: string | null) {
  await db.query(
    `UPDATE screen_adjustments SET status = $2, ended_at = now(), ended_by = $3, recovered_minutes = 0 WHERE id = $1`,
    [adj.id, status, actorId],
  );
  // Hoy ya cuenta como pausado: solo se devuelven los días completos que quedaban.
  const unused = Math.max(0, diffDays(adj.pause_ends_on, today));
  await shiftLots(db, familyId, adj.user_id, unused, adj.id, 'shrink');
}

export async function endPause(adult: AuthUser, id: string, opts: { now?: Date } = {}) {
  return tx(async (db) => {
    const fam = await getFamily(db, adult.familyId);
    const today = familyToday(fam, opts.now);
    const adj = await one(db, `SELECT * FROM screen_adjustments WHERE id = $1 AND family_id = $2 AND effect = 'pause' FOR UPDATE`, [id, adult.familyId]);
    if (!adj) throw notFound('Pausa no encontrada');
    await lockUser(db, adj.user_id);
    if (adj.status !== 'active' || adj.pause_ends_on <= today) return { id, ended: false };
    await endPauseTx(db, adult.familyId, adj, today, 'ended', adult.id);
    await audit(db, adult.familyId, adult.id, 'screen_adjust.end_pause', 'screen_adjustment', id, { userId: adj.user_id, for: adj.user_id });
    await notify(db, { userId: adj.user_id, event: 'screen_changed', title: 'Se ha terminado tu pausa de pantalla', body: 'Ya puedes pedir y gastar tus minutos.', link: '/mesada' });
    return { id, ended: true };
  });
}

/**
 * «Forma de recuperar»: al aprobarse el trabajo extra que eligió el adulto, vuelven los minutos (como minutos ganados
 * con caducidad nueva) o termina la pausa. Debe llamarse dentro de la transacción de la aprobación.
 */
export async function applyRecovery(db: Db, inst: { id: string; task_id: string; family_id: string; unmark_count: number }, userId: string, today: string, actorId: string | null) {
  const adj = await one(
    db, `SELECT * FROM screen_adjustments WHERE user_id = $1 AND recovery_task_id = $2 AND status = 'active' ORDER BY created_at LIMIT 1 FOR UPDATE`, [userId, inst.task_id],
  );
  if (!adj) return null;
  await lockUser(db, userId);
  if (adj.effect === 'minutes') {
    let back = 0;
    if (adj.applied_minutes > 0) {
      const r = await addScreen(db, { familyId: inst.family_id, userId, delta: adj.applied_minutes, kind: 'refund', refId: adj.id, note: `Recuperado: ${adj.reason_title}`, createdBy: actorId, idempotencyKey: `recover:${adj.id}:${inst.unmark_count}` });
      back = r.applied;
    }
    await db.query(`UPDATE screen_adjustments SET status = 'recovered', recovered_minutes = $2, recovery_instance_id = $3, ended_at = now() WHERE id = $1`, [adj.id, back, inst.id]);
    await notify(db, { userId, event: 'screen_changed', title: `Has recuperado ${back} min de pantalla`, body: adj.reason_title, link: '/mesada', dedupeKey: `recover:${adj.id}:${inst.unmark_count}` });
  } else if (adj.pause_ends_on > today) {
    await endPauseTx(db, inst.family_id, adj, today, 'recovered', actorId);
    await db.query('UPDATE screen_adjustments SET recovery_instance_id = $2 WHERE id = $1', [adj.id, inst.id]);
    await notify(db, { userId, event: 'screen_changed', title: 'Se ha terminado tu pausa de pantalla', body: `Lo has recuperado: ${adj.reason_title}.`, link: '/mesada', dedupeKey: `recover:${adj.id}:${inst.unmark_count}` });
  } else {
    await db.query(`UPDATE screen_adjustments SET status = 'ended', ended_at = now() WHERE id = $1`, [adj.id]);
    return null;
  }
  await audit(db, inst.family_id, actorId, 'screen_adjust.recovered', 'screen_adjustment', adj.id, { userId, for: userId, instanceId: inst.id });
  return adj.id as string;
}

/** Deshace una recuperación (el hijo desmarcó el trabajo extra): vuelve el ajuste tal como estaba. */
export async function reverseRecovery(db: Db, inst: { id: string; family_id: string; unmark_count: number }, userId: string, today: string, actorId: string | null) {
  const adj = await one(db, `SELECT * FROM screen_adjustments WHERE recovery_instance_id = $1 AND status = 'recovered' FOR UPDATE`, [inst.id]);
  if (!adj) return;
  await lockUser(db, userId);
  if (adj.effect === 'minutes') {
    if (adj.recovered_minutes > 0) {
      await addScreen(db, { familyId: inst.family_id, userId, delta: -adj.recovered_minutes, kind: 'adjustment', refId: adj.id, note: `Recuperación deshecha: ${adj.reason_title}`, createdBy: actorId, idempotencyKey: `recover-rev:${adj.id}:${inst.unmark_count}` });
    }
    await db.query(`UPDATE screen_adjustments SET status = 'active', recovered_minutes = 0, recovery_instance_id = NULL, ended_at = NULL WHERE id = $1`, [adj.id]);
    return;
  }
  const another = await activePause(db, userId, today);
  if (adj.pause_ends_on > today && !another) {
    // La pausa vuelve con los días que le quedan, y los lotes se vuelven a alargar.
    await db.query(`UPDATE screen_adjustments SET status = 'active', ended_at = NULL, ended_by = NULL, recovery_instance_id = NULL WHERE id = $1`, [adj.id]);
    await shiftLots(db, inst.family_id, userId, Math.max(0, diffDays(adj.pause_ends_on, today)), adj.id, 'extend');
  } else {
    await db.query(`UPDATE screen_adjustments SET status = 'ended', recovery_instance_id = NULL WHERE id = $1`, [adj.id]);
  }
}

/** Texto «Pausa hasta el jueves» para quien la ve (hijo o adulto); null si no hay pausa. */
export async function pauseInfo(db: Db, userId: string, today: string) {
  const p = await activePause(db, userId, today);
  if (!p) return null;
  return { id: p.id, starts_on: p.pause_starts_on, ends_on: p.pause_ends_on, reason: p.reason_title, label: `Pausa hasta ${phraseUntil(p.pause_ends_on, today)}` };
}

/** Falla si el hijo está en pausa: no puede gastar ni pedir minutos. */
export async function assertNotPaused(db: Db, userId: string, today: string) {
  const p = await pauseInfo(db, userId, today);
  if (p) throw conflict(`${p.label}: ahora no se pueden gastar ni pedir minutos`, 'paused');
}

export async function listReasons(db: Db, familyId: string, includeArchived = false) {
  await ensureReasonSeeds(db, familyId);
  return many(db, `SELECT * FROM screen_adjust_reasons WHERE family_id = $1 AND ($2 OR NOT archived) ORDER BY archived, position, created_at`, [familyId, includeArchived]);
}
