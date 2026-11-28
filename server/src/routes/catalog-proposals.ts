import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { requireAdult, requireUser } from '../lib/auth.js';
import { getPool, many, one, tx } from '../lib/db.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { familyToday, getFamily } from '../lib/family.js';
import { notify, notifyAdults } from '../lib/notify/dispatch.js';
import { createReward, rewardBody } from './rewards.js';
import { createTask, taskBody } from './tasks.js';

const kind = z.enum(['task', 'reward']);
const title = z.string().trim().min(1).max(100);
const description = z.string().trim().max(1000);
const points = z.number().int().min(0).max(1000000);
const createBody = z.object({ kind, title, description: description.default(''), points: points.optional() }).superRefine((p, ctx) => {
  if (p.kind === 'task' && p.points !== undefined && p.points > 10000) ctx.addIssue({ code: 'custom', message: 'La tarea puede dar hasta 10 000 puntos', path: ['points'] });
  if (p.kind === 'reward') {
    if (p.title.length > 80) ctx.addIssue({ code: 'custom', message: 'El nombre del premio admite hasta 80 caracteres', path: ['title'] });
    if (p.description.length > 500) ctx.addIssue({ code: 'custom', message: 'El detalle del premio admite hasta 500 caracteres', path: ['description'] });
    if (p.points === 0) ctx.addIssue({ code: 'custom', message: 'El premio cuesta al menos un punto', path: ['points'] });
  }
});
const decideBody = z.object({
  action: z.enum(['approve', 'edit', 'reject']), title: title.optional(), description: description.optional(),
  points: points.optional(), note: z.string().trim().max(300).optional(),
});

export default async function catalogProposalRoutes(app: FastifyInstance) {
  app.get('/api/catalog-proposals', async (req) => {
    const u = requireUser(req);
    const q = z.object({ kind: kind.optional(), status: z.enum(['pending', 'approved', 'rejected']).optional() }).parse(req.query);
    return { proposals: await many(getPool(),
      `SELECT p.*, c.display_name, d.display_name AS decided_by_name FROM catalog_proposals p
       JOIN users c ON c.id = p.user_id LEFT JOIN users d ON d.id = p.decided_by
       WHERE p.family_id = $1 AND ($2::uuid IS NULL OR p.user_id = $2) AND ($3::text IS NULL OR p.kind = $3)
         AND ($4::text IS NULL OR p.status = $4) ORDER BY p.created_at DESC LIMIT 100`,
      [u.familyId, u.role === 'child' ? u.id : null, q.kind ?? null, q.status ?? null]) };
  });

  app.post('/api/catalog-proposals', async (req) => {
    const u = requireUser(req);
    if (u.role !== 'child') throw forbidden('Solo un hijo puede enviar una idea');
    const p = createBody.parse(req.body);
    return tx(async (db) => {
      const proposal = (await one<{ id: string }>(db, `INSERT INTO catalog_proposals (family_id, user_id, kind, title, description, points)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`, [u.familyId, u.id, p.kind, p.title, p.description, p.points ?? null]))!;
      await audit(db, u.familyId, u.id, 'proposal.submit', 'catalog_proposal', proposal.id, { kind: p.kind });
      await notifyAdults(db, u.familyId, { event: 'proposal_received', title: `Nueva propuesta de ${p.kind === 'task' ? 'tarea' : 'premio'}`, link: '/validar', dedupeKey: `proposal:${proposal.id}` });
      return { proposal };
    });
  });

  app.post('/api/catalog-proposals/:id/decide', async (req) => {
    const u = requireAdult(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const decision = decideBody.parse(req.body);
    if (decision.action !== 'approve' && !decision.note) throw badRequest('Escribe el motivo para el hijo', 'proposal_reason_required');
    return tx(async (db) => {
      const proposal = await one<{
        id: string; user_id: string; kind: 'task' | 'reward'; title: string; description: string; points: number | null; status: string;
      }>(db, `SELECT * FROM catalog_proposals WHERE id = $1 AND family_id = $2 FOR UPDATE`, [id, u.familyId]);
      if (!proposal) throw notFound('Propuesta no encontrada');
      if (proposal.status !== 'pending') throw conflict('Esta propuesta ya se ha resuelto', 'already_decided');
      if (decision.action !== 'reject') {
        if (!(await one(db, `SELECT id FROM users WHERE id = $1 AND family_id = $2 AND active AND role = 'child' FOR NO KEY UPDATE`, [proposal.user_id, u.familyId]))) {
          throw conflict('El hijo que hizo la propuesta ya no tiene una cuenta activa', 'proposal_child_inactive');
        }
      }
      const decidedAt = new Date();
      let result: { id: string; title: string; description: string; points: number } | null = null;
      if (decision.action !== 'reject') {
        if (decision.action === 'approve' && (
          (decision.title !== undefined && decision.title !== proposal.title) ||
          (decision.description !== undefined && decision.description !== proposal.description) ||
          (proposal.points !== null && decision.points !== undefined && decision.points !== proposal.points)
        )) throw badRequest('Usa Corregir para cambiar la propuesta y explica el motivo', 'proposal_edit_required');
        const title = decision.title ?? proposal.title;
        const description = decision.description ?? proposal.description;
        const points = decision.points ?? proposal.points;
        if (points == null) throw badRequest('Confirma los puntos de la propuesta', 'proposal_points_required');
        const resultId = proposal.kind === 'task'
          ? await createTask(db, u, taskBody.parse({ title, description, points, recurrence: 'once', startDate: familyToday(await getFamily(db, u.familyId), decidedAt), assignees: [proposal.user_id] }), proposal.user_id)
          : (await createReward(db, u, rewardBody.parse({ title, description, costPoints: points }), proposal.user_id)).id as string;
        result = { id: resultId, title, description, points };
      }
      const status = result ? 'approved' : 'rejected';
      const updated = await one(db, `UPDATE catalog_proposals SET status = $2, decision = $3, decision_note = $4, decided_by = $5, decided_at = $10,
        result_id = $6, result_title = $7, result_description = $8, result_points = $9 WHERE id = $1 RETURNING *`,
      [id, status, decision.action, decision.note ?? null, u.id, result?.id ?? null, result?.title ?? null, result?.description ?? null, result?.points ?? null, decidedAt]);
      await audit(db, u.familyId, u.id, 'proposal.decide', 'catalog_proposal', id, { for: proposal.user_id, kind: proposal.kind, decision: decision.action, resultId: result?.id ?? null });
      await notify(db, { userId: proposal.user_id, event: 'proposal_decided',
        title: result ? `${u.displayName} aprobó tu propuesta «${result.title}»` : `${u.displayName} rechazó tu propuesta «${proposal.title}»`,
        body: decision.note ?? '', link: proposal.kind === 'task' ? '/' : '/premios', dedupeKey: `proposal-decided:${id}` });
      return { proposal: updated };
    });
  });
}
