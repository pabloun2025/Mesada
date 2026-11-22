import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one, tx } from '../src/lib/db.js';
import { addDays, diffDays, isoWeekday, startOfWeek, todayIn } from '../src/lib/dates.js';
import { addScreen, earnedExpiryDay, planExpiryDay, runScreenExpiry, runScreenPlans, screenBalance } from '../src/lib/screen.js';
import { applyAdjustment } from '../src/lib/screen-adjust.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const TZ = 'Europe/Madrid';
const today = () => todayIn(TZ);
const pool = () => getPool();
const daysFromNow = (n: number) => new Date(Date.now() + n * 86400000);

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

const adult = () => ({ id: F.ids.mama, familyId: F.ids.family, role: 'adult' as const, displayName: 'Mamá', username: 'fmama' });
const lots = async (u: string) => many(pool(), `SELECT source, amount, remaining, expires_at FROM screen_lots WHERE user_id = $1 ORDER BY expires_at, created_at`, [u]);
const lotSum = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(remaining),0)::int AS s FROM screen_lots WHERE user_id = $1', [u]))!.s as number;
const give = (u: string, delta: number, now?: Date, kind: 'bonus' | 'adjustment' = 'bonus') =>
  tx((db) => addScreen(db, { familyId: F.ids.family, userId: u, delta, kind, note: 'test', now }));
const spend = (u: string, minutes: number, now?: Date) => tx((db) => addScreen(db, { familyId: F.ids.family, userId: u, delta: -minutes, kind: 'spend', note: 'test', now }));
const setPlan = (u: string, minutesPerWeek: number, enabled = true) => F.mama.put(`/api/screen/plans/${u}`, { minutesPerWeek, enabled });
const midnightMadrid = (d: Date) => d.toLocaleString('sv-SE', { timeZone: TZ });
/** Comprueba la invariante: la suma de los lotes es el saldo del libro. */
const expectConsistent = async (u: string) => expect(await lotSum(u)).toBe(await screenBalance(pool(), u));

describe('Caducidad (I16)', () => {
  it('lo ganado caduca el primer lunes a partir de 30 días, a las 00:00 (entre 30 y 36 días)', () => {
    for (let i = 0; i < 14; i++) {
      const day = addDays('2025-12-01', i); // dos semanas completas, todos los días de la semana
      const exp = earnedExpiryDay(day);
      expect(isoWeekday(exp), day).toBe(1);
      const n = diffDays(exp, day);
      expect(n).toBeGreaterThanOrEqual(30);
      expect(n).toBeLessThanOrEqual(36);
    }
    expect(earnedExpiryDay('2025-12-01')).toBe('2026-01-05'); // lunes + 30 = miércoles → el lunes siguiente
    expect(earnedExpiryDay('2025-12-05')).toBe('2026-01-05'); // viernes + 30 = domingo 4 → lunes 5
    expect(earnedExpiryDay('2025-12-06')).toBe('2026-01-05'); // sábado + 30 = lunes 5: «a partir de» incluye ese lunes (30 días justos)
    expect(earnedExpiryDay('2025-12-07')).toBe('2026-01-12'); // domingo + 30 = martes 6 → lunes 12 (36 días)
  });

  it('el plan caduca el lunes siguiente; un lote ganado se crea con su caducidad a las 00:00 locales', async () => {
    expect(planExpiryDay('2025-12-01')).toBe('2025-12-08');
    await give(F.ids.lucia, 30, daysFromNow(0));
    const [l] = await lots(F.ids.lucia);
    expect(l).toMatchObject({ source: 'earned', amount: 30, remaining: 30 });
    expect(midnightMadrid(l.expires_at).endsWith('00:00:00')).toBe(true);
    expect(isoWeekday(midnightMadrid(l.expires_at).slice(0, 10))).toBe(1);
  });

  it('al vencer escribe «Caducado» en el libro y el saldo sigue cuadrando; no caduca antes', async () => {
    await give(F.ids.lucia, 30, daysFromNow(0));
    expect(await runScreenExpiry(pool(), F.ids.family, daysFromNow(29))).toBe(0);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(30);
    expect(await runScreenExpiry(pool(), F.ids.family, daysFromNow(40))).toBe(30);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(0);
    const led = await many(pool(), `SELECT delta, kind, note FROM screen_ledger WHERE user_id = $1 AND kind = 'expiry'`, [F.ids.lucia]);
    expect(led).toEqual([{ delta: -30, kind: 'expiry', note: 'Caducado · minutos ganados' }]);
    await expectConsistent(F.ids.lucia);
    // Repetir no duplica.
    expect(await runScreenExpiry(pool(), F.ids.family, daysFromNow(41))).toBe(0);
  });

  it('gastar no puede usar minutos vencidos aunque la tarea periódica aún no haya pasado', async () => {
    await give(F.ids.lucia, 20, daysFromNow(0));
    const r = await spend(F.ids.lucia, 10, daysFromNow(60));
    expect(r.applied).toBe(0);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(0);
  });

  it('saldos anteriores a los lotes: la diferencia pasa a un lote ganado al gastar', async () => {
    await pool().query(`INSERT INTO screen_ledger(family_id,user_id,delta,kind) VALUES ($1,$2,50,'bonus')`, [F.ids.family, F.ids.lucia]);
    expect(await lotSum(F.ids.lucia)).toBe(0);
    await spend(F.ids.lucia, 20);
    expect(await lots(F.ids.lucia)).toMatchObject([{ source: 'earned', amount: 50, remaining: 30 }]);
    await expectConsistent(F.ids.lucia);
  });
});

