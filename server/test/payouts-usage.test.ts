import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one } from '../src/lib/db.js';
import { todayIn } from '../src/lib/dates.js';
import { HONESTY_POINTS } from '../src/lib/screen-usage.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const pool = () => getPool();

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

const pts = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM points_ledger WHERE user_id=$1', [u]))!.b as number;
const cents = async (u: string) => (await one(pool(), `SELECT COALESCE(SUM(delta_cents),0)::int AS b FROM money_ledger WHERE user_id=$1 AND account='available'`, [u]))!.b as number;
const screen = async (u: string) => (await F.mama.get(`/api/screen/${u}`)).body.balance as number;
const notes = (u: string, kind?: string) => many(pool(), `SELECT * FROM notifications WHERE user_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at, id`, [u, kind ?? null]);
const giveMoney = (u: string, c: number) => F.mama.post('/api/adjustments/money', { userId: u, deltaCents: c, note: 'Base' });
const giveScreen = (u: string, m: number) => F.mama.post('/api/screen/adjust', { userId: u, delta: m, note: 'Base' });
const L = () => F.ids.lucia;
/** Segunda familia: el registro está cerrado por defecto, se abre solo mientras se crea. */
async function otherFamily() {
  const { config } = await import('../src/lib/config.js');
  config.allowRegistration = true;
  try {
    return await createFamily(app, 'g');
  } finally {
    config.allowRegistration = false;
  }
}

describe('I4 pagos desde el Panel', () => {
  it('el aviso de pago dice quién, cuánto, cómo y cuánto queda', async () => {
    await giveMoney(L(), 7000);
    const cases: [string, string][] = [['cash', 'en efectivo'], ['transfer', 'por transferencia'], ['bizum', 'por Bizum']];
    let left = 7000;
    for (const [method, phrase] of cases) {
      const r = await F.mama.post('/api/payments', { userId: L(), amountCents: 2000, method });
      expect(r.status).toBe(200);
      left -= 2000;
      const n = (await notes(L(), 'payment')).at(-1)!;
      expect(n.title).toContain(`Mamá te ha pagado 20,00 € ${phrase}.`);
      expect(n.body).toBe(`Te quedan ${(left / 100).toFixed(2).replace('.', ',')} €.`);
    }
    // «Otro»: sin forma de pago; la nota del adulto se añade al cuerpo.
    const r = await F.papaC.post('/api/payments', { userId: L(), amountCents: 1000, method: 'other', note: 'Para el cine' });
    expect(r.status).toBe(200);
    const n = (await notes(L(), 'payment')).at(-1)!;
    expect(n.title).toContain('Papá te ha pagado 10,00 €.');
    expect(n.body).toBe('Te quedan 0,00 €. Para el cine');
    expect(await cents(L())).toBe(0);
  });

  it('pagar con la misma clave no duplica ni el pago ni el aviso', async () => {
    await giveMoney(L(), 2000);
    const h = { 'idempotency-key': 'panel-pago-0001' };
    const a = await F.mama.post('/api/payments', { userId: L(), amountCents: 1500, method: 'bizum' }, h);
    const b = await F.mama.post('/api/payments', { userId: L(), amountCents: 1500, method: 'bizum' }, h);
    expect(a.body.payment.duplicate).toBe(false);
    expect(b.body.payment.duplicate).toBe(true);
    expect(await cents(L())).toBe(500);
    expect(await notes(L(), 'payment')).toHaveLength(1);
    expect((await F.mama.post('/api/payments', { userId: L(), amountCents: 9999, method: 'cash' })).status).toBe(409);
    expect((await F.luciaC.post('/api/payments', { userId: L(), amountCents: 1, method: 'cash' })).status).toBe(403);
  });

  it('gastar pantalla guarda la categoría, la valida y avisa al hijo', async () => {
    await giveScreen(L(), 45);
    expect((await F.mama.post('/api/screen/spend', { userId: L(), minutes: 10, category: 'playstation' })).status).toBe(400);
    const r = await F.mama.post('/api/screen/spend', { userId: L(), minutes: 30, category: 'videojuegos' });
    expect(r.body).toMatchObject({ applied: 30, balance: 15 });
    const n = (await notes(L(), 'screen_changed')).at(-1)!;
    expect(n.title).toContain('Mamá te ha dado 30 min de videojuegos.');
    expect(n.body).toBe('Te quedan 15 min.');
    // Sin categoría: «otro». Los movimientos antiguos y los bonos llevan NULL.
    await F.mama.post('/api/screen/spend', { userId: L(), minutes: 5 });
    const entries = (await F.luciaC.get(`/api/screen/${L()}`)).body.entries;
    expect(entries.find((e: any) => e.delta === -30).category).toBe('videojuegos');
    expect(entries.find((e: any) => e.delta === -5).category).toBe('otro');
    expect(entries.find((e: any) => e.kind === 'adjustment').category).toBeNull();
    await expect(pool().query(`INSERT INTO screen_ledger(family_id,user_id,delta,kind,category) VALUES ($1,$2,1,'bonus','nintendo')`, [F.ids.family, L()])).rejects.toThrow();
  });
});

