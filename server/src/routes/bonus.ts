import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const uuid = z.string().uuid();

const SELECT = `
  SELECT g.id, g.user_id, g.task_title, g.kind, g.points, g.minutes, g.label, g.surprise, g.revealed_at, g.fulfilled_at, g.created_at,
         u.display_name, u.avatar, u.color
    FROM bonus_grants g JOIN users u ON u.id = g.user_id`;

export default async function bonusRoutes(app: FastifyInstance) {
  // Bonos de texto/recompensa pendientes de cumplir (adultos: toda la familia; hijos: los suyos ya desvelados).
  app.get('/api/bonus-grants', async (req) => {
    const u = requireUser(req);
    const q = z.object({ status: z.enum(['pending', 'all']).default('pending') }).parse(req.query);
    const rows = await many(
      getPool(),
      `${SELECT}
        WHERE g.family_id = $1 AND g.voided_at IS NULL AND g.kind IN ('text','reward')
          AND ($2::uuid IS NULL OR g.user_id = $2)
          AND ($3 = 'all' OR g.fulfilled_at IS NULL)
        ORDER BY g.created_at DESC LIMIT 100`,
      [u.familyId, u.role === 'child' ? u.id : null, q.status],
    );
    // Una sorpresa aún sin abrir no enseña su contenido a quien la ha ganado.
    return { grants: rows.map((g) => (u.role === 'child' && g.surprise && !g.revealed_at ? { ...g, label: '🎁 Sorpresa', points: 0, minutes: 0 } : g)) };
  });

  // Sorpresas ganadas que el hijo todavía no ha visto (para la animación al abrir la app).
  app.get('/api/bonus-grants/unrevealed', async (req) => {
    const u = requireUser(req);
    const rows = await many(
      getPool(),
      `${SELECT} WHERE g.user_id = $1 AND g.surprise AND g.revealed_at IS NULL AND g.voided_at IS NULL ORDER BY g.created_at`,
      [u.id],
    );
    return { grants: u.role === 'child' ? rows : [] };
  });

  app.post('/api/bonus-grants/:id/reveal', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await getPool().query('UPDATE bonus_grants SET revealed_at = COALESCE(revealed_at, now()) WHERE id = $1 AND user_id = $2 AND surprise', [id, u.id]);
    if (!r.rowCount) throw notFound('Sorpresa no encontrada');
    return { ok: true };
  });

  app.post('/api/bonus-grants/:id/fulfill', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const g = await one(
      getPool(),
      `UPDATE bonus_grants SET fulfilled_at = COALESCE(fulfilled_at, now()), fulfilled_by = COALESCE(fulfilled_by, $3)
        WHERE id = $1 AND family_id = $2 AND kind IN ('text','reward') AND voided_at IS NULL RETURNING id, label`,
      [id, u.familyId, u.id],
    );
    if (!g) throw notFound('Bono no encontrado');
    await audit(getPool(), u.familyId, u.id, 'bonus.fulfill', 'bonus_grant', id, { label: g.label });
    return { ok: true };
  });
}
