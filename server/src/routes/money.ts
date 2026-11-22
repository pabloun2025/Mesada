import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool, many, one } from '../lib/db.js';
import { requireAdult, requireUser, type AuthUser } from '../lib/auth.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { cancelGoal, createGoal, listGoals, updateGoal } from '../lib/savings.js';
import { familyToday, getFamily } from '../lib/family.js';
import { previousPeriod, isValidDate } from '../lib/dates.js';
import {
  adjustMoney, adjustPoints, listSettlements, recordPayment, settlePeriod, transferSavings, walletSummary,
} from '../lib/money.js';
import { audit } from '../lib/audit.js';

const uuid = z.string().uuid();

/** Un hijo solo puede consultar sus propios datos; un adulto, los de su familia. */
async function assertCanView(u: AuthUser, userId: string) {
  if (u.role === 'child' && u.id !== userId) throw forbidden();
  const m = await one(getPool(), 'SELECT id FROM users WHERE id = $1 AND family_id = $2', [userId, u.familyId]);
  if (!m) throw notFound('Miembro no encontrado');
}

function idemKey(req: FastifyRequest): string | undefined {
  const k = req.headers['idempotency-key'];
  return typeof k === 'string' && k.length >= 8 && k.length <= 100 ? k : undefined;
}

export default async function moneyRoutes(app: FastifyInstance) {
  app.get('/api/wallet/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    await assertCanView(u, userId);
    return { wallet: await walletSummary(getPool(), u.familyId, userId) };
  });

  app.get('/api/ledger/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const { type } = z.object({ type: z.enum(['points', 'money']).default('points') }).parse(req.query);
    await assertCanView(u, userId);
    const rows =
      type === 'points'
        ? await many(getPool(), `SELECT l.id, l.delta, l.kind, l.note, l.created_at, c.display_name AS created_by_name FROM points_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 200`, [userId])
        : await many(getPool(), `SELECT l.id, l.delta_cents, l.account, l.kind, l.note, l.created_at, c.display_name AS created_by_name FROM money_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 200`, [userId]);
    return { entries: rows };
  });

  app.post('/api/allowance/settle', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ userId: uuid.optional(), date: z.string().refine(isValidDate).optional() }).parse(req.body);
    const fam = await getFamily(getPool(), u.familyId);
    const date = b.date ?? previousPeriod(fam.settlement_period, familyToday(fam)).start;
    const children = b.userId
      ? [{ id: b.userId }]
      : await many(getPool(), `SELECT id FROM users WHERE family_id = $1 AND role = 'child' AND active ORDER BY created_at`, [u.familyId]);
    const results: any[] = [];
    for (const c of children) {
      try {
        results.push({ userId: c.id, ok: true, settlement: await settlePeriod(u, c.id, date) });
      } catch (e: any) {
        if (b.userId) throw e;
        results.push({ userId: c.id, ok: false, error: e.message, code: e.code });
      }
    }
    return { results };
  });

  app.get('/api/settlements', async (req) => {
    const u = requireUser(req);
    return { settlements: await listSettlements(getPool(), u.familyId, u.role === 'child' ? u.id : undefined) };
  });

  app.post('/api/payments', async (req) => {
    const u = requireAdult(req);
    const b = z
      .object({ userId: uuid, amountCents: z.number().int().positive().max(10000000), method: z.enum(['cash', 'transfer', 'bizum', 'other']).default('cash'), note: z.string().max(300).optional() })
      .parse(req.body);
    return { payment: await recordPayment(u, { ...b, idempotencyKey: idemKey(req) }) };
  });

  app.get('/api/payments', async (req) => {
    const u = requireUser(req);
    const rows = await many(
      getPool(),
      `SELECT p.*, u.display_name, pb.display_name AS paid_by_name FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN users pb ON pb.id = p.paid_by
        WHERE p.family_id = $1 AND ($2::uuid IS NULL OR p.user_id = $2) ORDER BY p.paid_at DESC LIMIT 200`,
      [u.familyId, u.role === 'child' ? u.id : null],
    );
    return { payments: rows };
  });

  app.post('/api/adjustments/points', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ userId: uuid, delta: z.number().int(), note: z.string().trim().min(1).max(300), bonus: z.boolean().optional() }).parse(req.body);
    return adjustPoints(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/adjustments/money', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ userId: uuid, deltaCents: z.number().int(), note: z.string().trim().min(1).max(300) }).parse(req.body);
    return adjustMoney(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/savings/transfer', async (req) => {
    const u = requireUser(req);
    const b = z.object({ userId: uuid, cents: z.number().int().positive(), direction: z.enum(['to_savings', 'from_savings']) }).parse(req.body);
    return transferSavings(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.get('/api/goals/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    await assertCanView(u, userId);
    return { goals: await listGoals(getPool(), userId) };
  });

  // El hijo propone una meta (queda por aprobar); un adulto la crea ya activa (I19).
  app.post('/api/goals', async (req) => {
    const u = requireUser(req);
    const b = z.object({
      userId: uuid, title: z.string().trim().min(1).max(80), targetCents: z.number().int().positive().max(100000000),
      emoji: z.string().trim().max(16).nullable().optional(),
    }).parse(req.body);
    await assertCanView(u, b.userId);
    return { goal: await createGoal(u, b) };
  });

  // Un adulto cambia nombre, precio o emoji de una meta activa.
  app.patch('/api/goals/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      title: z.string().trim().min(1).max(80).optional(), targetCents: z.number().int().positive().max(100000000).optional(),
      emoji: z.string().trim().max(16).nullable().optional(),
    }).parse(req.body ?? {});
    return updateGoal(u, id, b);
  });

  // Cancelar una meta: si tenía dinero, lo ahorrado vuelve a la cuenta de dinero del banco.
  app.delete('/api/goals/:id', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ reason: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return { ok: true, ...(await cancelGoal(u, id, b.reason)) };
  });
}