describe('Plan semanal (I16)', () => {
  it('se carga una vez por hijo y semana (idempotente), con caducidad el lunes siguiente', async () => {
    expect((await setPlan(F.ids.lucia, 300)).status).toBe(200); // activarlo a mitad de semana carga ya esa semana
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(300);
    expect(await runScreenPlans(pool(), F.ids.family)).toBe(0);
    expect(await runScreenPlans(pool(), F.ids.family)).toBe(0);
    expect((await setPlan(F.ids.lucia, 500)).status).toBe(200); // cambiar la cantidad no vuelve a cargar esa semana
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(300);
    await setPlan(F.ids.lucia, 300);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(300);
    const [l] = await lots(F.ids.lucia);
    expect(l.source).toBe('plan');
    const nextMonday = addDays(startOfWeek(today()), 7);
    expect(midnightMadrid(l.expires_at)).toBe(`${nextMonday} 00:00:00`);
    // Hugo no tiene plan.
    expect(await screenBalance(pool(), F.ids.hugo)).toBe(0);
  });

  it('el lunes siguiente caduca lo que sobra y entra el plan nuevo', async () => {
    await setPlan(F.ids.lucia, 120);
    await spend(F.ids.lucia, 20);
    const monday = new Date(`${addDays(startOfWeek(today()), 7)}T12:00:00Z`); // ya pasada la 00:00 del lunes
    await runScreenExpiry(pool(), F.ids.family, monday);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(0); // los 100 min que sobraban se pierden
    expect(await runScreenPlans(pool(), F.ids.family, monday)).toBe(1);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(120);
    const kinds = (await many(pool(), `SELECT kind FROM screen_ledger WHERE user_id = $1`, [F.ids.lucia])).map((r) => r.kind).sort();
    expect(kinds).toEqual(['expiry', 'plan', 'plan', 'spend']);
    await expectConsistent(F.ids.lucia);
  });

  it('se puede apagar por hijo y solo lo editan los adultos', async () => {
    await setPlan(F.ids.lucia, 300, false);
    expect(await runScreenPlans(pool(), F.ids.family)).toBe(0);
    expect((await F.luciaC.put(`/api/screen/plans/${F.ids.lucia}`, { minutesPerWeek: 999, enabled: true })).status).toBe(403);
    expect((await F.luciaC.get('/api/screen/plans')).status).toBe(403);
    const list = (await F.mama.get('/api/screen/plans')).body.plans;
    expect(list.find((p: any) => p.user_id === F.ids.lucia)).toMatchObject({ minutes_per_week: 300, enabled: false });
  });
});

