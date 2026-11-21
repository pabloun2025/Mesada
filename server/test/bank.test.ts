import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one } from '../src/lib/db.js';
import { addDays, startOfWeek, todayIn } from '../src/lib/dates.js';
import { installmentCents, maxPointsForCents } from '../src/lib/bank.js';
import { capStatus, weeklyCapCents } from '../src/lib/cap.js';
import { getFamily } from '../src/lib/family.js';
import { runWeeklyBank, savingsInterestCents } from '../src/lib/savings.js';
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

const L = () => F.ids.lucia;
const today = () => todayIn('Europe/Madrid');
/** Un instante del lunes de `n` semanas después de esta (a mediodía, para evitar bordes de zona horaria). */
const monday = (n = 1) => new Date(`${addDays(startOfWeek(today()), 7 * n)}T12:00:00Z`);
const pts = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM points_ledger WHERE user_id=$1', [u]))!.b as number;
const cents = async (u: string) => (await one(pool(), `SELECT COALESCE(SUM(delta_cents),0)::int AS b FROM money_ledger WHERE user_id=$1 AND account='available'`, [u]))!.b as number;
const saved = async (u: string) => (await one(pool(), `SELECT COALESCE(SUM(delta_cents),0)::int AS b FROM money_ledger WHERE user_id=$1 AND account='savings'`, [u]))!.b as number;
const notes = (u: string, kind?: string) => many(pool(), `SELECT * FROM notifications WHERE user_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at, id`, [u, kind ?? null]);
const givePts = (u: string, n: number) => F.mama.post('/api/adjustments/points', { userId: u, delta: n, note: 'Base' });
const giveMoney = (u: string, c: number) => F.mama.post('/api/adjustments/money', { userId: u, deltaCents: c, note: 'Base' });
const setFamily = (b: Record<string, unknown>) => F.mama.patch('/api/family', b);
const setCap = (c: number | null) => setFamily({ capCents: c });
/** Mueve dinero negativo directamente en el libro (simula una deuda que ningún ajuste permitiría). */
const forceMoney = (u: string, c: number) =>
  pool().query(`INSERT INTO money_ledger(family_id, user_id, delta_cents, kind, note) VALUES ($1,$2,$3,'adjustment','Deuda de prueba')`, [F.ids.family, u, c]);
async function otherFamily() {
  const { config } = await import('../src/lib/config.js');
  config.allowRegistration = true;
  try {
    return await createFamily(app, 'g');
  } finally {
    config.allowRegistration = false;
  }
}
const goal = async (target = 5000, c = F.luciaC) => (await c.post('/api/goals', { userId: L(), title: 'Vinilo', targetCents: target })).body.goal as { id: string };

describe('funciones puras', () => {
  it('interés del ahorro: al euro de arriba y mínimo 1 €', () => {
    expect(savingsInterestCents(1000, 1)).toBe(100); // 10 € → 1 €
    expect(savingsInterestCents(15000, 1)).toBe(200); // 150 € → 1,50 → 2 €
    expect(savingsInterestCents(50, 1)).toBe(100); // 0,50 € → mínimo 1 €
    expect(savingsInterestCents(10000, 1)).toBe(100); // 100 € justos → 1 €
    expect(savingsInterestCents(10001, 1)).toBe(200);
    expect(savingsInterestCents(30000, 1.5)).toBe(500); // 4,5 → 5 €
    expect(savingsInterestCents(0, 1)).toBe(0);
  });
  it('cuotas: la última se lleva el resto', () => {
    expect([1, 2, 3].map((i) => installmentCents(1001, 3, i))).toEqual([333, 333, 335]);
    expect(installmentCents(500, 1, 1)).toBe(500);
  });
  it('tope semanal: el mensual se prorratea en un solo sitio', () => {
    expect(weeklyCapCents({ cap_cents: 1000, settlement_period: 'week' })).toBe(1000);
    expect(weeklyCapCents({ cap_cents: 5200, settlement_period: 'month' })).toBe(1200);
    expect(weeklyCapCents({ cap_cents: null, settlement_period: 'week' })).toBeNull();
  });
  it('máximo de puntos que caben en un importe', () => {
    const fam = { rate_points: 100, rate_cents: 500 };
    expect(maxPointsForCents(fam, 1000)).toBe(200);
    expect(maxPointsForCents(fam, 1004)).toBe(200);
    expect(maxPointsForCents(fam, 1005)).toBe(201);
  });
});

