import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one } from '../src/lib/db.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const L = () => F.ids.lucia;

beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); await closePool(); });
beforeEach(async () => { resetLoginFailures(); await resetDb(); F = await createFamily(app); });

const goalsOf = async () => (await F.luciaC.get(`/api/goals/${L()}`)).body.goals as any[];
const money = async () => (await F.luciaC.get(`/api/bank/${L()}`)).body.bank.money_cents as number;
const notes = (kind: string) => many(getPool(), `SELECT * FROM notifications WHERE user_id=$1 AND kind=$2 ORDER BY created_at, id`, [L(), kind]);

async function activeGoal(target = 5000, title = 'Vinilo') {
  const g = (await F.luciaC.post('/api/goals', { userId: L(), title, targetCents: target })).body.goal;
  expect((await F.mama.post(`/api/goals/${g.id}/proposal/approve`, {})).status).toBe(200);
  return g as { id: string };
}

describe('Padres editan y cancelan metas de ahorro', () => {
  it('un adulto cambia nombre, precio y emoji de una meta activa; el hijo no puede y recibe aviso', async () => {
    const g = await activeGoal();
    expect((await F.luciaC.patch(`/api/goals/${g.id}`, { title: 'Otra' })).status).toBe(403);
    const r = await F.mama.patch(`/api/goals/${g.id}`, { title: 'Vinilo doble', targetCents: 3500, emoji: '🎧' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.changed).toBe(true);
    expect((await goalsOf()).find((x) => x.id === g.id)).toMatchObject({ title: 'Vinilo doble', target_cents: 3500, emoji: '🎧' });
    expect((await notes('goal_decided')).at(-1)!.title).toContain('ha cambiado tu meta «Vinilo»');
    // Sin cambios no se avisa de nuevo.
    expect((await F.mama.patch(`/api/goals/${g.id}`, { title: 'Vinilo doble' })).body.changed).toBe(false);
    expect((await F.mama.patch(`/api/goals/${g.id}`, { targetCents: 0 })).status).toBe(400);
  });

  it('cancelar una meta con dinero devuelve lo ahorrado al banco, pierde aportes y avisa con el motivo', async () => {
    const g = await activeGoal(10000);
    await F.mama.post('/api/adjustments/money', { userId: L(), deltaCents: 2000, note: 'Base' });
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1500 })).status).toBe(200);
    expect((await F.mama.post(`/api/goals/${g.id}/gift`, { cents: 300 })).status).toBe(200);
    expect(await money()).toBe(500);
    const r = await F.mama.del(`/api/goals/${g.id}`, { reason: 'Mejor algo más útil' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ returned_cents: 1500, forfeited_cents: 300 });
    expect(await money()).toBe(2000);
    expect((await goalsOf()).some((x) => x.id === g.id)).toBe(false);
    const n = (await notes('goal_decided')).at(-1)!;
    expect(n.title).toContain('ha cancelado tu meta «Vinilo»');
    expect(n.body).toContain('15,00 €');
    expect(n.body).toContain('Mejor algo más útil');
    const row = await one(getPool(), `SELECT archived FROM savings_goals WHERE id = $1`, [g.id]);
    expect(row!.archived).toBe(true);
    // Ya cancelada: 404.
    expect((await F.mama.del(`/api/goals/${g.id}`)).status).toBe(404);
  });

  it('el hijo puede cancelar su propia meta sin dinero y no la de su hermano; con petición pendiente no se cancela', async () => {
    const g = await activeGoal(500);
    const other = (await F.mama.post('/api/goals', { userId: F.ids.hugo, title: 'Balón', targetCents: 2000 })).body.goal;
    expect((await F.luciaC.del(`/api/goals/${other.id}`)).status).toBe(403);
    await F.mama.post('/api/adjustments/money', { userId: L(), deltaCents: 500, note: 'Base' });
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 500 });
    expect((await F.luciaC.post(`/api/goals/${g.id}/redeem`)).status).toBe(200);
    expect((await F.mama.del(`/api/goals/${g.id}`)).status).toBe(409);
    const g2 = await activeGoal(800, 'Libro');
    expect((await F.luciaC.del(`/api/goals/${g2.id}`)).body).toMatchObject({ ok: true, returned_cents: 0 });
  });
});
