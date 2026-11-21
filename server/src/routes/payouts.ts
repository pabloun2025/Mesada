import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { forbidden } from '../lib/errors.js';
import { SCREEN_CATEGORIES } from '../lib/screen.js';
import { approvePayoutRequest, cancelPayoutRequest, createPayoutRequest, listPayoutRequests, rejectPayoutRequest } from '../lib/payouts.js';
import { confirmUsage, listUsageLogs, logScreenUsage, voidUsage } from '../lib/screen-usage.js';

const uuid = z.string().uuid();
const category = z.enum(SCREEN_CATEGORIES);

function idemKey(req: FastifyRequest): string | undefined {
  const k = req.headers['idempotency-key'];
  return typeof k === 'string' && k.length >= 8 && k.length <= 100 ? k : undefined;
}

export default async function payoutRoutes(app: FastifyInstance) {
  // ---------- Peticiones del hijo ----------
  app.get('/api/payout-requests', async (req) => {
    const u = requireUser(req);
    const { status } = z.object({ status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional() }).parse(req.query);
    return { requests: await listPayoutRequests(getPool(), u.familyId, { userId: u.role === 'child' ? u.id : undefined, status }) };
  });

  app.post('/api/payout-requests', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo los hijos hacen peticiones');
    const b = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('money'), amountCents: z.number().int().positive().max(10000000), note: z.string().trim().max(200).optional() }),
      z.object({ kind: z.literal('screen'), minutes: z.number().int().min(1).max(1440), category, note: z.string().trim().max(200).optional() }),
    ]).parse(req.body);
    return createPayoutRequest(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/payout-requests/:id/cancel', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return cancelPayoutRequest(u, id);
  });

  app.post('/api/payout-requests/:id/approve', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ method: z.enum(['cash', 'transfer', 'bizum', 'other']).optional(), note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return approvePayoutRequest(u, id, b);
  });

  app.post('/api/payout-requests/:id/reject', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return rejectPayoutRequest(u, id, b.note);
  });

  // ---------- Pantalla anotada por el hijo ----------
  app.get('/api/screen-logs', async (req) => {
    const u = requireUser(req);
    const { status } = z.object({ status: z.enum(['pending', 'confirmed', 'voided']).optional() }).parse(req.query);
    return { logs: await listUsageLogs(getPool(), u.familyId, { userId: u.role === 'child' ? u.id : undefined, status }) };
  });

  app.post('/api/screen-logs', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo los hijos anotan su pantalla');
    const b = z.object({ minutes: z.number().int().min(1).max(720), category, note: z.string().trim().max(200).optional() }).parse(req.body);
    return logScreenUsage(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/screen-logs/:id/confirm', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return confirmUsage(u, id);
  });

  app.post('/api/screen-logs/:id/void', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return voidUsage(u, id);
  });
}