describe('I6 canje', () => {
  it('respeta mínimo y tope semanal, es idempotente y avisa a los adultos', async () => {
    await setCap(1000); // 10 € = 200 puntos
    await givePts(L(), 400);
    expect((await F.luciaC.post('/api/bank/exchange', { points: 49 })).status).toBe(400);
    const h = { 'idempotency-key': 'canje-0001-abc' };
    const a = await F.luciaC.post('/api/bank/exchange', { points: 100 }, h);
    expect(a.status).toBe(200);
    expect(await pts(L())).toBe(300);
    expect(await cents(L())).toBe(500);
    // Mismo intento: no cambia nada.
    expect((await F.luciaC.post('/api/bank/exchange', { points: 100 }, h)).body.duplicate).toBe(true);
    expect(await cents(L())).toBe(500);
    const n = (await notes(F.ids.mama, 'points_exchanged'))[0];
    expect(n.title).toBe('Lucía ha cambiado 100 puntos por 5,00 €');
    expect((await notes(F.ids.papa, 'points_exchanged'))).toHaveLength(1);
    // Hasta el tope y no más.
    expect((await F.luciaC.post('/api/bank/exchange', { points: 100 })).status).toBe(200);
    const over = await F.luciaC.post('/api/bank/exchange', { points: 50 });
    expect(over.status).toBe(409);
    expect(over.body.error).toBe('cap_reached');
    expect(await cents(L())).toBe(1000);
    // Sin puntos suficientes.
    expect((await F.luciaC.post('/api/bank/exchange', { points: 150 })).status).toBe(409);
    // Un adulto no canjea.
    expect((await F.mama.post('/api/bank/exchange', { points: 50 })).status).toBe(403);
  });

  it('sin tope no hay límite y con el canje apagado no se puede', async () => {
    await givePts(L(), 1000);
    expect((await F.luciaC.post('/api/bank/exchange', { points: 1000 })).status).toBe(200);
    expect(await cents(L())).toBe(5000);
    await givePts(L(), 100);
    await setFamily({ bankExchangeEnabled: false });
    const r = await F.luciaC.post('/api/bank/exchange', { points: 100 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('feature_disabled');
    // El mínimo es configurable.
    await setFamily({ bankExchangeEnabled: true, bankExchangeMinPoints: 80 });
    expect((await F.luciaC.post('/api/bank/exchange', { points: 79 })).status).toBe(400);
    expect((await F.luciaC.post('/api/bank/exchange', { points: 80 })).status).toBe(200);
  });

  it('el cierre de periodo solo convierte hasta lo que queda del tope', async () => {
    await setCap(1000);
    await givePts(L(), 400);
    await F.luciaC.post('/api/bank/exchange', { points: 100 }); // 5 € ya cambiados
    const r = await F.mama.post('/api/allowance/settle', { userId: L(), date: today() });
    expect(r.status).toBe(200);
    // Quedaban 300 puntos (15 €) pero solo caben 5 € más: 100 puntos.
    expect(r.body.results[0].settlement).toMatchObject({ points_converted: 100, cents: 500, capped: true });
    expect(await pts(L())).toBe(200);
    expect(await cents(L())).toBe(1000);
  });

  it('si el canje ya agotó el tope, el cierre no convierte nada y los puntos se quedan', async () => {
    await setCap(1000);
    await givePts(L(), 300);
    await F.luciaC.post('/api/bank/exchange', { points: 200 });
    const r = await F.mama.post('/api/allowance/settle', { userId: L(), date: today() });
    expect(r.body.results[0].settlement).toMatchObject({ points_converted: 0, cents: 0, capped: true });
    expect(await pts(L())).toBe(100);
  });
});

describe('I6 retiro', () => {
  it('como mucho 2 por semana (pendientes y aprobados), los rechazados no cuentan y el lunes vuelve a 0', async () => {
    await giveMoney(L(), 5000);
    const ask = (c = 500) => F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: c });
    const r1 = (await ask()).body.request;
    expect((await F.mama.post(`/api/payout-requests/${r1.id}/reject`, {})).status).toBe(200); // no cuenta
    const r2 = (await ask()).body.request;
    expect((await F.mama.post(`/api/payout-requests/${r2.id}/approve`, {})).status).toBe(200);
    const r3 = (await ask()).body.request;
    // Con una pendiente y otra aprobada ya son 2.
    await F.mama.post(`/api/payout-requests/${r3.id}/approve`, {});
    const r4 = await ask();
    expect(r4.status).toBe(409);
    expect(r4.body.error).toBe('withdraw_limit');
    // El contador vuelve a 0 con la semana nueva (simulamos que las anteriores son de la semana pasada).
    await pool().query(`UPDATE payout_requests SET created_at = created_at - interval '8 days'`);
    expect((await ask()).status).toBe(200);
    // El ajuste del número se respeta y apagar retirar lo impide.
    await setFamily({ bankWithdrawPerWeek: 1 });
    const bank = (await F.luciaC.get(`/api/bank/${L()}`)).body.bank;
    expect(bank.actions.withdraw.ok).toBe(false);
  });

  it('el aviso a los adultos dice que tienen que pagar', async () => {
    await giveMoney(L(), 1000);
    await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 400 });
    const n = (await notes(F.ids.papa, 'payout_requested'))[0];
    expect(n.title).toBe('Lucía quiere retirar 4,00 €');
    expect(n.body).toContain('Tienes que pagárselo');
  });

  it('con la cuenta en negativo no se puede retirar, aunque pida poco', async () => {
    await giveMoney(L(), 1000);
    await forceMoney(L(), -3000); // saldo −20 €
    const r = await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 100 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('negative_balance');
    await forceMoney(L(), 3000 + 500); // vuelve a positivo
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 100 })).status).toBe(200);
  });

  it('con retirar apagado no se puede', async () => {
    await giveMoney(L(), 1000);
    await setFamily({ bankWithdrawEnabled: false });
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 100 })).body.error).toBe('feature_disabled');
    // Pedir pantalla sigue igual.
    await F.mama.post('/api/screen/adjust', { userId: L(), delta: 30, note: 'x' });
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 10, category: 'tele' })).status).toBe(200);
  });
});