describe('I4 peticiones del hijo', () => {
  it('no se puede pedir más que el saldo y solo hay una abierta por tipo', async () => {
    await giveMoney(L(), 1000);
    await giveScreen(L(), 30);
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 1001 })).status).toBe(409);
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 0 })).status).toBe(400);
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 31, category: 'tele' })).status).toBe(409);
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 10 })).status).toBe(400); // falta la categoría
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 10, category: 'nope' })).status).toBe(400);
    const a = await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 400, note: 'Para un helado' });
    expect(a.status).toBe(200);
    const dup = await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 300 });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('already_pending');
    // Otro tipo sí; otro hijo también.
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 20, category: 'videojuegos' })).status).toBe(200);
    await giveMoney(F.ids.hugo, 500);
    expect((await F.hugoC.post('/api/payout-requests', { kind: 'money', amountCents: 500 })).status).toBe(200);
    // Un adulto no pide.
    expect((await F.mama.post('/api/payout-requests', { kind: 'money', amountCents: 100 })).status).toBe(403);
    // Los adultos reciben el aviso (WhatsApp por defecto); cada hijo ve solo lo suyo.
    for (const adult of [F.ids.mama, F.ids.papa]) expect(await notes(adult, 'payout_requested')).toHaveLength(3);
    const ob = await many(pool(), `SELECT channel FROM notification_outbox WHERE event = 'payout_requested'`);
    expect(Array.isArray(ob)).toBe(true);
    expect((await F.luciaC.get('/api/payout-requests')).body.requests).toHaveLength(2);
    expect((await F.mama.get('/api/payout-requests?status=pending')).body.requests).toHaveLength(3);
  });

  it('aprobar dinero crea el pago en la misma operación y descuenta el saldo', async () => {
    await giveMoney(L(), 1500);
    const req = (await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 1000 })).body.request;
    expect((await F.luciaC.post(`/api/payout-requests/${req.id}/approve`, {})).status).toBe(403);
    const r = await F.papaC.post(`/api/payout-requests/${req.id}/approve`, { method: 'bizum', note: 'Con cariño' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ reduced: false, granted: 1000, request: { status: 'approved', granted_cents: 1000, method: 'bizum' } });
    expect(await cents(L())).toBe(500);
    const pay = await one(pool(), 'SELECT * FROM payments WHERE user_id = $1', [L()]);
    expect(pay).toMatchObject({ amount_cents: 1000, method: 'bizum', paid_by: F.ids.papa });
    expect(r.body.request.payment_id).toBe(pay!.id);
    const n = await notes(L(), 'payout_decided');
    expect(n).toHaveLength(1);
    expect(n[0].title).toContain('Papá te ha pagado 10,00 € por Bizum.');
    expect(n[0].body).toBe('Te quedan 5,00 €. Con cariño');
    expect(await notes(L(), 'payment')).toHaveLength(0); // un solo aviso, el de la petición
    // Idempotente: aprobar otra vez no paga otra vez.
    const again = await F.mama.post(`/api/payout-requests/${req.id}/approve`, {});
    expect(again.body.duplicate).toBe(true);
    expect(await cents(L())).toBe(500);
    expect((await F.mama.post(`/api/payout-requests/${req.id}/reject`, {})).status).toBe(409);
    // Y el hijo puede volver a pedir.
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 500 })).status).toBe(200);
  });

  it('si el saldo bajó, se aprueba lo que haya; si es cero, 409 y sigue abierta', async () => {
    await giveMoney(L(), 1000);
    const req = (await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 1000 })).body.request;
    await F.mama.post('/api/payments', { userId: L(), amountCents: 600, method: 'cash' });
    const r = await F.mama.post(`/api/payout-requests/${req.id}/approve`, {});
    expect(r.body).toMatchObject({ reduced: true, granted: 400 });
    expect(await cents(L())).toBe(0);
    const n = (await notes(L(), 'payout_decided'))[0];
    expect(n.body).toContain('Pediste 10,00 €');
    expect(n.body).toContain('Te quedan 0,00 €.');

    await giveMoney(L(), 300);
    const req2 = (await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 300 })).body.request;
    await F.mama.post('/api/payments', { userId: L(), amountCents: 300, method: 'cash' });
    const z = await F.mama.post(`/api/payout-requests/${req2.id}/approve`, {});
    expect(z.status).toBe(409);
    expect(z.body.error).toBe('insufficient_balance');
    expect((await F.mama.post(`/api/payout-requests/${req2.id}/reject`, { note: 'No queda nada' })).status).toBe(200);
  });

  it('aprobar pantalla gasta los minutos con su categoría, también recortados', async () => {
    await giveScreen(L(), 50);
    const req = (await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 30, category: 'videojuegos' })).body.request;
    const r = await F.mama.post(`/api/payout-requests/${req.id}/approve`, {});
    expect(r.body).toMatchObject({ reduced: false, granted: 30 });
    expect(await screen(L())).toBe(20);
    const e = (await F.luciaC.get(`/api/screen/${L()}`)).body.entries.find((x: any) => x.delta === -30);
    expect(e).toMatchObject({ kind: 'spend', category: 'videojuegos' });
    const n = (await notes(L(), 'payout_decided'))[0];
    expect(n.title).toContain('Mamá te ha dado 30 min de videojuegos.');
    expect(n.body).toBe('Te quedan 20 min.');
    expect((await F.mama.post(`/api/payout-requests/${req.id}/approve`, {})).body.duplicate).toBe(true);
    expect(await screen(L())).toBe(20);

    const req2 = (await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 20, category: 'tele' })).body.request;
    await F.mama.post('/api/screen/spend', { userId: L(), minutes: 12 });
    const r2 = await F.mama.post(`/api/payout-requests/${req2.id}/approve`, {});
    expect(r2.body).toMatchObject({ reduced: true, granted: 8 });
    expect(await screen(L())).toBe(0);
    const req3 = (await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 1, category: 'tele' }));
    expect(req3.status).toBe(409); // ya no queda saldo para pedir
  });

  it('rechazar y cancelar; permisos y familias ajenas', async () => {
    await giveMoney(L(), 1000);
    await giveScreen(L(), 30);
    const m = (await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 500 })).body.request;
    const s = (await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 10, category: 'tablet' })).body.request;
    // Otro hijo no puede cancelar la petición de Lucía; un adulto tampoco por la vía del hijo.
    expect((await F.hugoC.post(`/api/payout-requests/${m.id}/cancel`, {})).status).toBe(403);
    // Otra familia ni la ve ni la decide.
    const G = await otherFamily();
    expect((await G.mama.post(`/api/payout-requests/${m.id}/approve`, {})).status).toBe(404);
    expect((await G.mama.post(`/api/payout-requests/${m.id}/reject`, {})).status).toBe(404);
    expect((await G.luciaC.post(`/api/payout-requests/${m.id}/cancel`, {})).status).toBe(404);
    expect((await G.mama.get('/api/payout-requests')).body.requests).toHaveLength(0);
    // Rechazo con nota.
    const rej = await F.mama.post(`/api/payout-requests/${m.id}/reject`, { note: 'Mejor el sábado' });
    expect(rej.body.request).toMatchObject({ status: 'rejected', decision_note: 'Mejor el sábado' });
    expect(await cents(L())).toBe(1000);
    const n = (await notes(L(), 'payout_decided'))[0];
    expect(n.title).toContain('Mamá no ha aceptado tu petición de 5,00 €');
    expect(n.body).toBe('Mejor el sábado');
    // Cancelar la propia; idempotente; ya no se puede aprobar.
    expect((await F.luciaC.post(`/api/payout-requests/${s.id}/cancel`, {})).body.request.status).toBe('cancelled');
    expect((await F.luciaC.post(`/api/payout-requests/${s.id}/cancel`, {})).body.duplicate).toBe(true);
    expect((await F.mama.post(`/api/payout-requests/${s.id}/approve`, {})).status).toBe(409);
    expect(await screen(L())).toBe(30);
    expect((await F.luciaC.post(`/api/payout-requests/${m.id}/cancel`, {})).status).toBe(409); // ya rechazada
    // Tras cancelar o rechazar, puede pedir de nuevo.
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 200 })).status).toBe(200);
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 10, category: 'tablet' })).status).toBe(200);
    // El Panel cuenta las peticiones abiertas.
    expect((await F.mama.get('/api/dashboard')).body.pendingRequests).toBe(2);
  });

  it('la petición lleva la misma clave de idempotencia sin duplicarse', async () => {
    await giveMoney(L(), 1000);
    const h = { 'idempotency-key': 'pedir-dinero-01' };
    const a = await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 300 }, h);
    const b = await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 300 }, h);
    expect(a.body.request.id).toBe(b.body.request.id);
    expect(b.body.duplicate).toBe(true);
    expect(await notes(F.ids.mama, 'payout_requested')).toHaveLength(1);
  });
});

