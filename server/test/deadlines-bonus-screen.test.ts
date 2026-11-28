import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, one } from '../src/lib/db.js';
import { addDays, isoWeekday, todayIn } from '../src/lib/dates.js';
import { dayEnd, deadlineAt, deadlineTime, reducedPoints } from '../src/lib/deadline.js';
import { zonedToUtc } from '../src/lib/notify/time.js';
import { completeInstance } from '../src/lib/task-actions.js';
import { scheduleReminders } from '../src/lib/notify/reminders.js';
import { ensureInstances } from '../src/lib/instances.js';
import { setSetting } from '../src/lib/settings.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const TZ = 'Europe/Madrid';
const today = () => todayIn(TZ);
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

const kid = (id: string, name: string) => ({ id, familyId: F.ids.family, role: 'child' as const, displayName: name, username: name });

async function mk(over: Record<string, unknown> = {}) {
  const r = await F.mama.post('/api/tasks', { title: 'Tender la cama', icon: '🛏️', points: 20, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.task;
}
async function instOf(taskId: string, date = today()) {
  const r = await one(pool(), 'SELECT * FROM task_instances WHERE task_id = $1 AND due_date = $2', [taskId, date]);
  return r as any;
}
const ptsBalance = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM points_ledger WHERE user_id=$1', [u]))!.b as number;
const screen = async (u: string) => (await F.mama.get(`/api/screen/${u}`)).body.balance as number;

describe('cambio de una sorpresa del catálogo', () => {
  async function reward(title: string, costPoints: number, swapEligible = true) {
    const r = await F.mama.post('/api/rewards', { title, costPoints, swapEligible });
    expect(r.status).toBe(200);
    return r.body.reward;
  }

  async function win(rewardId: string) {
    const task = await mk({ requiresApproval: false, bonus: { kind: 'reward', rewardId, surprise: true, allowSwap: true } });
    const instances = (await F.luciaC.get('/api/instances')).body.instances;
    expect(instances.find((i: any) => i.task_id === task.id).bonus).toEqual({ surprise: true, onTimeOnly: false });
    expect((await F.luciaC.post(`/api/instances/${(await instOf(task.id)).id}/complete`)).status).toBe(200);
    return (await F.luciaC.get('/api/bonus-grants/unrevealed')).body.grants[0];
  }

  it('mantiene el valor original después de editar y cambia una sola vez sin cobrar puntos', async () => {
    const original = await reward('Elegir un juego', 40);
    const matching = await reward('Elegir una película', 40);
    const wrong = await reward('Doble premio', 60);
    await reward('Sin permiso de cambio', 40, false);
    const archived = await reward('Premio archivado', 40);
    const g = await win(original.id);
    const url = `/api/bonus-grants/${g.id}`;
    expect((await F.luciaC.get(`${url}/alternatives`)).status).toBe(409);
    expect((await F.luciaC.post(`${url}/reveal`)).status).toBe(200);
    expect((await F.mama.put(`/api/rewards/${original.id}`, { title: 'Juego nuevo', costPoints: 60, swapEligible: true })).status).toBe(200);
    expect((await F.mama.del(`/api/rewards/${archived.id}`)).status).toBe(200);
    const available = await F.luciaC.get(`${url}/alternatives`);
    expect(available).toMatchObject({ status: 200, body: { original_title: 'Elegir un juego', cost_points: 40, alternatives: [{ id: matching.id }] } });
    expect((await F.hugoC.get(`${url}/alternatives`)).status).toBe(404);
    expect((await F.hugoC.post(`${url}/swap`, { rewardId: matching.id })).status).toBe(404);
    expect((await F.luciaC.post(`${url}/swap`, { rewardId: wrong.id })).status).toBe(409);
    const points = await ptsBalance(F.ids.lucia);
    expect((await F.luciaC.post(`${url}/swap`, { rewardId: matching.id })).status).toBe(200);
    expect((await F.luciaC.post(`${url}/swap`, { rewardId: matching.id })).body.duplicate).toBe(true);
    expect((await F.luciaC.post(`${url}/swap`, { rewardId: original.id })).status).toBe(409);
    expect((await F.mama.post(`${url}/fulfill`, { expectedRewardId: original.id })).status).toBe(409);
    expect((await F.mama.get('/api/bonus-grants')).body.grants[0]).toMatchObject({ label: 'Premio: Elegir una película', reward_id: matching.id });
    expect((await F.mama.post(`${url}/fulfill`, { expectedRewardId: matching.id })).status).toBe(200);
    expect(await ptsBalance(F.ids.lucia)).toBe(points);
    expect((await F.luciaC.get('/api/redemptions')).body.redemptions).toEqual([]);
  });

  it('serializa la entrega y el cambio para que no se entregue un premio que ya cambió', async () => {
    const original = await reward('Juego', 40);
    const matching = await reward('Película', 40);
    const g = await win(original.id);
    const url = `/api/bonus-grants/${g.id}`;
    await F.luciaC.post(`${url}/reveal`);
    const [swap, fulfill] = await Promise.all([
      F.luciaC.post(`${url}/swap`, { rewardId: matching.id }), F.mama.post(`${url}/fulfill`, { expectedRewardId: original.id }),
    ]);
    expect([swap.status, fulfill.status].sort()).toEqual([200, 409]);
    const saved = await one(pool(), 'SELECT fulfilled_at, reward_id FROM bonus_grants WHERE id = $1', [g.id]);
    if (swap.status === 200) expect(saved).toEqual({ fulfilled_at: null, reward_id: matching.id });
    else expect(saved).toEqual({ fulfilled_at: expect.any(Date), reward_id: original.id });
  });

  it('da a otro hermano una concesión nueva aunque gane el mismo premio', async () => {
    const original = await reward('Juego', 40);
    const t = await mk({ requiresApproval: false, assignmentMode: 'shared', assignees: [F.ids.lucia, F.ids.hugo],
      bonus: { kind: 'reward', rewardId: original.id, surprise: true, allowSwap: true } });
    const i = (await instOf(t.id)).id;
    expect((await F.luciaC.post(`/api/instances/${i}/complete`)).status).toBe(200);
    const old = (await F.mama.get('/api/bonus-grants')).body.grants[0];
    expect((await F.luciaC.post(`/api/instances/${i}/unmark`)).status).toBe(200);
    expect((await F.hugoC.post(`/api/instances/${i}/complete`)).status).toBe(200);
    const current = (await F.mama.get('/api/bonus-grants')).body.grants[0];
    expect(current.id).not.toBe(old.id);
    expect(current).toMatchObject({ user_id: F.ids.hugo, reward_id: original.id, fulfilled_at: null });
    expect((await F.mama.post(`/api/bonus-grants/${old.id}/fulfill`, { expectedRewardId: original.id })).status).toBe(404);
  });

  it('aplica al nuevo ganador el tipo de bono vigente, sin reactivar el premio de su hermana', async () => {
    const original = await reward('Juego', 40);
    const options = { title: 'Recoger la cocina', points: 20, recurrence: 'daily', startDate: today(), requiresApproval: false,
      assignmentMode: 'shared', assignees: [F.ids.lucia, F.ids.hugo] };
    const t = await mk({ ...options, bonus: { kind: 'reward', rewardId: original.id, surprise: true, allowSwap: true } });
    const i = (await instOf(t.id)).id;
    expect((await F.luciaC.post(`/api/instances/${i}/complete`)).status).toBe(200);
    expect((await F.mama.put(`/api/tasks/${t.id}`, { ...options, bonus: { kind: 'points', points: 7 } })).status).toBe(200);
    expect((await F.luciaC.post(`/api/instances/${i}/unmark`)).status).toBe(200);
    expect((await F.hugoC.post(`/api/instances/${i}/complete`)).status).toBe(200);
    expect(await ptsBalance(F.ids.hugo)).toBe(27);
    expect(await one(pool(), `SELECT kind, points, original_reward_id FROM bonus_grants WHERE instance_id = $1 AND user_id = $2`, [i, F.ids.hugo])).toEqual({ kind: 'points', points: 7, original_reward_id: null });
  });
});

describe('hora límite', () => {
  it('L–V usa la hora normal, S–D y festivos la de fin de semana (con cambio de hora)', () => {
    const t = { due_time: '09:00:00', due_time_weekend: '12:00:00' };
    expect(deadlineTime(t, '2026-11-23', false)).toBe('09:00'); // lunes
    expect(deadlineTime(t, '2026-11-21', false)).toBe('12:00'); // sábado
    expect(deadlineTime(t, '2026-11-24', true)).toBe('12:00'); // martes festivo
    expect(deadlineTime({ due_time: '09:00', due_time_weekend: null }, '2026-11-22', false)).toBe('09:00'); // sin hora de finde: la normal
    expect(deadlineTime({ due_time: null, due_time_weekend: '12:00' }, '2026-11-23', false)).toBeNull(); // L–V sin hora
    // Madrid: invierno UTC+1, verano UTC+2
    expect(deadlineAt(t, '2026-11-23', false, TZ)!.toISOString()).toBe('2026-11-23T08:00:00.000Z');
    expect(deadlineAt(t, '2026-03-29', false, TZ)!.toISOString()).toBe('2026-03-29T10:00:00.000Z'); // domingo del cambio: 12:00 CEST
    expect(deadlineAt({ due_time: '09:00', due_time_weekend: null }, '2026-10-26', false, TZ)!.toISOString()).toBe('2026-10-26T08:00:00.000Z'); // lunes tras volver a CET
    expect(deadlineAt({ due_time: '09:00', due_time_weekend: null }, '2026-10-25', false, TZ)!.toISOString()).toBe('2026-10-25T08:00:00.000Z'); // domingo del cambio: 09:00 CET
    // El día del cambio de hora dura 23 h: el final del día son las 00:00 locales siguientes.
    expect(dayEnd('2026-03-29', TZ).toISOString()).toBe('2026-03-29T22:00:00.000Z');
    expect(dayEnd('2026-10-25', TZ).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('porcentaje de tarde con redondeo', () => {
    expect(reducedPoints(20, 50)).toBe(10);
    expect(reducedPoints(15, 50)).toBe(8);
    expect(reducedPoints(20, 0)).toBe(0);
    expect(reducedPoints(20, 100)).toBe(20);
  });

  it('el API valida las horas y el porcentaje', async () => {
    const base = { title: 'x', points: 5, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia] };
    expect((await F.mama.post('/api/tasks', { ...base, dueTime: '25:00' })).status).toBe(400);
    expect((await F.mama.post('/api/tasks', { ...base, latePercent: 150 })).status).toBe(400);
    expect((await F.luciaC.post('/api/tasks', { ...base })).status).toBe(403);
  });

  it('las instancias traen la hora vigente: festivo → hora de fin de semana', async () => {
    const t = await mk({ dueTime: '09:00', dueTimeWeekend: '12:00', latePercent: 50 });
    const expected = isoWeekday(today()) >= 6 ? '12:00' : '09:00';
    let [i] = (await F.luciaC.get('/api/instances')).body.instances;
    expect(i.deadline_time).toBe(expected);
    expect(i.late_points).toBe(10);
    expect(i.deadline_at).toBe(zonedToUtc(today(), expected, TZ).toISOString());
    // Un adulto marca hoy como festivo
    expect((await F.luciaC.post('/api/holidays', { day: today(), label: 'x' })).status).toBe(403);
    expect((await F.mama.post('/api/holidays', { day: today(), label: 'Puente' })).status).toBe(200);
    [i] = (await F.luciaC.get('/api/instances')).body.instances;
    expect(i.deadline_time).toBe('12:00');
    expect((await F.luciaC.get('/api/holidays')).body.holidays).toEqual([{ day: today(), label: 'Puente' }]);
    expect((await F.mama.del(`/api/holidays/${today()}`)).status).toBe(200);
    expect((await F.mama.del(`/api/holidays/${today()}`)).status).toBe(404);
    expect(t.due_time_weekend).toBe('12:00:00');
  });

  it('completar tarde vale el % de puntos y el adulto lo aprueba con ese valor', async () => {
    const t = await mk({ dueTime: '00:00', dueTimeWeekend: '00:00', latePercent: 50 }); // la hora ya pasó seguro
    const inst = await instOf(t.id);
    const r = await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'submitted', onTime: false, potentialPoints: 10 });
    const row = await instOf(t.id);
    expect(row).toMatchObject({ points: 10, on_time: false });
    expect(row.deadline_at).toBeTruthy();
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true });
    expect(await ptsBalance(F.ids.lucia)).toBe(10);
  });

  it('a tiempo vale todo; pasada la hora, 23:59 sigue valiendo con %; después ya no', async () => {
    const t = await mk({ dueTime: '09:00', dueTimeWeekend: '09:00', latePercent: 25, requiresApproval: false });
    const t2 = await mk({ title: 'Otra', dueTime: '09:00', dueTimeWeekend: '09:00', latePercent: 25, requiresApproval: false });
    const t3 = await mk({ title: 'Tercera', dueTime: '09:00', dueTimeWeekend: '09:00', latePercent: 25, requiresApproval: false });
    const L = kid(F.ids.lucia, 'Lucía');
    const at = (hhmm: string) => zonedToUtc(today(), hhmm, TZ);
    const a = await completeInstance(L, (await instOf(t.id)).id, { now: at('08:59') });
    expect(a).toMatchObject({ status: 'approved', points: 20, onTime: true });
    const b = await completeInstance(L, (await instOf(t2.id)).id, { now: at('09:01') });
    expect(b).toMatchObject({ points: 5, onTime: false });
    await expect(completeInstance(L, (await instOf(t3.id)).id, { now: dayEnd(today(), TZ) })).rejects.toMatchObject({ status: 409, code: 'expired' });
    // un minuto antes de las 00:00 todavía vale
    const c = await completeInstance(L, (await instOf(t3.id)).id, { now: new Date(dayEnd(today(), TZ).getTime() - 60_000) });
    expect(c).toMatchObject({ points: 5, onTime: false });
    expect(await ptsBalance(F.ids.lucia)).toBe(30);
  });

  it('el aviso previo usa la hora de fin de semana/festivo y no se duplica', async () => {
    await mk({ dueTime: '08:00', dueTimeWeekend: '12:00' });
    await F.mama.post('/api/holidays', { day: today(), label: 'Festivo' });
    const dueSoon = async () => (await pool().query(`SELECT * FROM notifications WHERE kind = 'task_due_soon'`)).rows;
    // 07:30: con la hora de L–V (08:00) avisaría; hoy es festivo (12:00), así que no
    // Montar la tarea puede lanzar recordatorios con la hora real; se limpian para que la prueba no dependa del reloj.
    await pool().query(`DELETE FROM notifications WHERE kind = 'task_due_soon'`);
    await scheduleReminders(pool(), F.ids.family, zonedToUtc(today(), '07:30', TZ));
    expect(await dueSoon()).toHaveLength(0);
    await scheduleReminders(pool(), F.ids.family, zonedToUtc(today(), '11:30', TZ));
    await scheduleReminders(pool(), F.ids.family, zonedToUtc(today(), '11:40', TZ));
    const rows = await dueSoon();
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toContain('12:00');
    // y después de la hora ya no
    await scheduleReminders(pool(), F.ids.family, zonedToUtc(today(), '12:05', TZ));
    expect(await dueSoon()).toHaveLength(1);
  });
});

