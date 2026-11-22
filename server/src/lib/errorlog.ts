import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { getPool } from './db.js';

/** Código corto y fácil de dictar (sin 0/O ni 1/I). */
export function newErrorId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(8), (b) => alphabet[b % alphabet.length]).join('');
}

/**
 * Guarda un error 5xx para poder buscarlo por su código. No se guarda nada personal:
 * ni cabeceras, ni cookies, ni cuerpo, ni parámetros de la ruta (solo su plantilla).
 * Se conservan 30 días. Si la base falla, el registro del contenedor sigue teniendo el error.
 */
export async function recordServerError(id: string, req: FastifyRequest, err: unknown, status = 500) {
  const e = err as Error;
  const route = String((req as any).routeOptions?.url ?? req.url.split('?')[0]).slice(0, 200);
  try {
    await getPool().query(
      'INSERT INTO server_errors(id, method, route, status, message, stack) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING',
      [id, req.method, route, status, String(e?.message ?? e).slice(0, 300), String(e?.stack ?? '').split('\n').slice(0, 8).join('\n').slice(0, 1500)],
    );
    await getPool().query(`DELETE FROM server_errors WHERE created_at < now() - interval '30 days'`);
  } catch {
    /* sin base de datos: queda en el registro del contenedor */
  }
}
