import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { addScreen, CATEGORY_PHRASE, endLapsedPauses, runScreenPlans, SCREEN_CATEGORIES, screenBalance, screenBuckets } from '../lib/screen.js';
import { notify } from '../lib/notify/dispatch.js';
import { familyToday, getFamily } from '../lib/family.js';
import { applyAdjustment, assertNotPaused, endPause, listReasons, pauseInfo } from '../lib/screen-adjust.js';

const uuid = z.string().uuid();

async function assertChild(userId: string, familyId: string) {
  const m = await one(getPool(), `SELECT id FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active`, [userId, familyId]);
  if (!m) throw notFound('Miembro no encontrado');
}

export default async function screenRoutes(app: FastifyInstance) {
  // Saldo, desglose (plan de la semana y ganados), pausa e historial de minutos de pantalla. Un hijo solo ve los suyos:
  // los ajustes de pantalla de un hermano nunca salen aquí.
  app.get('/api/screen/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    if (u.role === 'child' && u.id !== userId) throw forbidden();
    await assertChild(userId, u.familyId);
    const today = familyToday(await getFamily(getPool(), u.familyId));
    const entries = await many(
      getPool(),
      // Las anotaciones del hijo (y sus devoluciones) llevan el estado y el exceso del registro al que pertenecen.
      // Todo movimiento «penalty» (tarea no cumplida, rechazo, ajuste del adulto) se muestra como «Ajuste de pantalla».
      `SELECT l.id, l.delta, l.kind, l.category, l.note, l.created_at, c.display_name AS created_by_name,
              g.status AS log_status, g.minutes AS log_minutes, g.overflow_minutes AS log_overflow,
              (l.kind = 'penalty') AS is_adjustment,
              CASE WHEN l.kind = 'penalty' THEN COALESCE(a.reason_title, l.note) END AS reason,
              a.note AS adjustment_note, rt.title AS recovery_title, a.status AS adjustment_status
         FROM screen_ledger l LEFT JOIN users c ON c.id = l.created_by
         LEFT JOIN screen_usage_logs g ON g.id = l.ref_id AND l.kind IN ('usage','refund')
         LEFT JOIN screen_adjustments a ON a.id = l.ref_id AND l.kind = 'penalty'
         LEFT JOIN tasks rt ON rt.id = a.recovery_task_id
        WHERE l.user_id = $1 ORDER BY l.created_at DESC, l.id LIMIT 100`,
      [userId],
    );
    await endLapsedPauses(getPool(), userId, today);
    const pauses = await many(
      getPool(),
      `SELECT a.id, a.reason_title, a.note, a.pause_days, a.pause_starts_on, a.pause_ends_on, a.status, a.created_at, rt.title AS recovery_title
         FROM screen_adjustments a LEFT JOIN tasks rt ON rt.id = a.recovery_task_id
        WHERE a.user_id = $1 AND a.effect = 'pause' ORDER BY a.created_at DESC LIMIT 20`,
      [userId],
    );
    const plan = await one(getPool(), 'SELECT minutes_per_week, enabled FROM screen_plans WHERE user_id = $1', [userId]);
    return {
      balance: await screenBalance(getPool(), userId),
      buckets: await screenBuckets(getPool(), userId),
      pause: await pauseInfo(getPool(), userId, today),
      plan: plan ?? { minutes_per_week: 0, enabled: false },
      entries,
      pauses,
    };
  });

  // ---------- Plan semanal (adultos) ----------
  app.get('/api/screen/plans', async (req) => {
    const u = requireAdult(req);
    const plans = await many(
      getPool(),
      `SELECT c.id AS user_id, c.display_name, c.avatar, c.color, COALESCE(p.minutes_per_week, 0) AS minutes_per_week, COALESCE(p.enabled, false) AS enabled
         FROM users c LEFT JOIN screen_plans p ON p.user_id = c.id
        WHERE c.family_id = $1 AND c.role = 'child' AND c.active ORDER BY c.display_name`,
      [u.familyId],
    );
    return { plans };
  });

  app.put('/api/screen/plans/:userId', async (req) => {
    const u = requireAdult(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const b = z.object({ minutesPerWeek: z.number().int().min(0).max(10080), enabled: z.boolean() }).parse(req.body);
    await assertChild(userId, u.familyId);
    await tx(async (db) => {
      await db.query(
        `INSERT INTO screen_plans(user_id, family_id, minutes_per_week, enabled, updated_by, updated_at) VALUES ($1,$2,$3,$4,$5,now())
         ON CONFLICT (user_id) DO UPDATE SET minutes_per_week = EXCLUDED.minutes_per_week, enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [userId, u.familyId, b.minutesPerWeek, b.enabled, u.id],
      );
      await audit(db, u.familyId, u.id, 'screen_plan.update', 'user', userId, { minutes: b.minutesPerWeek, enabled: b.enabled });
    });
    // Al activar el plan a mitad de semana, esa semana se carga ya (idempotente: no se repite si ya estaba).
    await runScreenPlans(getPool(), u.familyId, new Date(), userId);
    return { ok: true };
  });

  // ---------- Ajustes de pantalla (adultos) ----------
  const reasonBody = z
    .object({
      title: z.string().trim().min(1).max(80),
      effect: z.enum(['minutes', 'pause']),
      minutes: z.number().int().min(1).max(1440).nullable().default(null),
      pauseDays: z.number().int().min(1).max(30).nullable().default(null),
    })
    .refine((r) => (r.effect === 'minutes' ? r.minutes !== null : r.pauseDays !== null), { message: 'indica la cantidad', path: ['effect'] });

  app.get('/api/screen/reasons', async (req) => {
    const u = requireAdult(req);
    return { reasons: await listReasons(getPool(), u.familyId) };
  });

  app.post('/api/screen/reasons', async (req) => {
    const u = requireAdult(req);
    const b = reasonBody.parse(req.body);
    await listReasons(getPool(), u.familyId); // siembra antes de crear, para no mezclar
    const r = await one(
      getPool(),
      `INSERT INTO screen_adjust_reasons(family_id, title, effect, minutes, pause_days, position)
       VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(max(position),0)+1 FROM screen_adjust_reasons WHERE family_id = $1)) RETURNING *`,
      [u.familyId, b.title, b.effect, b.effect === 'minutes' ? b.minutes : null, b.effect === 'pause' ? b.pauseDays : null],
    );
    await audit(getPool(), u.familyId, u.id, 'screen_reason.create', 'screen_reason', r.id, { title: b.title });
    return { reason: r };
  });

  app.put('/api/screen/reasons/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = reasonBody.parse(req.body);
    const r = await one(
      getPool(),
      `UPDATE screen_adjust_reasons SET title = $3, effect = $4, minutes = $5, pause_days = $6 WHERE id = $1 AND family_id = $2 RETURNING *`,
      [id, u.familyId, b.title, b.effect, b.effect === 'minutes' ? b.minutes : null, b.effect === 'pause' ? b.pauseDays : null],
    );
    if (!r) throw notFound('Motivo no encontrado');
    await audit(getPool(), u.familyId, u.id, 'screen_reason.update', 'screen_reason', id, { title: b.title });
    return { reason: r };
  });

  app.delete('/api/screen/reasons/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await getPool().query('UPDATE screen_adjust_reasons SET archived = true WHERE id = $1 AND family_id = $2 AND NOT archived', [id, u.familyId]);
    if (!r.rowCount) throw notFound('Motivo no encontrado');
    await audit(getPool(), u.familyId, u.id, 'screen_reason.archive', 'screen_reason', id, {});
    return { ok: true };
  });

  app.post('/api/screen/adjustments', async (req) => {
    const u = requireAdult(req);
    const b = z
      .object({
        userId: uuid, reasonId: uuid, effect: z.enum(['minutes', 'pause']),
        minutes: z.number().int().min(1).max(1440).optional(), pauseDays: z.number().int().min(1).max(30).optional(),
        note: z.string().trim().max(300).optional(), recoveryTaskId: uuid.nullable().optional(),
      })
      .parse(req.body);
    return applyAdjustment(u, b);
  });

  app.post('/api/screen/adjustments/:id/end', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return endPause(u, id);
  });

  // Gastar minutos (adulto). Se recorta al saldo; si no queda nada, error.
  app.post('/api/screen/spend', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ userId: uuid, minutes: z.number().int().min(1).max(1440), category: z.enum(SCREEN_CATEGORIES).default('otro'), note: z.string().trim().max(200).default('') }).parse(req.body);
    await assertChild(b.userId, u.familyId);
    return tx(async (db) => {
      await assertNotPaused(db, b.userId, familyToday(await getFamily(db, u.familyId)));
      const r = await addScreen(db, { familyId: u.familyId, userId: b.userId, delta: -b.minutes, kind: 'spend', note: b.note || 'Tiempo de pantalla', createdBy: u.id, category: b.category });
      if (r.applied === 0) throw conflict('No quedan minutos de pantalla', 'insufficient_balance');
      await audit(db, u.familyId, u.id, 'screen.spend', 'user', b.userId, { minutes: -r.applied, requested: b.minutes, category: b.category });
      await notify(db, { userId: b.userId, event: 'screen_changed', title: `${u.displayName} te ha dado ${-r.applied} min ${CATEGORY_PHRASE[b.category]}.`, body: `Te quedan ${r.balance} min.${b.note ? ` ${b.note}` : ''}`, link: '/mesada' });
      return { applied: -r.applied, requested: b.minutes, balance: r.balance };
    });
  });

  // Ajuste manual (adulto): positivo regala minutos, negativo los resta (recortado a 0).
  app.post('/api/screen/adjust', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ userId: uuid, delta: z.number().int().refine((n) => n !== 0).refine((n) => Math.abs(n) <= 1440), note: z.string().trim().min(1).max(200) }).parse(req.body);
    await assertChild(b.userId, u.familyId);
    return tx(async (db) => {
      const r = await addScreen(db, { familyId: u.familyId, userId: b.userId, delta: b.delta, kind: 'adjustment', note: b.note, createdBy: u.id });
      if (b.delta < 0 && r.applied === 0) throw conflict('No quedan minutos de pantalla', 'insufficient_balance');
      await audit(db, u.familyId, u.id, 'screen.adjust', 'user', b.userId, { delta: r.applied, requested: b.delta, note: b.note });
      await notify(db, { userId: b.userId, event: 'screen_changed', title: r.applied > 0 ? `+${r.applied} min de pantalla` : `${r.applied} min de pantalla`, body: b.note, link: '/mesada' });
      return { applied: r.applied, requested: b.delta, balance: r.balance };
    });
  });
}