describe('I6 adelanto', () => {
  it('cambia puntos por encima del tope y reduce el tope de la semana siguiente', async () => {
    await setCap(1000);
    await givePts(L(), 1000);
    // Mientras pueda canjear, no hace falta adelantar.
    expect((await F.luciaC.post('/api/bank/advance', { cents: 500 })).body.error).toBe('advance_unavailable');
    await F.luciaC.post('/api/bank/exchange', { points: 200 }); // tope de la semana agotado (10 €)
    expect((await F.luciaC.post('/api/bank/advance', { cents: 501 })).body.error).toBe('advance_too_big'); // máximo 50 % de 10 €
    const h = { 'idempotency-key': 'adelanto-0001' };
    const ok = await F.luciaC.post('/api/bank/advance', { cents: 500 }, h);
    expect(ok.status).toBe(200);
    expect(await cents(L())).toBe(1500); // 10 € del canje + 5 € del adelanto
    expect(await pts(L())).toBe(1000 - 200 - 100);
    expect((await F.luciaC.post('/api/bank/advance', { cents: 500 }, h)).body.duplicate).toBe(true);
    expect(await cents(L())).toBe(1500);
    // Ya no cabe más adelanto.
    expect((await F.luciaC.post('/api/bank/advance', { cents: 100 })).status).toBe(409);
    // El tope de la semana que viene es 5 €.
    const fam = await getFamily(pool(), F.ids.family);
    const nextMonday = addDays(startOfWeek(today()), 7);
    const next = await capStatus(pool(), fam, L(), nextMonday);
    expect(next).toMatchObject({ weeklyCap: 1000, usedWeek: 500, remaining: 500 });
    expect((await notes(F.ids.mama, 'advance_taken'))[0].title).toBe('Lucía ha adelantado 5,00 €');
    // Y el cierre de ese periodo solo convertiría lo que quede de su tope.
    const bank = (await F.luciaC.get(`/api/bank/${L()}`)).body.bank;
    expect(bank.week.remaining_cents).toBe(0);
  });

  it('sin tope semanal no hay adelanto ni préstamo', async () => {
    await givePts(L(), 500);
    const a = await F.luciaC.post('/api/bank/advance', { cents: 100 });
    expect(a.status).toBe(409);
    expect(a.body.error).toBe('no_cap');
    const l = await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 });
    expect(l.status).toBe(409);
    expect(l.body.error).toBe('no_cap');
    const bank = (await F.luciaC.get(`/api/bank/${L()}`)).body.bank;
    expect(bank.actions.advance.reason).toBe('Pon un tope semanal en Ajustes');
    expect(bank.actions.loan.reason).toBe('Pon un tope semanal en Ajustes');
  });

  it('con el adelanto apagado, 409', async () => {
    await setCap(1000);
    await givePts(L(), 500);
    await setFamily({ bankAdvanceEnabled: false });
    expect((await F.luciaC.post('/api/bank/advance', { cents: 100 })).body.error).toBe('feature_disabled');
  });
});