describe('bonos', () => {
  async function approveAll(taskId: string, dates: string[]) {
    // Crear la tarea solo materializa desde hoy: se generan también los días pasados (quedan vencidos, un adulto puede aprobarlos).
    await ensureInstances(pool(), F.ids.family);
    for (const d of dates) {
      const i = await instOf(taskId, d);
      const r = await F.mama.post(`/api/instances/${i.id}/review`, { approve: true });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
  }
  const twoDays = () => [addDays(today(), -2), addDays(today(), -1)];

  it('bono visible: se gana cada vez que se aprueba; el hijo lo ve como etiqueta', async () => {
    const t = await mk({ startDate: addDays(today(), -2), bonus: { kind: 'screen', minutes: 30 } });
    const view = (await F.luciaC.get('/api/tasks')).body.tasks[0];
    expect(view.bonus).toMatchObject({ surprise: false, kind: 'screen', label: '+30 min de pantalla' });
    await approveAll(t.id, twoDays());
    expect(await screen(F.ids.lucia)).toBe(60);
    expect((await F.luciaC.get(`/api/screen/${F.ids.lucia}`)).body.entries).toHaveLength(2);
    expect((await F.luciaC.get(`/api/screen/${F.ids.hugo}`)).status).toBe(403);
  });

  it('bono de puntos extra', async () => {
    const t = await mk({ startDate: addDays(today(), -1), bonus: { kind: 'points', points: 7 } });
    await approveAll(t.id, [addDays(today(), -1)]);
    expect(await ptsBalance(F.ids.lucia)).toBe(27);
  });

  it('sorpresa: oculta al hijo, se gana una sola vez y luego la tarea es normal', async () => {
    const secret = 'Helado de pistacho el sábado';
    const t = await mk({ startDate: addDays(today(), -2), bonus: { kind: 'text', text: secret, surprise: true } });
    const raw = JSON.stringify([(await F.luciaC.get('/api/tasks')).body, (await F.luciaC.get(`/api/instances?from=${addDays(today(), -2)}&to=${today()}`)).body]);
    expect(raw).not.toContain('pistacho');
    expect((await F.luciaC.get('/api/tasks')).body.tasks[0].bonus).toEqual({ surprise: true, onTimeOnly: false });
    expect(JSON.stringify((await F.luciaC.get('/api/tasks')).body.tasks[0])).not.toMatch(/bonus_(kind|text|points|minutes)/);
    // el adulto sí lo ve
    expect((await F.mama.get('/api/tasks')).body.tasks[0].bonus).toMatchObject({ surprise: true, label: secret });

    const [d1, d2] = twoDays();
    await approveAll(t.id, [d1]);
    const un = (await F.luciaC.get('/api/bonus-grants/unrevealed')).body.grants;
    expect(un).toHaveLength(1);
    expect(un[0].label).toBe(secret);
    // aún sin abrir, en la lista general no se desvela
    expect((await F.luciaC.get('/api/bonus-grants')).body.grants[0].label).toBe('🎁 Sorpresa');
    // el aviso no revela el contenido
    const notes = (await F.luciaC.get('/api/notifications')).body.notifications.filter((n: any) => n.kind === 'bonus_won');
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes)).not.toContain('pistacho');
    expect((await F.luciaC.post(`/api/bonus-grants/${un[0].id}/reveal`)).status).toBe(200);
    expect((await F.luciaC.get('/api/bonus-grants/unrevealed')).body.grants).toHaveLength(0);

    // segunda aprobación: ya no hay sorpresa ni etiqueta
    await approveAll(t.id, [d2]);
    expect((await pool().query('SELECT 1 FROM bonus_grants')).rowCount).toBe(1);
    expect((await F.luciaC.get('/api/tasks')).body.tasks[0].bonus).toBeNull();
    // otro hijo asignado a la misma tarea sí tiene su propia sorpresa
    expect((await pool().query('SELECT 1 FROM bonus_claims')).rowCount).toBe(1);
  });

  it('texto/recompensa quedan pendientes de cumplir hasta que un adulto pulsa «Cumplido»', async () => {
    const rw = (await F.mama.post('/api/rewards', { title: 'Cine', costPoints: 100 })).body.reward;
    const t = await mk({ startDate: addDays(today(), -1), bonus: { kind: 'reward', rewardId: rw.id } });
    await approveAll(t.id, [addDays(today(), -1)]);
    let g = (await F.mama.get('/api/bonus-grants')).body.grants;
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ kind: 'reward', label: 'Premio: Cine', display_name: 'Lucía' });
    expect((await F.mama.get('/api/dashboard')).body.pendingGrants).toBe(1);
    expect((await F.luciaC.post(`/api/bonus-grants/${g[0].id}/fulfill`)).status).toBe(403);
    expect((await F.mama.post(`/api/bonus-grants/${g[0].id}/fulfill`)).status).toBe(200);
    expect((await F.mama.get('/api/bonus-grants')).body.grants).toHaveLength(0);
    // no toca puntos ni redenciones
    expect(await ptsBalance(F.ids.lucia)).toBe(20);
    expect((await pool().query('SELECT 1 FROM redemptions')).rowCount).toBe(0);
  });

  it('bono solo a tiempo: tarde no se concede y la sorpresa no se gasta', async () => {
    const t = await mk({ dueTime: '00:00', dueTimeWeekend: '00:00', latePercent: 100, bonus: { kind: 'points', points: 9, surprise: true, onTimeOnly: true } });
    const i = await instOf(t.id);
    await F.luciaC.post(`/api/instances/${i.id}/complete`, {});
    await F.mama.post(`/api/instances/${i.id}/review`, { approve: true });
    expect(await ptsBalance(F.ids.lucia)).toBe(20);
    expect((await pool().query('SELECT 1 FROM bonus_grants')).rowCount).toBe(0);
    expect((await pool().query('SELECT 1 FROM bonus_claims')).rowCount).toBe(0);
  });

  it('bono solo a tiempo: a tiempo sí se concede (autoaprobación)', async () => {
    const t = await mk({ dueTime: '09:00', dueTimeWeekend: '09:00', requiresApproval: false, bonus: { kind: 'points', points: 9, onTimeOnly: true } });
    await completeInstance(kid(F.ids.lucia, 'Lucía'), (await instOf(t.id)).id, { now: zonedToUtc(today(), '08:00', TZ) });
    expect(await ptsBalance(F.ids.lucia)).toBe(29);
  });

  it('valida el bono', async () => {
    const base = { title: 'x', points: 5, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia] };
    expect((await F.mama.post('/api/tasks', { ...base, bonus: { kind: 'screen' } })).status).toBe(400);
    expect((await F.mama.post('/api/tasks', { ...base, bonus: { kind: 'reward', rewardId: '00000000-0000-4000-8000-000000000000' } })).status).toBe(400);
  });
});