describe('Gastar primero lo que caduca antes (I16)', () => {
  it('el plan de la semana se gasta antes que los ganados, y los ganados antiguos antes que los nuevos', async () => {
    await give(F.ids.lucia, 40, daysFromNow(-20)); // ganado hace 20 días: caduca antes que uno de hoy
    await give(F.ids.lucia, 60, daysFromNow(0));
    await setPlan(F.ids.lucia, 100);
    await runScreenPlans(pool(), F.ids.family);
    await spend(F.ids.lucia, 120); // 100 del plan + 20 del ganado más antiguo
    const l = await lots(F.ids.lucia);
    const by = (src: string, amount: number) => l.find((x) => x.source === src && x.amount === amount)!;
    expect(by('plan', 100).remaining).toBe(0);
    expect(by('earned', 40).remaining).toBe(20);
    expect(by('earned', 60).remaining).toBe(60);
    await expectConsistent(F.ids.lucia);
  });

  it('GET /api/screen/:id desglosa el saldo y un hermano no puede verlo', async () => {
    await give(F.ids.lucia, 45);
    await setPlan(F.ids.lucia, 130);
    await runScreenPlans(pool(), F.ids.family);
    const r = (await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body;
    expect(r.balance).toBe(175);
    expect(r.buckets.plan.minutes).toBe(130);
    expect(r.buckets.earned.minutes).toBe(45);
    expect(r.buckets.earned.first_expires_at).toBeTruthy();
    expect((await F.hugoC.get(`/api/screen/${F.ids.lucia}`)).status).toBe(403);
  });
});

describe('Ajustes de pantalla (I16)', () => {
  const reasons = async () => (await F.mama.get('/api/screen/reasons')).body.reasons as any[];

  it('trae motivos de partida en positivo y se pueden crear, editar y archivar', async () => {
    const r = await reasons();
    expect(r.map((x) => x.title)).toEqual(['Llegar a tiempo al cole', 'Habitación en orden', 'Esfuerzo en los estudios', 'Respeto en familia']);
    expect(r[3]).toMatchObject({ effect: 'pause', pause_days: 1 });
    const c = (await F.mama.post('/api/screen/reasons', { title: 'Deberes antes de jugar', effect: 'minutes', minutes: 20 })).body.reason;
    expect((await F.mama.put(`/api/screen/reasons/${c.id}`, { title: 'Deberes primero', effect: 'minutes', minutes: 25 })).body.reason).toMatchObject({ title: 'Deberes primero', minutes: 25 });
    expect((await F.mama.del(`/api/screen/reasons/${c.id}`)).status).toBe(200);
    expect((await reasons()).some((x) => x.id === c.id)).toBe(false);
    expect((await F.luciaC.post('/api/screen/reasons', { title: 'x', effect: 'minutes', minutes: 5 })).status).toBe(403);
  });

  it('minutos: se descuentan de los lotes que caducan antes y nunca bajan de 0', async () => {
    await give(F.ids.lucia, 40, daysFromNow(-20));
    await give(F.ids.lucia, 10, daysFromNow(0));
    const [cole] = await reasons();
    const r = await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: cole.id, effect: 'minutes', minutes: 45, note: 'Mañana lo conseguimos' });
    expect(r.body).toMatchObject({ effect: 'minutes', applied: 45, balance: 5 });
    const l = await lots(F.ids.lucia);
    expect(l.map((x) => x.remaining)).toEqual([0, 5]);
    // Más de lo que hay: se queda en 0 (no queda negativo) y anota solo lo aplicado.
    const r2 = await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: cole.id, effect: 'minutes', minutes: 30 });
    expect(r2.body).toMatchObject({ applied: 5, balance: 0 });
    // Sin saldo no hay nada que ajustar.
    expect((await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: cole.id, effect: 'minutes', minutes: 30 })).status).toBe(409);
    await expectConsistent(F.ids.lucia);
    // El hijo lo ve en su historial con el motivo y la nota amable; el hermano no.
    const h = (await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body.entries.find((e: any) => e.is_adjustment && e.delta === -45);
    expect(h).toMatchObject({ reason: 'Llegar a tiempo al cole', adjustment_note: 'Mañana lo conseguimos' });
    expect((await F.hugoC.get(`/api/screen/${F.ids.lucia}`)).status).toBe(403);
  });

  it('solo los adultos aplican ajustes', async () => {
    const [cole] = await reasons();
    expect((await F.luciaC.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: cole.id, effect: 'minutes', minutes: 5 })).status).toBe(403);
  });

  it('las pérdidas de I3 e I15 salen en el mismo historial como «Ajuste de pantalla» con su motivo', async () => {
    await give(F.ids.lucia, 100);
    const t = await F.mama.post('/api/tasks', { title: 'Estar en el coche a la hora de salida', points: 0, recurrence: 'daily', startDate: today(), checkMode: true, penaltyMinutes: 15, assignees: [F.ids.lucia] });
    const inst = (await F.mama.get(`/api/instances?userId=${F.ids.lucia}`)).body.instances.find((i: any) => i.task_id === t.body.task.id);
    await F.mama.post(`/api/instances/${inst.id}/check`, { met: false });
    const e = (await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body.entries.find((x: any) => x.kind === 'penalty');
    expect(e).toMatchObject({ is_adjustment: true, delta: -15, reason: 'Estar en el coche a la hora de salida' });
  });

  it('pausa: bloquea gastar y pedir, alarga la caducidad, se sigue ganando y un adulto puede terminarla antes', async () => {
    await give(F.ids.lucia, 60, daysFromNow(0));
    await setPlan(F.ids.lucia, 100);
    await runScreenPlans(pool(), F.ids.family);
    const before = await lots(F.ids.lucia);
    const [, , , respeto] = await reasons();
    const r = await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: respeto.id, effect: 'pause', pauseDays: 3, note: 'Lo hablamos' });
    expect(r.body).toMatchObject({ effect: 'pause', days: 3, until: addDays(today(), 3) });
    // Gastar (adulto) y pedir (hijo) quedan bloqueados.
    expect((await F.mama.post('/api/screen/spend', { userId: F.ids.lucia, minutes: 10, category: 'tele' })).body.error).toBe('paused');
    expect((await F.luciaC.post('/api/payout-requests', { kind: 'screen', minutes: 10, category: 'tele' })).body.error).toBe('paused');
    const view = (await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body;
    expect(view.pause.label).toMatch(/^Pausa hasta /);
    expect(view.balance).toBe(160);
    // La caducidad se alarga 3 días de calendario (a la misma hora local).
    const after = await lots(F.ids.lucia);
    for (let i = 0; i < before.length; i++) {
      const b = midnightMadrid(before[i].expires_at).slice(0, 10);
      const a = midnightMadrid(after[i].expires_at);
      expect(a).toBe(`${addDays(b, 3)} 00:00:00`);
    }
    // El plan de la semana habría caducado el lunes; con la pausa no caduca en ese momento.
    const mondayNoon = new Date(`${addDays(startOfWeek(today()), 7)}T12:00:00Z`);
    expect(await runScreenExpiry(pool(), F.ids.family, mondayNoon)).toBe(0);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(160);
    // Sigue ganando minutos durante la pausa.
    await give(F.ids.lucia, 15);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(175);
    // Otra pausa a la vez, no.
    expect((await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: respeto.id, effect: 'pause', pauseDays: 1 })).status).toBe(409);
    // Un adulto la termina antes: se devuelve a los lotes lo que no se usó y se puede gastar.
    expect((await F.mama.post(`/api/screen/adjustments/${r.body.id}/end`)).body.ended).toBe(true);
    const back = await lots(F.ids.lucia);
    for (let i = 0; i < before.length; i++) expect(midnightMadrid(back[i].expires_at).slice(0, 10)).toBe(midnightMadrid(before[i].expires_at).slice(0, 10));
    expect((await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body.pause).toBeNull();
    expect((await F.mama.post('/api/screen/spend', { userId: F.ids.lucia, minutes: 10, category: 'tele' })).status).toBe(200);
    await expectConsistent(F.ids.lucia);
  });
});