describe('I5 el hijo anota su pantalla', () => {
  const log = (c: any, minutes: number, category = 'videojuegos', h?: Record<string, string>) => c.post('/api/screen-logs', { minutes, category }, h);
  const today = () => todayIn('Europe/Madrid');

  it('resta al momento y guarda minutos pedidos, aplicados y exceso', async () => {
    await giveScreen(L(), 60);
    const r = await log(F.luciaC, 25, 'tele');
    expect(r.status).toBe(200);
    expect(r.body.log).toMatchObject({ minutes: 25, applied_minutes: 25, overflow_minutes: 0, status: 'pending', category: 'tele', day: today() });
    expect(await screen(L())).toBe(35);
    const e = (await F.luciaC.get(`/api/screen/${L()}`)).body.entries.find((x: any) => x.kind === 'usage');
    expect(e).toMatchObject({ delta: -25, category: 'tele', log_status: 'pending' });
    expect(await pts(L())).toBe(0); // aún sin puntos: faltan la confirmación
    expect((await log(F.luciaC, 0)).status).toBe(400);
    expect((await log(F.luciaC, 721)).status).toBe(400);
    expect((await log(F.luciaC, 5, 'nope')).status).toBe(400);
    expect((await log(F.mama, 5)).status).toBe(403);
  });

  it('la misma clave no resta dos veces', async () => {
    await giveScreen(L(), 60);
    const h = { 'idempotency-key': 'anotar-0000001' };
    const a = await log(F.luciaC, 20, 'tele', h);
    const b = await log(F.luciaC, 20, 'tele', h);
    expect(b.body.duplicate).toBe(true);
    expect(b.body.log.id).toBe(a.body.log.id);
    expect(await screen(L())).toBe(40);
  });

  it('los 5 puntos llegan al confirmar y solo una vez al día', async () => {
    await giveScreen(L(), 120);
    const a = (await log(F.luciaC, 20)).body.log;
    const b = (await log(F.luciaC, 30, 'tablet')).body.log;
    const c1 = await F.mama.post(`/api/screen-logs/${a.id}/confirm`, {});
    expect(c1.body).toMatchObject({ duplicate: false, honesty: true });
    expect(await pts(L())).toBe(HONESTY_POINTS);
    expect((await notes(L(), 'points_adjusted')).at(-1)!.title).toContain('+5 puntos por ser honesto');
    // Confirmar la segunda del mismo día no suma más; repetir la confirmación tampoco.
    await F.papaC.post(`/api/screen-logs/${b.id}/confirm`, {});
    expect((await F.mama.post(`/api/screen-logs/${a.id}/confirm`, {})).body.duplicate).toBe(true);
    expect(await pts(L())).toBe(HONESTY_POINTS);
    // Otro día, otro premio.
    const prev = '2020-01-02';
    const old = (await log(F.luciaC, 10)).body.log;
    await pool().query('UPDATE screen_usage_logs SET day = $2 WHERE id = $1', [old.id, prev]);
    await F.mama.post(`/api/screen-logs/${old.id}/confirm`, {});
    expect(await pts(L())).toBe(HONESTY_POINTS * 2);
    // Permisos.
    expect((await F.luciaC.post(`/api/screen-logs/${a.id}/confirm`, {})).status).toBe(403);
    expect((await F.luciaC.post(`/api/screen-logs/${a.id}/void`, {})).status).toBe(403);
    const G = await otherFamily();
    expect((await G.mama.post(`/api/screen-logs/${a.id}/confirm`, {})).status).toBe(404);
    expect((await G.mama.post(`/api/screen-logs/${a.id}/void`, {})).status).toBe(404);
  });

  it('el exceso deja el saldo en 0, no da puntos ese día y avisa a los adultos', async () => {
    await giveScreen(L(), 10);
    const ok = (await log(F.luciaC, 4)).body.log; // dentro del saldo
    const over = (await log(F.luciaC, 30, 'ordenador')).body.log; // tenía 6
    expect(over).toMatchObject({ minutes: 30, applied_minutes: 6, overflow_minutes: 24 });
    expect(await screen(L())).toBe(0);
    for (const adult of [F.ids.mama, F.ids.papa]) {
      const n = await notes(adult, 'screen_overuse');
      expect(n).toHaveLength(1);
      expect(n[0].body).toContain('24 min');
    }
    // Aunque la otra anotación del día estuviera bien, no hay puntos.
    await F.mama.post(`/api/screen-logs/${ok.id}/confirm`, {});
    await F.mama.post(`/api/screen-logs/${over.id}/confirm`, {});
    expect(await pts(L())).toBe(0);
    // Si el adulto anula la que se pasó, el día vuelve a ser honesto.
    const v = await F.mama.post(`/api/screen-logs/${over.id}/void`, {});
    expect(v.body.refunded).toBe(6); // solo lo realmente restado
    expect(await screen(L())).toBe(6);
    expect(await pts(L())).toBe(HONESTY_POINTS);
  });

  it('un exceso posterior retira los puntos ya concedidos del día', async () => {
    await giveScreen(L(), 20);
    const a = (await log(F.luciaC, 10)).body.log;
    await F.mama.post(`/api/screen-logs/${a.id}/confirm`, {});
    expect(await pts(L())).toBe(HONESTY_POINTS);
    const over = (await log(F.luciaC, 50)).body.log;
    expect(over.overflow_minutes).toBe(40);
    expect(await pts(L())).toBe(0);
    const kinds = await many(pool(), `SELECT kind, delta FROM points_ledger WHERE user_id = $1 ORDER BY created_at, id`, [L()]);
    expect(kinds.map((k: any) => `${k.kind}:${k.delta}`)).toEqual(['bonus:5', 'adjustment:-5']);
    // Anular el exceso devuelve el premio (clave nueva, sin chocar con la primera).
    await F.mama.post(`/api/screen-logs/${over.id}/void`, {});
    expect(await pts(L())).toBe(HONESTY_POINTS);
  });

  it('anular devuelve exactamente lo restado y revierte los puntos si no queda otra confirmada', async () => {
    await giveScreen(L(), 100);
    const a = (await log(F.luciaC, 20)).body.log;
    const b = (await log(F.luciaC, 30, 'tele')).body.log;
    await F.mama.post(`/api/screen-logs/${a.id}/confirm`, {});
    await F.mama.post(`/api/screen-logs/${b.id}/confirm`, {});
    expect(await pts(L())).toBe(HONESTY_POINTS);
    // Anular una: queda otra confirmada, los puntos se mantienen.
    const v1 = await F.mama.post(`/api/screen-logs/${a.id}/void`, {});
    expect(v1.body).toMatchObject({ refunded: 20, log: { status: 'voided' } });
    expect(await screen(L())).toBe(70);
    expect(await pts(L())).toBe(HONESTY_POINTS);
    // Idempotente: no devuelve dos veces.
    expect((await F.mama.post(`/api/screen-logs/${a.id}/void`, {})).body.duplicate).toBe(true);
    expect(await screen(L())).toBe(70);
    // No se puede confirmar una anulada.
    const c = await F.mama.post(`/api/screen-logs/${a.id}/confirm`, {});
    expect(c.status).toBe(409);
    // Anular la última confirmada: puntos revertidos con un ajuste compensatorio.
    await F.mama.post(`/api/screen-logs/${b.id}/void`, {});
    expect(await screen(L())).toBe(100);
    expect(await pts(L())).toBe(0);
    const k = await many(pool(), `SELECT kind, delta FROM points_ledger WHERE user_id = $1 ORDER BY created_at, id`, [L()]);
    expect(k.map((x: any) => `${x.kind}:${x.delta}`)).toEqual(['bonus:5', 'adjustment:-5']);
    expect((await notes(L(), 'points_adjusted')).some((n: any) => n.title.includes('−5 puntos'))).toBe(true);
    // Una anotación pendiente anulada no toca puntos.
    const p = (await log(F.luciaC, 10)).body.log;
    await F.mama.post(`/api/screen-logs/${p.id}/void`, {});
    expect(await pts(L())).toBe(0);
    expect(await screen(L())).toBe(100);
  });

  it('el hijo ve sus anotaciones con estado; el Panel cuenta las pendientes', async () => {
    await giveScreen(L(), 50);
    await giveScreen(F.ids.hugo, 50);
    const a = (await log(F.luciaC, 10)).body.log;
    await log(F.hugoC, 15);
    expect((await F.mama.get('/api/dashboard')).body.pendingUsage).toBe(2);
    await F.mama.post(`/api/screen-logs/${a.id}/confirm`, {});
    const mine = (await F.luciaC.get('/api/screen-logs')).body.logs;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'confirmed', display_name: 'Lucía' });
    expect((await F.mama.get('/api/screen-logs?status=pending')).body.logs).toHaveLength(1);
    expect((await F.luciaC.get(`/api/screen/${F.ids.hugo}`)).status).toBe(403);
  });
});
