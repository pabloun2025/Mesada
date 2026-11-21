import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool, one } from '../lib/db.js';
import { requireAdult, requireUser, type AuthUser } from '../lib/auth.js';
import { forbidden, notFound } from '../lib/errors.js';
import { bankOverview, cancelLoan, familyBankSummary, decideLoan, exchangePoints, listLoans, requestLoan, statement, takeAdvance } from '../lib/bank.js';
import {
  cancelGoalRequest, decideGoalRequest, goalDeposit, goalWithdrawEarly, listGoalRequests, requestGoalAction,
} from '../lib/savings.js';

const uuid = z.string().uuid();

async function assertCanView(u: AuthUser, userId: string) {
  if (u.role === 'child' && u.id !== userId) throw forbidden();
  const m = await one(getPool(), `SELECT id FROM users WHERE id = $1 AND family_id = $2 AND role = 'child'`, [userId, u.familyId]);
  if (!m) throw notFound('Miembro no encontrado');
}

function idemKey(req: FastifyRequest): string | undefined {
  const k = req.headers['idempotency-key'];
  return typeof k === 'string' && k.length >= 8 && k.length <= 100 ? k : undefined;
}

export default async function bankRoutes(app: FastifyInstance) {
  // ---------- Cuentas ----------
  app.get('/api/bank/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    await assertCanView(u, userId);
    return { bank: await bankOverview(getPool(), u.familyId, userId) };
  });

  app.get('/api/statement/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const q = z.object({
      account: z.enum(['money', 'points', 'all']).default('money'),
      limit: z.coerce.number().int().min(1).max(200).optional(),
      offset: z.coerce.number().int().min(0).max(100000).optional(),
    }).parse(req.query);
    await assertCanView(u, userId);
    return statement(getPool(), userId, q.account, q);
  });

  // Resumen de los padres: lo que deben, préstamos vivos e interés de la semana.
  app.get('/api/bank-summary', async (req) => {
    const u = requireAdult(req);
    return { summary: await familyBankSummary(getPool(), u.familyId) };
  });

  // ---------- Canje y adelanto (solo el hijo, sin aprobación) ----------
  app.post('/api/bank/exchange', async (req) => {
    const u = requireUser(req);
    const b = z.object({ points: z.number().int().positive().max(1000000) }).parse(req.body);
    return exchangePoints(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/bank/advance', async (req) => {
    const u = requireUser(req);
    const b = z.object({ cents: z.number().int().positive().max(10000000) }).parse(req.body);
    return takeAdvance(u, { ...b, idempotencyKey: idemKey(req) });
  });

  // ---------- Préstamos ----------
  app.get('/api/loans', async (req) => {
    const u = requireUser(req);
    const q = z.object({ userId: uuid.optional(), status: z.enum(['pending', 'active', 'paid', 'rejected', 'cancelled']).optional() }).parse(req.query);
    const userId = u.role === 'child' ? u.id : q.userId;
    return { loans: await listLoans(getPool(), u.familyId, { userId, status: q.status ? [q.status] : undefined }) };
  });

  app.post('/api/loans', async (req) => {
    const u = requireUser(req);
    const b = z.object({ amountCents: z.number().int().positive().max(10000000), weeks: z.number().int().min(1).max(52), note: z.string().trim().max(200).optional() }).parse(req.body);
    return requestLoan(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/loans/:id/cancel', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return cancelLoan(u, id);
  });

  app.post('/api/loans/:id/:decision', async (req) => {
    const u = requireAdult(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(['approve', 'reject']) }).parse(req.params);
    const b = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return decideLoan(u, id, { approve: decision === 'approve', note: b.note });
  });

  // ---------- Metas de ahorro programado ----------
  app.post('/api/goals/:id/deposit', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ cents: z.number().int().positive().max(10000000) }).parse(req.body);
    return goalDeposit(u, id, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/goals/:id/withdraw', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return goalWithdrawEarly(u, id);
  });

  app.post('/api/goals/:id/redeem', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return requestGoalAction(u, id, 'redeem');
  });

  app.post('/api/goals/:id/cashout', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return requestGoalAction(u, id, 'cashout');
  });

  app.get('/api/goal-requests', async (req) => {
    const u = requireUser(req);
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }).parse(req.query);
    return { requests: await listGoalRequests(getPool(), u.familyId, { userId: u.role === 'child' ? u.id : undefined, status }) };
  });

  app.post('/api/goal-requests/:id/cancel', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return cancelGoalRequest(u, id);
  });

  app.post('/api/goal-requests/:id/:decision', async (req) => {
    const u = requireAdult(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(['approve', 'reject']) }).parse(req.params);
    const b = z.object({ priceCents: z.number().int().positive().max(100000000).optional(), note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return decideGoalRequest(u, id, { approve: decision === 'approve', ...b });
  });
}
