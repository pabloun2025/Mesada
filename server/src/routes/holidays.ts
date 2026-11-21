import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { isValidDate } from '../lib/dates.js';

const day = z.string().refine(isValidDate, 'fecha no válida');

// Festivos y vacaciones de la familia: ese día rige la hora límite de fin de semana.
export default async function holidayRoutes(app: FastifyInstance) {
  app.get('/api/holidays', async (req) => {
    const u = requireUser(req);
    return { holidays: await many(getPool(), 'SELECT day, label FROM family_holidays WHERE family_id = $1 ORDER BY day', [u.familyId]) };
  });

  app.post('/api/holidays', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ day, label: z.string().trim().max(80).default('') }).parse(req.body);
    await getPool().query(
      'INSERT INTO family_holidays(family_id, day, label) VALUES ($1,$2,$3) ON CONFLICT (family_id, day) DO UPDATE SET label = EXCLUDED.label',
      [u.familyId, b.day, b.label],
    );
    await audit(getPool(), u.familyId, u.id, 'holiday.add', 'family', u.familyId, b);
    return { holiday: b };
  });

  app.delete('/api/holidays/:day', async (req) => {
    const u = requireAdult(req);
    const p = z.object({ day }).parse(req.params);
    const r = await getPool().query('DELETE FROM family_holidays WHERE family_id = $1 AND day = $2', [u.familyId, p.day]);
    if (!r.rowCount) throw notFound('Festivo no encontrado');
    await audit(getPool(), u.familyId, u.id, 'holiday.remove', 'family', u.familyId, p);
    return { ok: true };
  });
}
