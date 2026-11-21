import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { conflict, forbidden, notFound } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { addScreen, screenBalance } from '../lib/screen.js';
import { notify } from '../lib/notify/dispatch.js';

const uuid = z.string().uuid();

async function assertChild(userId: string, familyId: string) {
  const m = await one(getPool(), `SELECT id FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active`, [userId, familyId]);
  if (!m) throw notFound('Miembro no encontrado');
}

export default async function screenRoutes(app: FastifyInstance) {
  // Saldo e historial de minutos de pantalla. Un hijo solo ve los suyos.
  app.get('/api/screen/:userId', async (req) => {
    const u = requireUser(req);
    const { userId } = z.object({ userId: uuid }).parse(req.params);
    if (u.role === 'child' && u.id !== userId) throw forbidden();
    await assertChild(userId, u.familyId);
    const entries = await many(
      getPool(),
      `SELECT l.id, l.delta, l.kind, l.note, l.created_at, c.display_name AS created_by_name
         FROM screen_ledger l LEFT JOIN users c ON c.id = l.created_by WHERE l.user_id = $1 ORDER BY l.created_at DESC, l.id LIMIT 100`,
      [userId],
    );
    return { balance: await screenBalance(getPool(), userId), entries };
  });

  // Gastar minutos (adulto). Se recorta al saldo; si no queda nada, error.
  app.post('/api/screen/spend', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ userId: uuid, minutes: z.number().int().min(1).max(1440), note: z.string().trim().max(200).default('') }).parse(req.body);
    await assertChild(b.userId, u.familyId);
    return tx(async (db) => {
      const r = await addScreen(db, { familyId: u.familyId, userId: b.userId, delta: -b.minutes, kind: 'spend', note: b.note || 'Tiempo de pantalla', createdBy: u.id });
      if (r.applied === 0) throw conflict('No quedan minutos de pantalla', 'insufficient_balance');
      await audit(db, u.familyId, u.id, 'screen.spend', 'user', b.userId, { minutes: -r.applied, requested: b.minutes });
      return { applied: -r.applied, requested: b.minutes, balance: r.balance };
    });
  });

  // Ajuste manual (adulto): positivo regala minutos, negativo los resta (recortado a 0).
  app.post('/api/screen/adjust', async (req) => {
    const u = requireAdult(req);
    const b = z.object({ userId: uuid, delta: z.number().int().refine((n) => n !== 0).refine((n) => Math.abs(n) <= 1440), note: z.string().trim().min(1).max(200) }).parse(req.body);
    await assertChild(b.userId, u.familyId);
    return tx(async (db) => {
      const r = await addScreen(db, { familyId: u.familyId, userId: b.userId, delta: b.delta, kind: 'adjustment', note: b.note, createdBy: u.id });
      if (b.delta < 0 && r.applied === 0) throw conflict('No quedan minutos de pantalla', 'insufficient_balance');
      await audit(db, u.familyId, u.id, 'screen.adjust', 'user', b.userId, { delta: r.applied, requested: b.delta, note: b.note });
      await notify(db, { userId: b.userId, event: 'screen_changed', title: r.applied > 0 ? `+${r.applied} min de pantalla` : `${r.applied} min de pantalla`, body: b.note, link: '/mesada' });
      return { applied: r.applied, requested: b.delta, balance: r.balance };
    });
  });
}
