import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { getPool, one, tx } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { badRequest, conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { enforceLimit } from '../lib/limits.js';
import { looksLikeImage, processPhoto, removePhotoFile, storePhoto } from '../lib/photos.js';
import { config } from '../lib/config.js';
import { audit } from '../lib/audit.js';
import { SCREEN_CATEGORIES } from '../lib/screen.js';
import {
  addOverrun, approveSession, cancelSession, createBlock, extendSession, liftBlock, listSessions, pendingChallenges, pendingSessions, rejectSession, reviewChallenge,
  saveRules, screenState, startSession, stopSession, submitChallenge, getRates,
} from '../lib/screen-sessions.js';

const uuid = z.string().uuid();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

function idemKey(req: FastifyRequest): string | undefined {
  const k = req.headers['idempotency-key'];
  return typeof k === 'string' && k.length >= 8 && k.length <= 100 ? k : undefined;
}

/** I21 (D65–D70): temporizador de pantalla, días de uso, tiempo extra y castigos con retos. */
export default async function screenSessionRoutes(app: FastifyInstance) {
  // Todo lo de «Mi pantalla» / «Pantalla» en una llamada. Un hijo solo ve lo suyo.
  app.get('/api/screen/:userId/state', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    if (u.role === 'child' && u.id !== userId) throw forbidden();
    return screenState(u, userId);
  });

  app.get('/api/screen/:userId/sessions', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    if (u.role === 'child' && u.id !== userId) throw forbidden();
    return { sessions: await listSessions(getPool(), u.familyId, userId) };
  });

  // Empezar: el hijo para sí mismo; un adulto para un hijo (con temporizador o «solo descontar»).
  app.post('/api/screen/sessions', async (req) => {
    const u = requireUser(req);
    const b = z.object({
      userId: uuid.optional(), minutes: z.number().int().min(1).max(720), category: z.enum(SCREEN_CATEGORIES).nullable().optional(), note: z.string().trim().max(200).optional(),
      extra: z.boolean().optional(), mode: z.enum(['start', 'charge']).optional(), payWith: z.enum(['debt', 'points', 'money']).optional(),
    }).parse(req.body);
    if (u.role === 'adult') requireAdult(req);
    return startSession(u, { ...b, idempotencyKey: idemKey(req) });
  });

  app.get('/api/screen/sessions/pending', async (req) => {
    const u = requireAdult(req);
    return { sessions: await pendingSessions(getPool(), u.familyId), challenges: await pendingChallenges(getPool(), u.familyId) };
  });

  app.post('/api/screen/sessions/:id/stop', async (req) => {
    const u = requireUser(req);
    if (u.role === 'adult') requireAdult(req);
    return stopSession(u, z.object({ id: uuid }).parse(req.params).id);
  });

  app.post('/api/screen/sessions/:id/extend', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return extendSession(u, id, z.object({ minutes: z.number().int().min(1).max(240) }).parse(req.body).minutes);
  });

  app.post('/api/screen/sessions/:id/approve', async (req) => {
    const u = requireAdult(req);
    return approveSession(u, z.object({ id: uuid }).parse(req.params).id);
  });

  app.post('/api/screen/sessions/:id/reject', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return rejectSession(u, id, z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {}).note);
  });

  app.post('/api/screen/sessions/:id/cancel', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo el hijo cancela su petición');
    return cancelSession(u, z.object({ id: uuid }).parse(req.params).id);
  });

  app.post('/api/screen/sessions/:id/overrun', async (req) => {
    const u = requireUser(req);
    if (u.role === 'adult') requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    return addOverrun(u, id, z.object({ minutes: z.number().int().min(1).max(240) }).parse(req.body).minutes);
  });

  // ---------- Días de uso, topes y aprobación ----------
  app.put('/api/screen/rules/:userId', async (req) => {
    const u = requireAdult(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    const b = z.object({
      allowedDays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
      dayMax: z.record(z.string().regex(/^[1-7]$/), z.number().int().min(1).max(720)).default({}),
      requireApproval: z.boolean(),
    }).parse(req.body);
    return saveRules(u, userId, b);
  });

  // ---------- Tasa del tiempo extra pagado con puntos o dinero ----------
  app.get('/api/screen/rates', async (req) => {
    const u = requireUser(req);
    return getRates(getPool(), u.familyId);
  });

  app.put('/api/screen/rates', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ pointsPer15: z.number().int().min(1).max(1000), centsPer15: z.number().int().min(1).max(10000) }).parse(req.body);
    await tx(async (db) => {
      await db.query('UPDATE families SET screen_points_per_15 = $2, screen_cents_per_15 = $3 WHERE id = $1', [u.familyId, b.pointsPer15, b.centsPer15]);
      await audit(db, u.familyId, u.id, 'screen_rates.update', 'family', u.familyId, b);
    });
    return b;
  });

  // ---------- Castigos ----------
  app.post('/api/screen/blocks', async (req) => {
    const u = requireAdult(req);
    const b = z.object({
      userId: uuid, kind: z.enum(['days', 'window']), reason: z.string().trim().min(1).max(200), endsOn: day, windowStart: hhmm.optional(), windowEnd: hhmm.optional(),
      challenge: z.object({ text: z.string().trim().min(1).max(300), photo: z.boolean().optional(), effect: z.enum(['lift', 'shorten']), days: z.number().int().min(1).max(30).optional() }).nullable().optional(),
    }).parse(req.body);
    return createBlock(u, b);
  });

  app.post('/api/screen/blocks/:id/lift', async (req) => {
    const u = requireAdult(req);
    return liftBlock(u, z.object({ id: uuid }).parse(req.params).id);
  });

  // El hijo marca el reto como hecho: JSON o multipart (nota y foto).
  app.post('/api/screen/blocks/:id/challenge/done', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo el hijo cumple su reto');
    const { id } = z.object({ id: uuid }).parse(req.params);
    let note: string | undefined;
    let photoPath: string | null = null;
    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(part.mimetype)) throw badRequest('La foto debe ser JPG, PNG o WebP');
          enforceLimit(req, 'upload', config.limits.uploadPerHour);
          const stored = (await one<{ n: number }>(getPool(), `SELECT ((SELECT count(*) FROM task_instances WHERE family_id = $1 AND photo_path IS NOT NULL) + (SELECT count(*) FROM savings_goals WHERE family_id = $1 AND photo_path IS NOT NULL) + (SELECT count(*) FROM screen_blocks WHERE family_id = $1 AND challenge_photo_path IS NOT NULL))::int AS n`, [u.familyId]))!.n;
          if (stored >= config.caps.maxPhotos) throw conflict('La familia ha llegado al máximo de fotos guardadas.', 'too_many_photos');
          const raw = await part.toBuffer();
          if (part.file.truncated) throw new HttpError(413, `La foto pesa demasiado (máximo ${Math.round(config.maxUploadBytes / 1048576)} MB)`, 'too_large');
          if (!looksLikeImage(raw, part.mimetype)) throw badRequest('El archivo no es una foto válida');
          const out = await processPhoto(raw, part.mimetype);
          photoPath = await storePhoto(u.familyId, out.data, out.ext);
        } else if (part.fieldname === 'note') note = String(part.value).slice(0, 300);
      }
    } else note = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {}).note;
    try {
      return await submitChallenge(u, id, { note, photoPath });
    } catch (e) {
      removePhotoFile(photoPath);
      throw e;
    }
  });

  app.post('/api/screen/blocks/:id/challenge/review', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ approve: z.boolean(), note: z.string().trim().max(300).optional() }).parse(req.body);
    return reviewChallenge(u, id, b.approve, b.note);
  });

  app.get('/api/screen/blocks/:id/photo', async (req, reply) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await one(getPool(), 'SELECT user_id, challenge_photo_path AS p FROM screen_blocks WHERE id = $1 AND family_id = $2', [id, u.familyId]);
    if (!r?.p) throw notFound('Sin foto');
    if (u.role === 'child' && u.id !== r.user_id) throw forbidden();
    if (u.role === 'adult' && u.isRelative) throw forbidden();
    const abs = path.resolve(config.uploadDir, r.p);
    if (!abs.startsWith(path.resolve(config.uploadDir) + path.sep) || !fs.existsSync(abs)) throw new HttpError(410, 'Foto ya borrada', 'photo_deleted');
    const ext = path.extname(abs).slice(1);
    reply.header('Cache-Control', 'private, max-age=3600');
    reply.type(ext === 'jpg' ? 'image/jpeg' : `image/${ext}`);
    return reply.send(fs.createReadStream(abs));
  });
}