describe('Forma de recuperar (I16)', () => {
  async function extra() {
    const e = await F.mama.post('/api/extras', { title: 'Limpiar el garaje', points: 10, requiresApproval: true });
    expect(e.status, JSON.stringify(e.body)).toBe(200);
    return e.body.id as string;
  }
  const firstReason = async () => ((await F.mama.get('/api/screen/reasons')).body.reasons as any[])[0];

  it('minutos: al aprobarse el trabajo vuelven como minutos ganados con caducidad nueva', async () => {
    await give(F.ids.lucia, 50, daysFromNow(-20));
    const extraId = await extra();
    const adj = await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: (await firstReason()).id, effect: 'minutes', minutes: 30, recoveryTaskId: extraId });
    expect(adj.body.applied).toBe(30);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(20);
    // El trabajo ya está reservado para ella; Hugo no puede pedírselo.
    const board = (await F.luciaC.get('/api/extras')).body.board;
    const inst = board.find((b: any) => b.task_id === extraId);
    expect(inst).toMatchObject({ assignee_id: F.ids.lucia, mine: true });
    expect((await F.hugoC.post(`/api/extra-instances/${inst.id}/claim`)).status).toBe(409);
    expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`)).status).toBe(200);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(20); // aún sin validar
    expect((await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true })).status).toBe(200);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(50);
    const l = await lots(F.ids.lucia);
    const refund = l.find((x) => x.source === 'refund')!;
    expect(refund).toMatchObject({ amount: 30, remaining: 30 });
    expect(new Date(refund.expires_at).getTime()).toBeGreaterThan(Date.now() + 29 * 86400000);
    const h = (await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body.entries.find((e: any) => e.kind === 'refund');
    expect(h.note).toMatch(/Recuperado/);
    await expectConsistent(F.ids.lucia);
    // Una segunda vez no devuelve nada más.
    await F.mama.post(`/api/extras/${extraId}/activate`, {});
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(50);
  });

  it('pausa: al aprobarse el trabajo termina la pausa', async () => {
    await give(F.ids.lucia, 20);
    const extraId = await extra();
    const respeto = ((await F.mama.get('/api/screen/reasons')).body.reasons as any[])[3];
    await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: respeto.id, effect: 'pause', pauseDays: 5, recoveryTaskId: extraId });
    expect((await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body.pause).not.toBeNull();
    const inst = (await F.luciaC.get('/api/extras')).body.board.find((b: any) => b.task_id === extraId);
    await F.luciaC.post(`/api/instances/${inst.id}/complete`);
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true });
    expect((await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body.pause).toBeNull();
    expect(await one(pool(), `SELECT status FROM screen_adjustments WHERE user_id = $1`, [F.ids.lucia])).toMatchObject({ status: 'recovered' });
  });

  it('no deja elegir un trabajo extra que tiene otro hijo', async () => {
    await give(F.ids.lucia, 50);
    const extraId = await extra();
    const act = await F.mama.post(`/api/extras/${extraId}/activate`, {});
    await F.hugoC.post(`/api/extra-instances/${act.body.id}/claim`);
    const r = await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: (await firstReason()).id, effect: 'minutes', minutes: 10, recoveryTaskId: extraId });
    expect(r.status).toBe(409);
    expect(await screenBalance(pool(), F.ids.lucia)).toBe(50); // nada se aplicó
  });
});

describe('applyAdjustment directo', () => {
  it('con una pausa caducada se puede poner otra', async () => {
    const [, , , respeto] = (await F.mama.get('/api/screen/reasons')).body.reasons as any[];
    const a = await applyAdjustment(adult(), { userId: F.ids.lucia, reasonId: respeto.id, effect: 'pause', pauseDays: 1 });
    await pool().query(`UPDATE screen_adjustments SET pause_ends_on = pause_starts_on WHERE id = $1`, [a.id]); // ya pasó
    await expect(applyAdjustment(adult(), { userId: F.ids.lucia, reasonId: respeto.id, effect: 'pause', pauseDays: 2 })).resolves.toMatchObject({ effect: 'pause', days: 2 });
  });
});