describe('I6 préstamo', () => {
  it('el hijo pide, el adulto aprueba y el dinero entra; solo uno a la vez y con límites', async () => {
    await setCap(1000); // máximo 30 € y 12 semanas
    expect((await F.luciaC.post('/api/loans', { amountCents: 3001, weeks: 4 })).body.error).toBe('loan_too_big');
    expect((await F.luciaC.post('/api/loans', { amountCents: 1000, weeks: 13 })).body.error).toBe('too_many_weeks');
    const a = await F.luciaC.post('/api/loans', { amountCents: 2000, weeks: 4, note: 'Un juego' });
    expect(a.status).toBe(200);
    const loan = a.body.loan;
    expect((await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).body.error).toBe('loan_open');
    expect((await notes(F.ids.mama, 'loan_requested'))[0].title).toBe('Lucía pide un préstamo de 20,00 €');
    expect(await cents(L())).toBe(0); // hasta que lo aprueben no hay dinero
    // Permisos.
    expect((await F.luciaC.post(`/api/loans/${loan.id}/approve`, {})).status).toBe(403);
    expect((await F.hugoC.post(`/api/loans/${loan.id}/cancel`, {})).status).toBe(403);
    expect((await F.mama.post('/api/loans', { amountCents: 500, weeks: 2 })).status).toBe(403);
    const ok = await F.papaC.post(`/api/loans/${loan.id}/approve`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.loan).toMatchObject({ status: 'active', installments_paid: 0 });
    expect(await cents(L())).toBe(2000);
    const row = await one(pool(), `SELECT kind FROM money_ledger WHERE user_id = $1 AND kind = 'loan'`, [L()]);
    expect(row).toBeTruthy();
    // Aprobar otra vez no vuelve a pagar.
    expect((await F.mama.post(`/api/loans/${loan.id}/approve`, {})).body.duplicate).toBe(true);
    expect(await cents(L())).toBe(2000);
    expect((await F.mama.post(`/api/loans/${loan.id}/reject`, {})).status).toBe(409);
    // Tras aprobar sigue siendo uno solo.
    expect((await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).body.error).toBe('loan_open');
    // El hijo y los adultos ven las cuotas que quedan.
    const mine = (await F.luciaC.get('/api/loans')).body.loans[0];
    expect(mine).toMatchObject({ remaining_installments: 4, installment_cents: 500, remaining_cents: 2000 });
    expect(mine.next_charge_week).toBe(addDays(startOfWeek(today()), 7));
    expect((await F.hugoC.get('/api/loans')).body.loans).toHaveLength(0);
    expect((await notes(L(), 'loan_decided'))[0].title).toContain('ha aprobado tu préstamo de 20,00 €');
  });

  it('rechazar y cancelar no mueven dinero y liberan al hijo para pedir otro', async () => {
    await setCap(1000);
    const a = (await F.luciaC.post('/api/loans', { amountCents: 1000, weeks: 2 })).body.loan;
    expect((await F.mama.post(`/api/loans/${a.id}/reject`, { note: 'Todavía no' })).status).toBe(200);
    expect(await cents(L())).toBe(0);
    const b = (await F.luciaC.post('/api/loans', { amountCents: 1000, weeks: 2 })).body.loan;
    expect((await F.luciaC.post(`/api/loans/${b.id}/cancel`, {})).status).toBe(200);
    expect((await F.mama.post(`/api/loans/${b.id}/approve`, {})).status).toBe(409);
    expect((await F.luciaC.post('/api/loans', { amountCents: 1000, weeks: 2 })).status).toBe(200);
  });

  it('cada lunes se cobra la cuota y el interés, sin duplicar, con recuperación y último pago con el resto', async () => {
    await setCap(1000);
    await giveMoney(L(), 100); // para que el saldo no sea cero
    const loan = (await F.luciaC.post('/api/loans', { amountCents: 1001, weeks: 3 })).body.loan;
    await F.mama.post(`/api/loans/${loan.id}/approve`, {});
    const base = await cents(L()); // 1101
    // Antes del primer lunes no se cobra nada.
    await runWeeklyBank(pool(), F.ids.family, new Date());
    expect(await cents(L())).toBe(base);
    // Primer lunes: cuota 1 y 10 puntos de interés (puntos a −10: la deuda se paga con lo próximo).
    await runWeeklyBank(pool(), F.ids.family, monday(1));
    await runWeeklyBank(pool(), F.ids.family, monday(1)); // repetido: nada
    expect(await cents(L())).toBe(base - 333);
    expect(await pts(L())).toBe(-10);
    expect((await notes(L(), 'loan_charged'))).toHaveLength(1);
    // Se cae el servidor dos semanas: al volver se cobran las que faltan, ni más ni menos.
    await runWeeklyBank(pool(), F.ids.family, monday(5));
    expect(await cents(L())).toBe(base - 1001);
    expect(await pts(L())).toBe(-30);
    const l = (await F.luciaC.get('/api/loans?status=paid')).body.loans[0];
    expect(l).toMatchObject({ status: 'paid', installments_paid: 3, remaining_installments: 0 });
    const charges = await many(pool(), 'SELECT seq, cents FROM loan_charges ORDER BY seq');
    expect(charges.map((c) => c.cents)).toEqual([333, 333, 335]);
    await runWeeklyBank(pool(), F.ids.family, monday(9));
    expect((await many(pool(), 'SELECT 1 FROM loan_charges'))).toHaveLength(3);
    // Los puntos negativos se pagan solos con lo próximo que gane.
    await givePts(L(), 100);
    expect(await pts(L())).toBe(70);
    // Y puede volver a pedir otro préstamo.
    expect((await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 1 })).status).toBe(200);
  });

  it('si no le alcanza el saldo, el dinero queda en negativo y eso bloquea retiros y nuevos préstamos', async () => {
    await setCap(1000);
    const loan = (await F.luciaC.post('/api/loans', { amountCents: 1200, weeks: 4 })).body.loan;
    await F.mama.post(`/api/loans/${loan.id}/approve`, {});
    expect((await F.mama.post('/api/payments', { userId: L(), amountCents: 1200, method: 'cash' })).status).toBe(200); // se lo gasta
    await runWeeklyBank(pool(), F.ids.family, monday(1));
    expect(await cents(L())).toBe(-300);
    const bank = (await F.luciaC.get(`/api/bank/${L()}`)).body.bank;
    expect(bank.actions.withdraw).toMatchObject({ ok: false, reason: 'Tu cuenta está en negativo' });
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 100 })).body.error).toBe('negative_balance');
    await runWeeklyBank(pool(), F.ids.family, monday(4)); // se termina
    expect(await cents(L())).toBe(-1200);
    expect((await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).body.error).toBe('negative_balance');
    // Se desbloquea al volver a positivo.
    await giveMoney(L(), 1500);
    expect((await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).status).toBe(200);
  });

  it('con el préstamo apagado no se puede pedir ni aprobar', async () => {
    await setCap(1000);
    const loan = (await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).body.loan;
    await setFamily({ bankLoanEnabled: false });
    expect((await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).body.error).toBe('feature_disabled');
    expect((await F.mama.post(`/api/loans/${loan.id}/approve`, {})).body.error).toBe('feature_disabled');
  });

  it('otra familia no puede ver ni resolver los préstamos', async () => {
    await setCap(1000);
    const loan = (await F.luciaC.post('/api/loans', { amountCents: 500, weeks: 2 })).body.loan;
    const G = await otherFamily();
    expect((await G.mama.post(`/api/loans/${loan.id}/approve`, {})).status).toBe(404);
    expect((await G.mama.get('/api/loans')).body.loans).toHaveLength(0);
    expect((await G.mama.get(`/api/bank/${L()}`)).status).toBe(404);
    expect((await G.luciaC.post(`/api/loans/${loan.id}/cancel`, {})).status).toBe(404);
  });
});