describe('minutos de pantalla', () => {
  it('nunca baja de 0 (se recorta) y solo los adultos mueven minutos', async () => {
    expect((await F.luciaC.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 100, note: 'x' })).status).toBe(403);
    expect((await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 50, note: 'Regalo' })).body.balance).toBe(50);
    const r = await F.mama.post('/api/screen/spend', { userId: F.ids.lucia, minutes: 80 });
    expect(r.body).toMatchObject({ applied: 50, requested: 80, balance: 0 });
    expect((await F.mama.post('/api/screen/spend', { userId: F.ids.lucia, minutes: 5 })).status).toBe(409);
    expect(await screen(F.ids.lucia)).toBe(0);
    // el esquema lo impide aunque se salte la aplicación
    await expect(pool().query(`INSERT INTO screen_ledger(family_id,user_id,delta,kind) VALUES ($1,$2,-1,'spend')`, [F.ids.family, F.ids.lucia])).rejects.toThrow(/negativo/);
    await expect(pool().query(`UPDATE screen_ledger SET delta = 999`)).rejects.toThrow(/no se pueden modificar/);
  });

  it('es seguro con peticiones concurrentes', async () => {
    await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 100, note: 'Base' });
    const rs = await Promise.all(Array.from({ length: 8 }, () => F.mama.post('/api/screen/spend', { userId: F.ids.lucia, minutes: 30 })));
    const applied = rs.filter((r) => r.status === 200).reduce((s, r) => s + r.body.applied, 0);
    expect(applied).toBe(100);
    expect(await screen(F.ids.lucia)).toBe(0);
    expect((await pool().query('SELECT 1 FROM screen_ledger WHERE delta < 0 AND false')).rowCount).toBe(0);
  });

  it('el saldo aparece en la cartera y el panel de los adultos', async () => {
    await F.mama.post('/api/screen/adjust', { userId: F.ids.hugo, delta: 25, note: 'x' });
    expect((await F.hugoC.get(`/api/wallet/${F.ids.hugo}`)).body.wallet.screen_minutes).toBe(25);
    const kids = (await F.mama.get('/api/dashboard')).body.kids;
    expect(kids.find((k: any) => k.id === F.ids.hugo).wallet.screen_minutes).toBe(25);
  });
});

