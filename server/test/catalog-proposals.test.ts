import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many } from '../src/lib/db.js';
import { setSetting } from '../src/lib/settings.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const path = '/api/catalog-proposals';

beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); await closePool(); });
beforeEach(async () => { resetLoginFailures(); await resetDb(); F = await createFamily(app); });

describe('ideas de tareas y premios', () => {
  it('solo muestra el borrador a su autor y a los adultos gestores de su familia', async () => {
    const r = await F.luciaC.post(path, { kind: 'task', title: 'Regar el patio', description: 'Dos macetas', points: 8 });
    expect(r.status).toBe(200);
    const { id } = r.body.proposal;
    expect((await F.luciaC.get(path)).body.proposals).toMatchObject([{ id, status: 'pending', title: 'Regar el patio' }]);
    expect((await F.hugoC.get(path)).body.proposals).toEqual([]);
    expect((await F.mama.get(`${path}?status=pending`)).body.proposals).toMatchObject([{ id, display_name: 'Lucía' }]);
    expect((await F.mama.get('/api/dashboard')).body.pendingProposals).toBe(1);
    expect((await F.luciaC.post(`${path}/${id}/decide`, { action: 'approve' })).status).toBe(403);
    await setSetting('registration_open', true);
    const other = await createFamily(app, 'other');
    expect((await other.mama.get(path)).body.proposals).toEqual([]);
    expect((await other.mama.post(`${path}/${id}/decide`, { action: 'approve' })).status).toBe(404);
    expect((await F.luciaC.get('/api/tasks')).body.tasks).toEqual([]);
  });

  it('crea una sola tarea para el hijo cuando dos adultos deciden la misma idea', async () => {
    const created = await F.luciaC.post(path, { kind: 'task', title: 'Regar el patio', points: 8 });
    expect(created.status).toBe(200);
    const decide = `${path}/${created.body.proposal.id}/decide`;
    const a = await F.mama.post(decide, { action: 'edit', title: 'Regar el jardín' });
    expect(a).toMatchObject({ status: 400, body: { error: 'proposal_reason_required' } });
    const results = await Promise.all([
      F.mama.post(decide, { action: 'edit', title: 'Regar el jardín', points: 10, note: 'Hoy también hay que regar el jardín' }),
      F.papaC.post(decide, { action: 'approve' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const chosen = results.find((r) => r.status === 200)!.body.proposal;
    expect(chosen).toMatchObject({ title: 'Regar el patio', status: 'approved', result_id: expect.any(String) });
    expect(await many(getPool(), 'SELECT id FROM tasks')).toEqual([{ id: chosen.result_id }]);
    const mine = (await F.luciaC.get('/api/instances')).body.instances;
    expect(mine).toMatchObject([{ title: chosen.result_title, points: chosen.result_points, assignee_id: F.ids.lucia, requires_approval: true }]);
    expect((await F.hugoC.get('/api/instances')).body.instances).toEqual([]);
  });

  it('publica el premio normal al aprobar y guarda el motivo de un rechazo', async () => {
    const missingPrice = await F.luciaC.post(path, { kind: 'reward', title: 'Elegir el postre' });
    const approval = `${path}/${missingPrice.body.proposal.id}/decide`;
    expect((await F.mama.post(approval, { action: 'approve' })).status).toBe(400);
    expect((await F.mama.post(approval, { action: 'approve', points: 40 })).status).toBe(200);
    expect((await F.hugoC.get('/api/rewards')).body.rewards).toMatchObject([{ title: 'Elegir el postre', cost_points: 40 }]);
    const r = await F.luciaC.post(path, { kind: 'reward', title: 'Salir más tarde', points: 70 });
    const rejection = `${path}/${r.body.proposal.id}/decide`;
    expect((await F.mama.post(rejection, { action: 'reject' })).status).toBe(400);
    expect((await F.mama.post(rejection, { action: 'reject', note: 'Mañana es día de cole' })).status).toBe(200);
    expect((await F.luciaC.get(`${path}?kind=reward`)).body.proposals[0]).toMatchObject({ status: 'rejected', decision_note: 'Mañana es día de cole' });
    expect(await many(getPool(), 'SELECT title FROM rewards')).toEqual([{ title: 'Elegir el postre' }]);
  });
});
