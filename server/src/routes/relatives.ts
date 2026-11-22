import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPool, many, one, tx } from '../lib/db.js';
import { requireGrownUp } from '../lib/auth.js';
import { conflict, notFound } from '../lib/errors.js';
import { getFamily } from '../lib/family.js';
import { ensureInstancesThrottled } from '../lib/instances.js';
import { listGoals } from '../lib/savings.js';
import { notify, notifyAdults } from '../lib/notify/dispatch.js';
import { audit } from '../lib/audit.js';
import { whoText } from '../lib/kinship.js';
import { progressFor } from './insights.js';

/** Máximo de felicitaciones que puede enviar una persona por hora (para que no sea un chat). */
const CHEERS_PER_HOUR = 10;

export default async function relativeRoutes(app: FastifyInstance) {
  /** Inicio del pariente: cada niño con su progreso de la semana, su racha y sus metas de ahorro abiertas. Sin tareas ni gestión. */
  app.get('/api/relative/overview', async (req) => {
    const u = requireGrownUp(req);
    const db = getPool();
    await ensureInstancesThrottled(db, u.familyId);
    const fam = await getFamily(db, u.familyId);
    const kids = await many<{ id: string }>(db, `SELECT id FROM users WHERE family_id = $1 AND role = 'child' AND active ORDER BY created_at`, [u.familyId]);
    const children = await Promise.all(
      kids.map(async (k) => {
        const p = await progressFor(fam, k.id);
        const goals = (await listGoals(db, k.id)).filter((g) => g.status === 'active');
        return {
          ...p.user,
          level: p.level, streak: p.streak, week: p.week,
          goals: goals.map((g) => ({
            id: g.id, title: g.title, emoji: g.emoji, has_photo: g.has_photo, target_cents: g.target_cents, balance_cents: g.balance_cents,
            reached: g.reached, weeks_left: g.weeks_left, pending_request: !!g.pending_request,
          })),
        };
      }),
    );
    return { children };
  });

  /** Felicitar a un niño: un mensaje corto que le llega como aviso. Lo pueden hacer adultos y parientes. */
  app.post('/api/cheers', async (req) => {
    const u = requireGrownUp(req);
    const b = z.object({ toUserId: z.string().uuid(), message: z.string().trim().min(1, 'Escribe un mensaje').max(140, 'Máximo 140 caracteres') }).parse(req.body);
    const id = await tx(async (db) => {
      const child = await one(db, `SELECT id FROM users WHERE id = $1 AND family_id = $2 AND role = 'child' AND active`, [b.toUserId, u.familyId]);
      if (!child) throw notFound('Miembro no encontrado');
      const n = (await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM cheers WHERE from_user_id = $1 AND created_at > now() - interval '1 hour'`, [u.id]))!.n;
      if (n >= CHEERS_PER_HOUR) throw conflict('Has enviado muchas felicitaciones seguidas. Prueba dentro de un rato.', 'cheer_limit');
      const c = await one(db, 'INSERT INTO cheers(family_id, from_user_id, to_user_id, message) VALUES ($1,$2,$3,$4) RETURNING id', [u.familyId, u.id, b.toUserId, b.message]);
      const who = whoText(u.displayName, u.relationship, u.relationshipLabel);
      await audit(db, u.familyId, u.id, 'cheer.send', 'user', b.toUserId, { for: b.toUserId });
      await notify(db, { userId: b.toUserId, event: 'cheer', title: `${who} te felicita`, body: b.message, link: '/progreso', dedupeKey: `cheer:${c.id}` });
      if (u.isRelative) {
        const name = (await one(db, 'SELECT display_name FROM users WHERE id = $1', [b.toUserId]))!.display_name;
        await notifyAdults(db, u.familyId, { event: 'relative_activity', title: `${who} ha felicitado a ${name}`, body: b.message, link: '/', dedupeKey: `cheer-adults:${c.id}` });
      }
      return c.id as string;
    });
    return { ok: true, id };
  });
}