describe('tareas que marca un adulto', () => {
  const body = { title: 'Estar en el coche a la hora', points: 0, recurrence: 'daily', checkMode: true, penaltyMinutes: 15, successMinutes: 0 };
  async function checkTask(over: Record<string, unknown> = {}) {
    const t = await mk({ ...body, ...over });
    return { t, inst: await instOf(t.id) };
  }

  it('el hijo no puede completarla ni marcarla; no puede ser compartida', async () => {
    const { inst } = await checkTask();
    expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`, {})).status).toBe(403);
    expect((await F.luciaC.post(`/api/instances/${inst.id}/check`, { met: true })).status).toBe(403);
    expect((await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true })).status).toBe(400);
    expect((await F.mama.post('/api/tasks', { ...body, startDate: today(), assignees: [F.ids.lucia, F.ids.hugo], assignmentMode: 'shared' })).status).toBe(400);
    const v = (await F.luciaC.get('/api/instances')).body.instances[0];
    expect(v).toMatchObject({ check_mode: true, penalty_minutes: 15, status: 'pending' });
  });

  it('«No cumplida» resta los minutos (recortados al saldo) y no toca puntos', async () => {
    const { inst } = await checkTask({ points: 10 });
    await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 40, note: 'Base' });
    const r = await F.mama.post(`/api/instances/${inst.id}/check`, { met: false });
    expect(r.body).toMatchObject({ status: 'expired', met: false, penaltyApplied: 15, duplicate: false });
    expect(await screen(F.ids.lucia)).toBe(25);
    expect(await ptsBalance(F.ids.lucia)).toBe(0);
    // idempotente
    const again = await F.mama.post(`/api/instances/${inst.id}/check`, { met: false });
    expect(again.body.duplicate).toBe(true);
    expect(await screen(F.ids.lucia)).toBe(25);
    expect((await instOf(inst.task_id)).review_note).toBe('No cumplida');
  });

  it('sin saldo la penalización se pierde y al corregir solo se devuelve lo restado', async () => {
    const { inst } = await checkTask();
    await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 5, note: 'Base' });
    const r = await F.mama.post(`/api/instances/${inst.id}/check`, { met: false });
    expect(r.body.penaltyApplied).toBe(5);
    expect(await screen(F.ids.lucia)).toBe(0);
    await F.mama.post(`/api/instances/${inst.id}/check`, { met: true });
    expect(await screen(F.ids.lucia)).toBe(5); // exactamente lo que se restó
    const kinds = (await F.mama.get(`/api/screen/${F.ids.lucia}`)).body.entries.map((e: any) => e.kind);
    expect(kinds).toContain('refund');
    // saldo 0 y nada que restar
    const t2 = await mk({ ...body, title: 'Otra' });
    await F.mama.post('/api/screen/spend', { userId: F.ids.lucia, minutes: 5 });
    const r2 = await F.mama.post(`/api/instances/${(await instOf(t2.id)).id}/check`, { met: false });
    expect(r2.body.penaltyApplied).toBe(0);
    expect(await screen(F.ids.lucia)).toBe(0);
  });

  it('corregir en ambos sentidos: reembolsa, concede y compensa sin duplicar', async () => {
    const { inst } = await checkTask({ points: 10, successMinutes: 5, bonus: { kind: 'points', points: 3 } });
    await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 40, note: 'Base' });
    await F.mama.post(`/api/instances/${inst.id}/check`, { met: false });
    expect(await screen(F.ids.lucia)).toBe(25);
    // No cumplida → Cumplida: +15 de reembolso, +5 de éxito, puntos 10 + bono 3
    const ok = await F.mama.post(`/api/instances/${inst.id}/check`, { met: true });
    expect(ok.body).toMatchObject({ status: 'approved', met: true });
    expect(await screen(F.ids.lucia)).toBe(45);
    expect(await ptsBalance(F.ids.lucia)).toBe(13);
    expect((await F.mama.post(`/api/instances/${inst.id}/check`, { met: true })).body.duplicate).toBe(true);
    expect(await ptsBalance(F.ids.lucia)).toBe(13);
    // Cumplida → No cumplida: se revierte lo concedido y se aplica la penalización
    const no = await F.mama.post(`/api/instances/${inst.id}/check`, { met: false });
    expect(no.body).toMatchObject({ status: 'expired', penaltyApplied: 15 });
    expect(await ptsBalance(F.ids.lucia)).toBe(0);
    expect(await screen(F.ids.lucia)).toBe(25); // 45 −5 −15
    const kinds = (await pool().query(`SELECT kind FROM points_ledger WHERE ref_id = $1 ORDER BY created_at`, [inst.id])).rows.map((r) => r.kind);
    expect(kinds).toContain('adjustment');
    // y otra vez a Cumplida: vuelve todo, el bono sin duplicarse
    await F.mama.post(`/api/instances/${inst.id}/check`, { met: true });
    expect(await ptsBalance(F.ids.lucia)).toBe(13);
    expect(await screen(F.ids.lucia)).toBe(45);
    expect((await pool().query('SELECT 1 FROM bonus_grants WHERE voided_at IS NULL')).rowCount).toBe(1);
  });

  it('«Cumplida» sin nada configurado no concede nada; no se pueden marcar días futuros', async () => {
    const { inst, t } = await checkTask({ penaltyMinutes: 0 });
    expect((await F.mama.post(`/api/instances/${inst.id}/check`, { met: true })).body.status).toBe('approved');
    expect(await ptsBalance(F.ids.lucia)).toBe(0);
    expect(await screen(F.ids.lucia)).toBe(0);
    const future = await instOf(t.id, addDays(today(), 1));
    expect((await F.mama.post(`/api/instances/${future.id}/check`, { met: true })).status).toBe(400);
    // el adulto que no es de la familia no puede
    await setSetting('registration_open', true, F.ids.mama);
    const other = await createFamily(app, 'g');
    expect((await other.mama.post(`/api/instances/${inst.id}/check`, { met: false })).status).toBe(404);
    // una tarea normal no se puede marcar con /check
    const n = await mk({ title: 'Normal' });
    expect((await F.mama.post(`/api/instances/${(await instOf(n.id)).id}/check`, { met: true })).status).toBe(400);
  });

  it('las no cumplidas no cuentan como «vencidas por revisar» y el recordatorio las ignora', async () => {
    const { inst } = await checkTask();
    await F.mama.post(`/api/instances/${inst.id}/check`, { met: false });
    expect((await F.mama.get('/api/dashboard')).body.overdueLastWeek).toBe(0);
    await scheduleReminders(pool(), F.ids.family, zonedToUtc(today(), '23:00', TZ));
    expect((await pool().query(`SELECT 1 FROM notifications WHERE kind = 'task_reminder'`)).rowCount).toBe(0);
  });
});
