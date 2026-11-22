import type { FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { z } from 'zod';
import { config } from '../lib/config.js';
import { getPool, one } from '../lib/db.js';
import { requireAdult, SESSION_COOKIE, verifyPassword } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { enforceLimit } from '../lib/limits.js';
import { eraseChild, eraseFamily, exportEntries } from '../lib/privacy.js';
import { zipStream } from '../lib/zip.js';

/** Frase que hay que escribir para borrar la familia (sin importar mayúsculas ni espacios de más). */
export const ERASE_PHRASE = 'BORRAR MI FAMILIA';
const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toUpperCase();

async function checkPassword(userId: string, password: string) {
  const row = await one<{ password_hash: string }>(getPool(), 'SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!row || !(await verifyPassword(password, row.password_hash))) throw badRequest('La contraseña no es correcta', 'wrong_password');
}

export default async function privacyRoutes(app: FastifyInstance) {
  // Descarga de todos los datos de la familia (acceso y portabilidad). Solo adultos.
  app.get('/api/privacy/export', async (req, reply) => {
    const u = requireAdult(req);
    enforceLimit(req, 'export', config.limits.exportPerHour);
    await audit(getPool(), u.familyId, u.id, 'privacy.export', 'family', u.familyId);
    const day = new Date().toISOString().slice(0, 10);
    reply.header('Content-Disposition', `attachment; filename="diplop-familia-${day}.zip"`);
    reply.header('Cache-Control', 'no-store');
    reply.type('application/zip');
    return reply.send(Readable.from(zipStream(exportEntries(u.familyId))));
  });

  // Borrar un hijo (cuenta, movimientos, fotos). Pide la contraseña de quien borra.
  app.post('/api/members/:id/delete', { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    const m = await one<{ id: string; role: string; display_name: string }>(getPool(), 'SELECT id, role, display_name FROM users WHERE id = $1 AND family_id = $2', [id, u.familyId]);
    if (!m) throw notFound('Miembro no encontrado');
    if (m.role !== 'child') throw forbidden('Solo se pueden borrar los datos de un hijo. Para un adulto, desactiva su cuenta o borra la familia.');
    await checkPassword(u.id, b.password);
    const r = await eraseChild(u.familyId, id);
    // Constancia sin el nombre del menor.
    await audit(getPool(), u.familyId, u.id, 'member.erase', 'user', null, { photos: r.photos });
    return { ok: true, photos: r.photos };
  });

  // Borrar la familia entera. Contraseña + frase de confirmación.
  app.post('/api/privacy/delete-family', { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } }, async (req, reply) => {
    const u = requireAdult(req);
    const b = z.object({ password: z.string().min(1).max(200), phrase: z.string().max(100) }).parse(req.body);
    if (norm(b.phrase) !== ERASE_PHRASE) throw badRequest(`Escribe exactamente: ${ERASE_PHRASE}`, 'phrase_mismatch');
    await checkPassword(u.id, b.password);
    // La administración de la instalación no puede quedarse sin nadie.
    const isAdmin = await one(getPool(), 'SELECT 1 FROM users WHERE family_id = $1 AND is_superadmin', [u.familyId]);
    if (isAdmin) {
      const other = await one(getPool(), 'SELECT 1 FROM users WHERE is_superadmin AND family_id <> $1 AND active', [u.familyId]);
      if (!other) throw conflict('Esta familia administra la instalación. Traspasa antes la administración a otra cuenta.', 'is_installation_admin');
    }
    const r = await eraseFamily(u.familyId);
    req.log.info({ erased: r }, 'familia borrada');
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