describe('I7 ahorro programado', () => {
  it('el hijo mete dinero en una meta; solo en la suya y con saldo', async () => {
    await giveMoney(L(), 2000);
    const g = await goal(5000);
    expect((await F.hugoC.post(`/api/goals/${g.id}/deposit`, { cents: 100 })).status).toBe(403);
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 2001 })).body.error).toBe('insufficient_balance');
    const h = { 'idempotency-key': 'ahorro-0001' };
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1500 }, h)).status).toBe(200);
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1500 }, h)).body.duplicate).toBe(true);
    expect(await cents(L())).toBe(500);
    expect(await saved(L())).toBe(1500);
    const goals = (await F.luciaC.get(`/api/goals/${L()}`)).body.goals;
    expect(goals[0]).toMatchObject({ principal_cents: 1500, interest_cents: 0, balance_cents: 1500, reached: false });
    // No se puede quitar una meta con dinero.
    expect((await F.luciaC.del(`/api/goals/${g.id}`)).status).toBe(409);
  });

  it('interés del lunes: 10 € → 1 €, 150 € → 2 €, 0,50 € → 1 €; idempotente y sin interés sobre interés', async () => {
    const cases: [number, number][] = [[1000, 100], [15000, 200], [50, 100]];
    for (const [principal, expected] of cases) {
      await forceMoney(L(), principal);
      const g = await goal(100000);
      await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: principal });
      await runWeeklyBank(pool(), F.ids.family, monday(1));
      await runWeeklyBank(pool(), F.ids.family, monday(1)); // repetir no paga otra vez
      const got = (await F.luciaC.get(`/api/goals/${L()}`)).body.goals.find((x: any) => x.id === g.id);
      expect(got).toMatchObject({ principal_cents: principal, interest_cents: expected, balance_cents: principal + expected });
      await F.luciaC.post(`/api/goals/${g.id}/withdraw`); // limpia para el siguiente caso
    }
    // Segunda semana: el interés se calcula sobre el capital, no sobre lo ya ganado.
    await forceMoney(L(), 15000);
    const g = await goal(100000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 15000 });
    await runWeeklyBank(pool(), F.ids.family, monday(1));
    await runWeeklyBank(pool(), F.ids.family, monday(2));
    const got = (await F.luciaC.get(`/api/goals/${L()}`)).body.goals.find((x: any) => x.id === g.id);
    expect(got).toMatchObject({ principal_cents: 15000, interest_cents: 400, interest_earned_cents: 400 });
    expect((await notes(L(), 'savings_interest')).length).toBeGreaterThan(0);
    // Cuenta como dinero que deben los padres.
    expect((await F.luciaC.get(`/api/bank/${L()}`)).body.bank.savings_cents).toBe(15400);
  });

  it('un depósito de esta semana no gana interés hasta el lunes siguiente, y apagar el interés lo para', async () => {
    await giveMoney(L(), 1000);
    const g = await goal(5000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1000 });
    await runWeeklyBank(pool(), F.ids.family, new Date());
    expect(await saved(L())).toBe(1000);
    await setFamily({ bankSavingsEnabled: false });
    await runWeeklyBank(pool(), F.ids.family, monday(1));
    expect(await saved(L())).toBe(1000);
  });

  it('sigue ganando interés después de llegar a la meta', async () => {
    await giveMoney(L(), 2000);
    const g = await goal(2000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 2000 });
    await runWeeklyBank(pool(), F.ids.family, monday(1));
    await runWeeklyBank(pool(), F.ids.family, monday(2));
    const got = (await F.luciaC.get(`/api/goals/${L()}`)).body.goals[0];
    expect(got).toMatchObject({ reached: true, interest_cents: 200, balance_cents: 2200 });
  });

  it('sacarlo antes de la meta devuelve el capital y pierde el interés (queda anotado)', async () => {
    await giveMoney(L(), 1000);
    const g = await goal(5000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1000 });
    await runWeeklyBank(pool(), F.ids.family, monday(1));
    expect(await saved(L())).toBe(1100);
    expect((await F.hugoC.post(`/api/goals/${g.id}/withdraw`)).status).toBe(403);
    const r = await F.luciaC.post(`/api/goals/${g.id}/withdraw`);
    expect(r.body).toMatchObject({ principal_cents: 1000, forfeited_cents: 100 });
    expect(await cents(L())).toBe(1000);
    expect(await saved(L())).toBe(0);
    const forfeit = await one(pool(), `SELECT delta_cents FROM money_ledger WHERE user_id = $1 AND kind = 'interest_forfeit'`, [L()]);
    expect(forfeit!.delta_cents).toBe(-100);
    expect((await F.luciaC.post(`/api/goals/${g.id}/withdraw`)).status).toBe(409); // ya está vacía
  });

  it('con la meta alcanzada no se saca a efectivo: se canjea o se pide permiso', async () => {
    await giveMoney(L(), 1000);
    const g = await goal(1000);
    expect((await F.luciaC.post(`/api/goals/${g.id}/redeem`)).body.error).toBe('goal_not_reached'); // aún sin dinero
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1000 });
    expect((await F.luciaC.post(`/api/goals/${g.id}/withdraw`)).body.error).toBe('goal_reached');
    const r = await F.luciaC.post(`/api/goals/${g.id}/redeem`);
    expect(r.status).toBe(200);
    expect((await notes(F.ids.mama, 'goal_requested'))[0].title).toBe('Lucía quiere canjear su meta «Vinilo»');
    // Con la petición abierta no se mueve nada más.
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 100 })).body.error).toBe('goal_pending');
    expect((await F.luciaC.post(`/api/goals/${g.id}/redeem`)).status).toBe(409);
  });

  it('«Comprado» con sobrante: vuelve a la cuenta de dinero', async () => {
    await giveMoney(L(), 2000);
    const g = await goal(2000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 2000 });
    await runWeeklyBank(pool(), F.ids.family, monday(1)); // +1 € de interés: 21 € ahorrados
    const req = (await F.luciaC.post(`/api/goals/${g.id}/redeem`)).body.request;
    expect((await F.luciaC.post(`/api/goal-requests/${req.id}/approve`, { priceCents: 1800 })).status).toBe(403);
    expect((await F.mama.post(`/api/goal-requests/${req.id}/approve`, {})).status).toBe(400); // falta el precio
    const ok = await F.mama.post(`/api/goal-requests/${req.id}/approve`, { priceCents: 1800 });
    expect(ok.body).toMatchObject({ settle_cents: 300, request: { status: 'approved', price_cents: 1800 } });
    expect(await cents(L())).toBe(300);
    expect(await saved(L())).toBe(0);
    expect((await F.mama.post(`/api/goal-requests/${req.id}/approve`, { priceCents: 1800 })).body.duplicate).toBe(true);
    expect(await cents(L())).toBe(300);
    const done = (await F.luciaC.get(`/api/goals/${L()}`)).body.goals[0];
    expect(done).toMatchObject({ status: 'bought', price_cents: 1800, balance_cents: 0 });
    // Ya no gana interés.
    await runWeeklyBank(pool(), F.ids.family, monday(2));
    expect(await saved(L())).toBe(0);
    expect((await notes(L(), 'goal_decided'))[0].body).toContain('Sobraron 3,00 €');
  });

  it('«Comprado» con falta: se descuenta y la cuenta puede quedar en negativo', async () => {
    await giveMoney(L(), 1000);
    const g = await goal(1000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1000 });
    const req = (await F.luciaC.post(`/api/goals/${g.id}/redeem`)).body.request;
    const ok = await F.papaC.post(`/api/goal-requests/${req.id}/approve`, { priceCents: 1400 });
    expect(ok.body.settle_cents).toBe(-400);
    expect(await cents(L())).toBe(-400);
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'money', amountCents: 100 })).body.error).toBe('negative_balance');
  });

  it('pasar a efectivo exige permiso de un adulto y pierde el interés', async () => {
    await giveMoney(L(), 1000);
    const g = await goal(1000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1000 });
    await runWeeklyBank(pool(), F.ids.family, monday(1));
    const req = (await F.luciaC.post(`/api/goals/${g.id}/cashout`)).body.request;
    expect(await cents(L())).toBe(0); // hasta que lo aprueben, nada
    expect((await F.luciaC.post(`/api/goal-requests/${req.id}/approve`)).status).toBe(403);
    const ok = await F.mama.post(`/api/goal-requests/${req.id}/approve`);
    expect(ok.body.request).toMatchObject({ status: 'approved', settle_cents: 1000, forfeited_cents: 100 });
    expect(await cents(L())).toBe(1000);
    expect(await saved(L())).toBe(0);
    expect((await F.luciaC.get(`/api/goals/${L()}`)).body.goals[0].status).toBe('cashed_out');
    expect((await F.mama.post(`/api/goal-requests/${req.id}/approve`)).body.duplicate).toBe(true);
    expect(await cents(L())).toBe(1000);
  });

  it('rechazar o cancelar deja la meta como estaba; otra familia no puede decidir', async () => {
    await giveMoney(L(), 1000);
    const g = await goal(1000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1000 });
    const r1 = (await F.luciaC.post(`/api/goals/${g.id}/cashout`)).body.request;
    const G = await otherFamily();
    expect((await G.mama.post(`/api/goal-requests/${r1.id}/reject`)).status).toBe(404);
    expect((await F.mama.post(`/api/goal-requests/${r1.id}/reject`, { note: 'Espera' })).status).toBe(200);
    expect(await saved(L())).toBe(1000);
    const r2 = (await F.luciaC.post(`/api/goals/${g.id}/redeem`)).body.request;
    expect((await F.hugoC.post(`/api/goal-requests/${r2.id}/cancel`)).status).toBe(403);
    expect((await F.luciaC.post(`/api/goal-requests/${r2.id}/cancel`)).status).toBe(200);
    expect((await F.mama.get('/api/goal-requests?status=pending')).body.requests).toHaveLength(0);
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 1 })).body.error).toBe('insufficient_balance');
  });

  it('la hucha de antes pasa a la primera meta al migrar', async () => {
    await giveMoney(L(), 1000);
    await F.luciaC.post('/api/savings/transfer', { userId: L(), cents: 700, direction: 'to_savings' }); // sin meta (hucha antigua)
    const g = await goal(5000);
    const { migrate } = await import('../src/lib/db.js');
    await pool().query(`DELETE FROM schema_migrations WHERE name = '007_bank.sql'`);
    await migrate(pool()); // idempotente
    const row = (await F.luciaC.get(`/api/goals/${L()}`)).body.goals.find((x: any) => x.id === g.id);
    expect(row.balance_cents).toBe(700);
  });
});

