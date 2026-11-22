import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool, one } from '../lib/db.js';
import fs from 'node:fs';
import path from 'node:path';
import { requireAdult, requireGrownUp, requireUser, type AuthUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { config } from '../lib/config.js';
import { enforceLimit } from '../lib/limits.js';
import { looksLikeImage, processPhoto, removePhotoFile, storePhoto } from '../lib/photos.js';
import { bankOverview, cancelLoan, familyBankSummary, decideLoan, exchangePoints, listLoans, requestLoan, statement, takeAdvance } from '../lib/bank.js';
import {
  cancelGoalRequest, decideAutoSave, decideGoalProposal, decideGoalRequest, giveGoalGift, goalDeposit, goalWithdrawEarly, listGoalProposals,
  listGoalRequests, requestGoalAction, reverseContribution, setAutoSave, setGoalPhoto, setMatchRule,
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

  // ---------- I19: metas propuestas por el hijo, ahorro automático, aporte de los padres, aportes puntuales y foto ----------
  app.get('/api/goal-proposals', async (req) => {
    const u = requireAdult(req);
    return listGoalProposals(getPool(), u.familyId);
  });

  app.post('/api/goals/:id/proposal/:decision', async (req) => {
    const u = requireAdult(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(['approve', 'reject']) }).parse(req.params);
    const b = z.object({
      title: z.string().trim().min(1).max(80).optional(), targetCents: z.number().int().positive().max(100000000).optional(),
      emoji: z.string().trim().max(16).nullable().optional(), note: z.string().trim().max(300).optional(),
    }).parse(req.body ?? {});
    return decideGoalProposal(u, id, { approve: decision === 'approve', ...b });
  });

  // Ahorro automático: el hijo lo pide (espera aprobación) o un adulto lo fija.
  app.put('/api/goals/:id/auto', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ percent: z.number().int().min(0).max(100) }).parse(req.body);
    return setAutoSave(u, id, b.percent);
  });

  app.post('/api/goals/:id/auto/:decision', async (req) => {
    const u = requireAdult(req);
    const { id, decision } = z.object({ id: uuid, decision: z.enum(['approve', 'reject']) }).parse(req.params);
    return decideAutoSave(u, id, decision === 'approve');
  });

  // Regla del aporte de los padres («1 € por cada 4 € ahorrados, hasta X»). Cuerpo vacío o null la quita.
  app.put('/api/goals/:id/match', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({
      perCents: z.number().int().positive().max(100000000), givesCents: z.number().int().positive().max(100000000), capCents: z.number().int().positive().max(100000000),
    }).nullable().parse(req.body ?? null);
    return setMatchRule(u, id, b);
  });

  // Aporte puntual a la meta: adultos y parientes.
  app.post('/api/goals/:id/gift', async (req) => {
    const u = requireGrownUp(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ cents: z.number().int().positive().max(100000000), message: z.string().trim().max(140).optional() }).parse(req.body);
    enforceLimit(req, 'gift', 60);
    return giveGoalGift(u, id, { ...b, idempotencyKey: idemKey(req) });
  });

  app.post('/api/goals/:id/contributions/:entryId/reverse', async (req) => {
    const u = requireAdult(req);
    const { id, entryId } = z.object({ id: uuid, entryId: uuid }).parse(req.params);
    return reverseContribution(u, id, entryId);
  });

  // Foto de la meta: se procesa como las demás (1280 px, sin EXIF) y NO caduca mientras la meta siga abierta.
  app.post('/api/goals/:id/photo', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    if (!req.isMultipart()) throw badRequest('Falta la foto');
    let rel: string | null = null;
    for await (const part of req.parts()) {
      if (part.type !== 'file') continue;
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(part.mimetype)) throw badRequest('La foto debe ser JPG, PNG o WebP');
      enforceLimit(req, 'upload', config.limits.uploadPerHour);
      const stored = (await one<{ n: number }>(getPool(), `SELECT ((SELECT count(*) FROM task_instances WHERE family_id = $1 AND photo_path IS NOT NULL) + (SELECT count(*) FROM savings_goals WHERE family_id = $1 AND photo_path IS NOT NULL))::int AS n`, [u.familyId]))!.n;
      if (stored >= config.caps.maxPhotos) throw conflict('La familia ha llegado al máximo de fotos guardadas.', 'too_many_photos');
      const raw = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, `La foto pesa demasiado (máximo ${Math.round(config.maxUploadBytes / 1048576)} MB)`, 'too_large');
      if (!looksLikeImage(raw, part.mimetype)) throw badRequest('El archivo no es una foto válida');
      const out = await processPhoto(raw, part.mimetype);
      rel = await storePhoto(u.familyId, out.data, out.ext);
    }
    if (!rel) throw badRequest('Falta la foto');
    try {
      return await setGoalPhoto(u, id, rel);
    } catch (e) {
      removePhotoFile(rel);
      throw e;
    }
  });

  app.get('/api/goals/:id/photo', async (req, reply) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const g = await one(getPool(), 'SELECT user_id, photo_path FROM savings_goals WHERE id = $1 AND family_id = $2 AND NOT archived', [id, u.familyId]);
    if (!g?.photo_path) throw notFound('Sin foto');
    if (u.role === 'child' && u.id !== g.user_id) throw forbidden();
    const abs = path.resolve(config.uploadDir, g.photo_path);
    if (!abs.startsWith(path.resolve(config.uploadDir) + path.sep)) throw notFound('Sin foto');
    if (!fs.existsSync(abs)) throw notFound('Sin foto');
    const ext = path.extname(abs).slice(1);
    reply.header('Cache-Control', 'private, no-cache');
    reply.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    return reply.send(fs.createReadStream(abs));
  });
}
