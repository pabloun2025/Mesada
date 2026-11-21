import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { decideRedemption, requestRedemption } from '../lib/money.js';

const rewardBody = z.object({
  title: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(''),
  icon: z.string().max(16).default('🎁'),
  costPoints: z.number().int().min(1).max(1000000),
});

export default async function rewardRoutes(app: FastifyInstance) {
  app.get('/api/rewards', async (req) => {
    const u = requireUser(req);
    return { rewards: await many(getPool(), 'SELECT * FROM rewards WHERE family_id = $1 AND active ORDER BY cost_points', [u.familyId]) };
  });

  app.post('/api/rewards', async (req) => {
    const u = requireAdult(req);
    const b = rewardBody.parse(req.body);
    const r = await one(getPool(), 'INSERT INTO rewards(family_id, title, description, icon, cost_points) VALUES ($1,$2,$3,$4,$5) RETURNING *', [u.familyId, b.title, b.description, b.icon, b.costPoints]);
    await audit(getPool(), u.familyId, u.id, 'reward.create', 'reward', r.id, b);
    return { reward: r };
  });

  app.put('/api/rewards/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = rewardBody.parse(req.body);
    const r = await one(getPool(), 'UPDATE rewards SET title=$3, description=$4, icon=$5, cost_points=$6 WHERE id=$1 AND family_id=$2 AND active RETURNING *', [id, u.familyId, b.title, b.description, b.icon, b.costPoints]);
    if (!r) throw notFound('Recompensa no encontrada');
    await audit(getPool(), u.familyId, u.id, 'reward.update', 'reward', id, b);
    return { reward: r };
  });

  app.delete('/api/rewards/:id', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await getPool().query('UPDATE rewards SET active = false WHERE id = $1 AND family_id = $2', [id, u.familyId]);
    if (!r.rowCount) throw notFound('Recompensa no encontrada');
    await audit(getPool(), u.familyId, u.id, 'reward.archive', 'reward', id);
    return { ok: true };
  });

  app.post('/api/rewards/:id/redeem', async (req) => {
    const u = requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return { redemption: await requestRedemption(u, id) };
  });

  app.get('/api/redemptions', async (req) => {
    const u = requireUser(req);
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = await many(
      getPool(),
      `SELECT r.*, u.display_name, u.avatar, u.color FROM redemptions r JOIN users u ON u.id = r.user_id
        WHERE r.family_id = $1 AND ($2::uuid IS NULL OR r.user_id = $2) AND ($3::text[] IS NULL OR r.status = ANY($3))
        ORDER BY r.requested_at DESC LIMIT 200`,
      [u.familyId, u.role === 'child' ? u.id : null, q.status ? q.status.split(',') : null],
    );
    return { redemptions: rows };
  });

  app.post('/api/redemptions/:id/decide', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ decision: z.enum(['approved', 'rejected', 'delivered']), note: z.string().max(300).default('') }).parse(req.body);
    return decideRedemption(u, id, b.decision, b.note);
  });
}
