import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, tx, type Db } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';

const uuid = z.string().uuid();

const SELECT = `
  SELECT g.id, g.user_id, g.task_title, g.kind, g.points, g.minutes, g.label, g.surprise, g.revealed_at, g.fulfilled_at, g.created_at,
         g.reward_id, g.swap_allowed, g.swapped_at,
         (g.swap_allowed AND g.original_reward_cost IS NOT NULL AND g.original_reward_id IS NOT NULL AND g.fulfilled_at IS NULL AND g.swapped_at IS NULL) AS can_swap,
         u.display_name, u.avatar, u.color
    FROM bonus_grants g JOIN users u ON u.id = g.user_id`;

interface SwapGrant {
  user_id: string; kind: string; surprise: boolean; label: string; reward_id: string | null; swap_allowed: boolean;
  original_reward_id: string | null; original_reward_title: string | null; original_reward_cost: number | null;
  swapped_at: Date | null; revealed_at: Date | null; fulfilled_at: Date | null; voided_at: Date | null;
}

async function loadGrant(db: Db, id: string, familyId: string, childId: string | null, lock = false) {
  const grant = await one<SwapGrant>(db, `SELECT * FROM bonus_grants
    WHERE id = $1 AND family_id = $2 AND ($3::uuid IS NULL OR user_id = $3) AND voided_at IS NULL ${lock ? 'FOR UPDATE' : ''}`,
  [id, familyId, childId]);
  if (!grant) throw notFound('Sorpresa no encontrada');
  return grant;
}

function assertOpenSwap(g: SwapGrant) {
  if (!g.revealed_at) throw conflict('Primero abre tu sorpresa', 'surprise_unrevealed');
  if (g.kind !== 'reward' || !g.surprise || !g.swap_allowed || !g.original_reward_cost || !g.original_reward_id) {
    throw conflict('Este premio no admite cambios', 'swap_unavailable');
  }
  if (g.fulfilled_at || g.swapped_at) throw conflict('Este premio ya está resuelto', 'already_decided');
}

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
    return { grants: rows.map((g) => (u.role === 'child' && g.surprise && !g.revealed_at
      ? { ...g, label: '🎁 Sorpresa', points: 0, minutes: 0, reward_id: null, swap_allowed: false, can_swap: false } : g)) };
  });

  // Sorpresas ganadas que el hijo todavía no ha visto (para la animación al abrir la app).
  app.get('/api/bonus-grants/unrevealed', async (req) => {
    const u = requireUser(req);
    const rows = await many(
      getPool(),
      `${SELECT} WHERE g.user_id = $1 AND g.surprise AND g.revealed_at IS NULL AND g.voided_at IS NULL ORDER BY g.created_at`,
      [u.id],
    );
    return { grants: u.role === 'child' ? rows.map(({ reward_id, ...g }) => g) : [] };
  });

  app.post('/api/bonus-grants/:id/reveal', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const r = await getPool().query('UPDATE bonus_grants SET revealed_at = COALESCE(revealed_at, now()) WHERE id = $1 AND user_id = $2 AND surprise AND voided_at IS NULL', [id, u.id]);
    if (!r.rowCount) throw notFound('Sorpresa no encontrada');
    return { ok: true };
  });

  app.get('/api/bonus-grants/:id/alternatives', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo quien ganó la sorpresa puede cambiarla');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const db = getPool();
    const grant = await loadGrant(db, id, u.familyId, u.id);
    assertOpenSwap(grant);
    const alternatives = await many(db, `SELECT id, title, description, icon FROM rewards
      WHERE family_id = $1 AND id <> $2 AND cost_points = $3 AND active AND swap_eligible ORDER BY title, id`,
    [u.familyId, grant.original_reward_id, grant.original_reward_cost]);
    return { original_title: grant.original_reward_title, cost_points: grant.original_reward_cost, alternatives };
  });

  app.post('/api/bonus-grants/:id/swap', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo quien ganó la sorpresa puede cambiarla');
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { rewardId } = z.object({ rewardId: uuid }).parse(req.body);
    return tx(async (db) => {
      const grant = await loadGrant(db, id, u.familyId, u.id, true);
      if (grant.swapped_at && grant.reward_id === rewardId) return { ok: true, duplicate: true, label: grant.label };
      assertOpenSwap(grant);
      const reward = await one<{ title: string }>(db, `SELECT title FROM rewards
        WHERE family_id = $1 AND id = $2 AND id <> $3 AND cost_points = $4 AND active AND swap_eligible FOR SHARE`,
      [u.familyId, rewardId, grant.original_reward_id, grant.original_reward_cost]);
      if (!reward) throw conflict('Este premio ya no está disponible como alternativa', 'swap_reward_unavailable');
      const label = `Premio: ${reward.title}`;
      await db.query('UPDATE bonus_grants SET reward_id = $2, label = $3, swapped_at = clock_timestamp() WHERE id = $1', [id, rewardId, label]);
      await audit(db, u.familyId, u.id, 'bonus.swap', 'bonus_grant', id, { rewardId, label });
      return { ok: true, duplicate: false, label };
    });
  });

  app.post('/api/bonus-grants/:id/fulfill', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { expectedRewardId } = z.object({ expectedRewardId: uuid.optional() }).parse(req.body ?? {});
    return tx(async (db) => {
      const grant = await loadGrant(db, id, u.familyId, null, true);
      if (grant.kind !== 'text' && grant.kind !== 'reward') throw notFound('Bono no encontrado');
      if (grant.swap_allowed && (!expectedRewardId || expectedRewardId !== grant.reward_id)) {
        throw conflict('El premio ha cambiado. Revisa el premio actual antes de entregarlo.', 'bonus_reward_changed');
      }
      if (grant.fulfilled_at) return { ok: true, duplicate: true };
      await db.query('UPDATE bonus_grants SET fulfilled_at = clock_timestamp(), fulfilled_by = $2 WHERE id = $1', [id, u.id]);
      await audit(db, u.familyId, u.id, 'bonus.fulfill', 'bonus_grant', id, { label: grant.label, rewardId: grant.reward_id, for: grant.user_id });
      return { ok: true, duplicate: false };
    });
  });
}
