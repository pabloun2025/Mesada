import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './lib/config.js';
import { HttpError } from './lib/errors.js';
import { loadUser } from './lib/auth.js';
import authRoutes from './routes/auth.js';
import familyRoutes from './routes/family.js';
import taskRoutes from './routes/tasks.js';
import rewardRoutes from './routes/rewards.js';
import moneyRoutes from './routes/money.js';
import insightRoutes from './routes/insights.js';
import notificationRoutes from './routes/notifications.js';
import adminRoutes from './routes/admin.js';
import screenRoutes from './routes/screen.js';
import payoutRoutes from './routes/payouts.js';
import holidayRoutes from './routes/holidays.js';
import bonusRoutes from './routes/bonus.js';

export async function buildApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: true,
    bodyLimit: 256 * 1024,
  });

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 10 } });
  await app.register(rateLimit, { global: false });

  // Cabeceras de seguridad básicas.
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Permissions-Policy', 'camera=(self), geolocation=(), microphone=()');
  });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    // Protección CSRF: las mutaciones deben llevar una cabecera personalizada (no enviable entre sitios sin CORS).
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.headers['x-mesada'] !== '1') {
      throw new HttpError(403, 'Petición no permitida', 'csrf');
    }
    req.user = await loadUser(req);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      return reply.status(400).send({ error: 'validation', message: first ? `${first.path.join('.') || 'datos'}: ${first.message}` : 'Datos no válidos', issues: err.issues });
    }
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, message: err.message });
    if (err.statusCode === 429) return reply.status(429).send({ error: 'rate_limited', message: 'Demasiados intentos. Espera un minuto.' });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.status(413).send({ error: 'too_large', message: 'La foto es demasiado grande' });
    if (err.code === '23505') return reply.status(409).send({ error: 'duplicate', message: 'Ya existe un registro igual' });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: 'bad_request', message: err.message });
    req.log.error(err);
    return reply.status(500).send({ error: 'internal', message: 'Error interno del servidor' });
  });

  app.get('/api/health', async () => ({ ok: true }));

  await app.register(authRoutes);
  await app.register(familyRoutes);
  await app.register(taskRoutes);
  await app.register(rewardRoutes);
  await app.register(moneyRoutes);
  await app.register(insightRoutes);
  await app.register(notificationRoutes);
  await app.register(adminRoutes);
  await app.register(screenRoutes);
  await app.register(payoutRoutes);
  await app.register(holidayRoutes);
  await app.register(bonusRoutes);

  // En producción el servidor puede servir también la PWA compilada.
  if (config.staticDir && fs.existsSync(config.staticDir)) {
    await app.register(fastifyStatic, { root: config.staticDir, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'not_found', message: 'No encontrado' });
      return reply.sendFile('index.html');
    });
  }

  fs.mkdirSync(path.resolve(config.uploadDir), { recursive: true });
  return app;
}