describe('cuenta y extracto', () => {
  it('número de cuenta fijo, extracto con saldo tras cada movimiento y permisos', async () => {
    await givePts(L(), 120);
    await giveMoney(L(), 700);
    await F.mama.post('/api/payments', { userId: L(), amountCents: 200, method: 'cash' });
    const a = (await F.luciaC.get(`/api/bank/${L()}`)).body.bank;
    const b = (await F.mama.get(`/api/bank/${L()}`)).body.bank;
    expect(a.accounts).toEqual(b.accounts);
    expect(a.accounts.money).toMatch(/^ES00 DIPL \d{4} \d{4}$/);
    expect(a.accounts.money).not.toBe(a.accounts.points);
    expect(a.accounts.money).not.toBe((await F.mama.get(`/api/bank/${F.ids.hugo}`)).body.bank.accounts.money);
    expect(a).toMatchObject({ money_cents: 500, points: 120 });
    const st = (await F.luciaC.get(`/api/statement/${L()}?account=money`)).body.entries;
    expect(st.map((e: any) => [e.amount, e.balance_after])).toEqual([[-200, 500], [700, 700]]);
    const sp = (await F.luciaC.get(`/api/statement/${L()}?account=points`)).body.entries;
    expect(sp[0]).toMatchObject({ amount: 120, balance_after: 120 });
    expect((await F.hugoC.get(`/api/bank/${L()}`)).status).toBe(403);
    expect((await F.hugoC.get(`/api/statement/${L()}`)).status).toBe(403);
    expect((await F.mama.get(`/api/bank/${F.ids.mama}`)).status).toBe(404); // un adulto no tiene cuenta
  });

  it('los botones explican por qué no están disponibles', async () => {
    const bank = (await F.luciaC.get(`/api/bank/${L()}`)).body.bank;
    expect(bank.actions.exchange).toMatchObject({ ok: false, reason: 'Necesitas al menos 50 puntos' });
    expect(bank.actions.withdraw).toMatchObject({ ok: false, reason: 'No tienes dinero que retirar' });
    expect(bank.actions.save).toMatchObject({ ok: false, reason: 'Crea primero una meta' });
    await setCap(1000);
    await givePts(L(), 100);
    const b2 = (await F.luciaC.get(`/api/bank/${L()}`)).body.bank;
    expect(b2.actions.exchange).toMatchObject({ ok: true, min_points: 50, max_points: 100 });
    expect(b2.actions.loan).toMatchObject({ ok: true, max_cents: 3000, max_weeks: 12 });
  });

  it('solo un adulto cambia los ajustes del banco y los valores se validan', async () => {
    expect((await F.luciaC.patch('/api/family', { bankLoanEnabled: false })).status).toBe(403);
    expect((await setFamily({ bankLoanMaxWeeks: 0 })).status).toBe(400);
    expect((await setFamily({ bankSavingsRatePercent: 2.5, bankLoanInterestPoints: 5 })).body.family).toMatchObject({ bank_savings_rate_percent: 2.5, bank_loan_interest_points: 5 });
  });
});
