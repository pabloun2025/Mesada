import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool } from '../src/lib/db.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  await app.close();
  await closePool();
});
beforeEach(async () => {
  resetLoginFailures();
  await resetDb();
  F = await createFamily(app);
});

const L = () => F.ids.lucia;
const feed = async (c: { get: (u: string) => Promise<any> }) => (await c.get('/api/activity')).body.entries as any[];
const actions = (e: any[]) => e.map((x) => x.action);

describe('Historial con operaciones del banco', () => {
  it('los adultos ven canje, retiro, adelanto, préstamo, ahorro y compra de meta, y sobre quién recaen', async () => {
    await F.mama.post('/api/adjustments/points', { userId: L(), delta: 1000, note: 'Base' });
    await F.mama.patch('/api/family', { capCents: 1000 });
    await F.mama.post('/api/adjustments/money', { userId: L(), deltaCents: 3000, note: 'Base' });
    expect((await F.luciaC.post('/api/bank/exchange', { points: 200 })).status).toBe(200); // agota el tope
    expect((await F.luciaC.post('/api/bank/advance', { cents: 500 })).status).toBe(200);
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 500 })).status).toBe(200);
    const loan = (await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).body.loan;
    expect((await F.mama.post(`/api/loans/${loan.id}/approve`, {})).status).toBe(200);
    const g = (await F.luciaC.post('/api/goals', { userId: L(), title: 'Vinilo', targetCents: 1000 })).body.goal;
    expect((await F.mama.post(`/api/goals/${g.id}/proposal/approve`, {})).status).toBe(200);
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1000 })).status).toBe(200);
    const req = (await F.luciaC.post(`/api/goals/${g.id}/redeem`)).body.request;
    expect((await F.mama.post(`/api/goal-requests/${req.id}/approve`, { priceCents: 1000 })).status).toBe(200);

    const adult = await feed(F.papaC);
    for (const a of ['bank.exchange', 'bank.advance', 'payout.request', 'loan.request', 'loan.approve', 'savings.deposit', 'goal.request', 'goal.redeem']) {
      expect(actions(adult), a).toContain(a);
    }
    // La aprobación del adulto dice a quién se hizo.
    expect(adult.find((e) => e.action === 'loan.approve')).toMatchObject({ actor_name: 'Mamá', for_name: 'Lucía' });
    expect(adult.find((e) => e.action === 'goal.redeem')).toMatchObject({ for_name: 'Lucía' });
  });

  it('un hijo solo ve lo suyo: no lo de sus hermanos ni los ajustes de pantalla', async () => {
    await F.mama.post('/api/adjustments/points', { userId: L(), delta: 500, note: 'Base' });
    await F.mama.post('/api/adjustments/points', { userId: F.ids.hugo, delta: 500, note: 'Base' });
    await F.luciaC.post('/api/bank/exchange', { points: 100 });
    await F.hugoC.post('/api/bank/exchange', { points: 100 });
    await F.mama.post('/api/screen/adjust', { userId: L(), delta: 60, note: 'regalo' });
    const reasons = (await F.mama.get('/api/screen/reasons')).body.reasons;
    await F.mama.post('/api/screen/adjustments', { userId: L(), reasonId: reasons[0].id, effect: 'minutes', minutes: 10 });

    const lucia = await feed(F.luciaC);
    expect(lucia.length).toBeGreaterThan(0);
    expect(lucia.every((e) => e.actor_name === 'Lucía')).toBe(true);
    expect(actions(lucia)).toContain('bank.exchange');
    expect(actions(lucia).some((a) => a.startsWith('screen_adjust'))).toBe(false);
    const hugo = await feed(F.hugoC);
    expect(hugo.every((e) => e.actor_name === 'Hugo')).toBe(true);
    expect(actions(hugo).some((a) => a.startsWith('screen_adjust'))).toBe(false);
    // Los adultos sí ven los ajustes.
    expect(actions(await feed(F.papaC))).toContain('screen_adjust.minutes');
  });
});
