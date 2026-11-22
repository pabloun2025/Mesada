import type { FastifyRequest } from 'fastify';
import { config } from './config.js';
import { HttpError } from './errors.js';

/** IP del cliente: la de Cloudflare si la hay (no se puede falsear desde fuera del túnel); si no, la que ve Fastify. */
export function clientIp(req: FastifyRequest): string {
  if (config.trustCloudflareIp) {
    const cf = req.headers['cf-connecting-ip'];
    const v = Array.isArray(cf) ? cf[0] : cf;
    if (v && /^[0-9a-fA-F:.]{3,45}$/.test(v)) return v;
  }
  return req.ip;
}

const buckets = new Map<string, { count: number; resetAt: number }>();

/**
 * Límite por IP en una ventana fija (por defecto una hora), en memoria: vale para una sola instancia (P10).
 * `max` 0 = sin límite. Lanza 429 al pasarse; la respuesta no dice nada de la cuenta.
 */
export function enforceLimit(req: FastifyRequest, name: string, max: number, windowMs = 3_600_000) {
  if (!max || max <= 0) return;
  const now = Date.now();
  if (buckets.size > 5000) for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  const key = `${name}:${clientIp(req)}`;
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  if (b.count > max) {
    throw new HttpError(429, 'Demasiados intentos desde tu conexión. Prueba de nuevo dentro de un rato.', 'rate_limited');
  }
}

export function resetLimits() {
  buckets.clear();
}
