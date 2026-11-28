import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, one } from '../src/lib/db.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import { zonedToUtc } from '../src/lib/notify/time.js';
import { completeInstance } from '../src/lib/task-actions.js';
import { computeStreak } from '../src/lib/gamification.js';
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
const bal = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM points_ledger WHERE user_id=$1', [u]))!.b as number;
const screen = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM screen_ledger WHERE user_id=$1', [u]))!.b as number;

async function submitted(over: Record<string, unknown> = {}) {
  const r = await F.mama.post('/api/tasks', { title: 'Recoger el cuarto', points: 20, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const inst = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.task_id === r.body.task.id);
  expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`)).status).toBe(200);
  return { taskId: r.body.task.id as string, id: inst.id as string };
}
const review = (id: string, body: Record<string, unknown>) => F.mama.post(`/api/instances/${id}/review`, body);

describe('Registro de tareas por un adulto', () => {
  it('registra una tarea compartida vencida para el hijo elegido, con rastro y un solo premio', async () => {
    const day = addDays(today(), -1);
    const task = await F.mama.post('/api/tasks', {
      title: 'Recoger el cuarto', points: 20, recurrence: 'once', startDate: day,
      assignmentMode: 'shared', assignees: [F.ids.lucia, F.ids.hugo], requiresPhoto: true,
      bonus: { kind: 'points', points: 5 },
    });
    expect(task.status).toBe(200);
    const { instances } = (await F.mama.get(`/api/instances?from=${day}`)).body;
    const inst = instances.find((i: any) => i.task_id === task.body.task.id);
    const url = `/api/instances/${inst.id}/register`;
    expect((await F.luciaC.post(url, { childId: F.ids.lucia })).status).toBe(403);
    expect((await F.mama.post(url, { childId: F.ids.papa, note: 'Lo he visto' })).status).toBe(403);
    expect((await F.mama.post(url, { childId: F.ids.hugo })).body.error).toBe('verification_required');
    const requests = await Promise.all([F.mama, F.papaC].map((adult) => adult.post(url, { childId: F.ids.hugo, note: 'He comprobado el cuarto' })));
    expect(requests.map((r) => r.status)).toEqual([200, 200]);
    expect(requests.map((r) => r.body.duplicate).sort()).toEqual([false, true]);
    expect((await F.mama.post(url, { childId: F.ids.lucia, note: 'Otra persona' })).status).toBe(409);
    expect(await bal(F.ids.hugo)).toBe(25);
    expect(await bal(F.ids.lucia)).toBe(0);
    expect(await one(pool(), `SELECT actor_id, data->>'for' AS child_id FROM audit_log WHERE entity_id = $1 AND action = 'task.register'`, [inst.id]))
      .toEqual({ actor_id: requests[0].body.duplicate ? F.ids.papa : F.ids.mama, child_id: F.ids.hugo });
    const mine = (await F.hugoC.get(`/api/instances?from=${day}`)).body.instances.find((i: any) => i.id === inst.id);
    expect(mine).toMatchObject({ due_date: day, completed_by: F.ids.hugo, status: 'approved', review_note: 'He comprobado el cuarto', adult_logged: true, can_unmark: false });
  });

  it('respeta la asignación individual, el día de la tarea y las vías de revisión', async () => {
    const task = await F.mama.post('/api/tasks', {
      title: 'Preparar la mochila', points: 10, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia],
    });
    const tomorrow = addDays(today(), 1);
    const { instances } = (await F.mama.get(`/api/instances?to=${tomorrow}`)).body;
    const inst = (day: string) => instances.find((i: any) => i.task_id === task.body.task.id && i.due_date === day);
    const register = (id: string, childId = F.ids.lucia) => F.mama.post(`/api/instances/${id}/register`, { childId });
    expect((await register(inst(today()).id, F.ids.hugo)).status).toBe(403);
    expect((await register(inst(tomorrow).id)).body.error).toBe('not_due');
    await F.luciaC.post(`/api/instances/${inst(today()).id}/complete`);
    expect((await register(inst(today()).id)).body.error).toBe('review_required');
    const check = await F.mama.post('/api/tasks', {
      title: 'Hora de acostarse', points: 10, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], checkMode: true,
    });
    const i = (await F.mama.get('/api/instances')).body.instances.find((v: any) => v.task_id === check.body.task.id);
    expect((await register(i.id)).body.error).toBe('check_task');
    expect(await bal(F.ids.lucia)).toBe(0);
  });

  it('aplica la hora efectiva de la familia a los puntos y al bono de una jornada anterior', async () => {
    const day = addDays(today(), -1);
    const task = await F.mama.post('/api/tasks', {
      title: 'Preparar la ropa', points: 20, recurrence: 'once', startDate: day,
      dueTime: '10:00', dueTimeWeekend: '10:00', latePercent: 50, assignees: [F.ids.lucia, F.ids.hugo],
      bonus: { kind: 'points', points: 5, onTimeOnly: true },
    });
    const { instances } = (await F.mama.get(`/api/instances?from=${day}`)).body;
    const register = (childId: string, completedTime?: string) => {
      const i = instances.find((v: any) => v.task_id === task.body.task.id && v.assignee_id === childId);
      return F.mama.post(`/api/instances/${i.id}/register`, { childId, completedTime });
    };
    expect((await register(F.ids.lucia)).body.error).toBe('completion_time_required');
    expect((await register(F.ids.lucia, '09:55')).status).toBe(200);
    expect((await register(F.ids.hugo, '10:05')).status).toBe(200);
    expect(await bal(F.ids.lucia)).toBe(25);
    expect(await bal(F.ids.hugo)).toBe(10);
    const mine = (await F.hugoC.get(`/api/instances?from=${day}`)).body.instances.find((i: any) => i.task_id === task.body.task.id);
    expect(mine).toMatchObject({ completed_at: zonedToUtc(day, '10:05', TZ).toISOString(), on_time: false, registered_by_name: 'Mamá' });
    expect(mine.reviewed_at).not.toBe(mine.completed_at);
  });

  it('consultar un día pasado para registrar no materializa ocurrencias con la asignación actual', async () => {
    const day = addDays(today(), -2);
    const definition = { title: 'Ordenar la mesa', points: 5, recurrence: 'daily', startDate: day, assignees: [F.ids.lucia] };
    const { task } = (await F.mama.post('/api/tasks', definition)).body;
    expect((await F.mama.put(`/api/tasks/${task.id}`, { ...definition, assignees: [F.ids.hugo] })).status).toBe(200);
    const historical = () => one(pool(), 'SELECT id FROM task_instances WHERE task_id = $1 AND due_date = $2', [task.id, day]);
    expect(await historical()).toBeUndefined();
    const r = await F.mama.get(`/api/instances?from=${day}&registration=1`);
    expect(r).toMatchObject({ status: 200, body: { instances: [] } });
    expect(await historical()).toBeUndefined();
    expect((await F.luciaC.get(`/api/instances?from=${day}&registration=1`)).status).toBe(403);
    const ordinary = await F.mama.get(`/api/instances?from=${day}`);
    const rebuilt = ordinary.body.instances.find((i: any) => i.task_id === task.id);
    expect(rebuilt).toMatchObject({ assignee_id: F.ids.hugo, registration_children: [] });
    expect((await F.mama.post(`/api/instances/${rebuilt.id}/register`, { childId: F.ids.hugo })).body.error).toBe('historical_assignment_unknown');
  });
});

describe('Premio parcial (I15)', () => {
  it('da solo esos puntos, exige motivo, no concede bono y cuenta como hecha', async () => {
    const t = await submitted({ bonus: { kind: 'points', points: 5, surprise: false, onTimeOnly: false } });
    expect((await review(t.id, { action: 'partial', points: 10 })).body.error).toBe('reason_required');
    expect((await F.luciaC.post(`/api/instances/${t.id}/review`, { action: 'partial', points: 10, note: 'x' })).status).toBe(403);
    const r = await review(t.id, { action: 'partial', points: 10, note: 'Falta un poco' });
    expect(r.body).toMatchObject({ status: 'approved', outcome: 'partial', points: 10 });
    expect(await bal(F.ids.lucia)).toBe(10); // sin los 5 del bono
    expect((await pool().query('SELECT count(*)::int AS n FROM bonus_grants WHERE instance_id = $1', [t.id])).rows[0].n).toBe(0);
    expect((await review(t.id, { action: 'partial', points: 10, note: 'otra vez' })).status).toBe(409);
    expect(await computeStreak(pool(), F.ids.lucia, today())).toBe(1);
    const mine = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.id === t.id);
    expect(mine).toMatchObject({ status: 'approved', review_outcome: 'partial', review_note: 'Falta un poco', points: 10 });
  });

  it('una sorpresa no se revela ni se gasta con un premio parcial', async () => {
    const t = await submitted({ bonus: { kind: 'text', text: 'Helado', surprise: true, onTimeOnly: false } });
    await review(t.id, { action: 'partial', points: 5, note: 'Mal hecha' });
    expect((await pool().query('SELECT count(*)::int AS n FROM bonus_claims')).rows[0].n).toBe(0);
    expect((await pool().query('SELECT count(*)::int AS n FROM bonus_grants')).rows[0].n).toBe(0);
    const n = (await F.luciaC.get('/api/notifications')).body.notifications ?? (await F.luciaC.get('/api/notifications')).body.items;
    expect(JSON.stringify(n)).not.toContain('Helado');
  });
});

describe('Devolver para que la arregle (I15)', () => {
  it('el hijo puede reenviarla y cuenta la hora ORIGINAL: si llegó a tiempo, sigue a tiempo', async () => {
    const r = await F.mama.post('/api/tasks', { title: 'Deberes', points: 20, recurrence: 'daily', startDate: today(), dueTime: '09:00', dueTimeWeekend: '09:00', latePercent: 50, assignees: [F.ids.lucia] });
    const inst = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.task_id === r.body.task.id);
    const at = (hhmm: string, plusDays = 0) => zonedToUtc(addDays(today(), plusDays), hhmm, TZ);
    const first = await completeInstance(kid(F.ids.lucia, 'Lucía'), inst.id, { now: at('08:30') });
    expect(first).toMatchObject({ onTime: true, potentialPoints: 20 });
    expect((await review(inst.id, { action: 'return', note: 'Falta un poco' })).body.status).toBe('rejected');
    const mine = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.id === inst.id);
    expect(mine).toMatchObject({ status: 'rejected', review_outcome: 'returned', review_note: 'Falta un poco' });
    // Reenvía pasada la hora límite, incluso al día siguiente: sigue a tiempo y con el valor completo.
    const again = await completeInstance(kid(F.ids.lucia, 'Lucía'), inst.id, { now: at('13:00', 1) });
    expect(again).toMatchObject({ onTime: true, potentialPoints: 20 });
    expect((await one(pool(), 'SELECT first_submitted_at FROM task_instances WHERE id = $1', [inst.id]))!.first_submitted_at.toISOString()).toBe(at('08:30').toISOString());
    // Control: quien la envía tarde por primera vez sí pierde valor.
    const r2 = await F.mama.post('/api/tasks', { title: 'Mates', points: 20, recurrence: 'daily', startDate: today(), dueTime: '09:00', dueTimeWeekend: '09:00', latePercent: 50, assignees: [F.ids.lucia] });
    const i2 = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.task_id === r2.body.task.id);
    expect(await completeInstance(kid(F.ids.lucia, 'Lucía'), i2.id, { now: at('15:00') })).toMatchObject({ onTime: false, potentialPoints: 10 });
  });

  it('exige motivo con la acción nueva; el «devolver» antiguo sigue admitiéndolo vacío', async () => {
    const t = await submitted();
    expect((await review(t.id, { action: 'return' })).body.error).toBe('reason_required');
    expect((await review(t.id, { approve: false })).body.status).toBe('rejected');
  });
});

describe('Rechazar (I15)', () => {
  it('sin penalidad: estado final, sin puntos, no cuenta como hecha y no se puede reenviar', async () => {
    const t = await submitted();
    expect((await review(t.id, { action: 'reject' })).body.error).toBe('reason_required');
    const r = await review(t.id, { action: 'reject', note: 'No está hecha' });
    expect(r.body).toMatchObject({ status: 'declined', penaltyPoints: 0 });
    expect(await bal(F.ids.lucia)).toBe(0);
    expect(await computeStreak(pool(), F.ids.lucia, today())).toBe(0);
    expect((await F.luciaC.post(`/api/instances/${t.id}/complete`)).status).toBe(409);
    expect((await review(t.id, { action: 'approve' })).status).toBe(409);
    const mine = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.id === t.id);
    expect(mine).toMatchObject({ status: 'declined', review_outcome: 'declined', review_note: 'No está hecha' });
  });

  it('con penalidad: resta puntos (por defecto los de la tarea, pueden quedar negativos) y minutos recortados a 0, en ambos libros', async () => {
    await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 10, note: 'regalo' });
    const other = await submitted({ title: 'Otra', points: 5, requiresApproval: false });
    expect(await bal(F.ids.lucia)).toBe(5);
    const t = await submitted();
    expect((await review(t.id, { action: 'reject_penalty', note: 'Mal hecha' })).body).toMatchObject({ status: 'declined', penaltyPoints: 20, penaltyMinutes: 0 }); // sin minutos pedidos: solo puntos
    expect(await bal(F.ids.lucia)).toBe(-15);
    const t2 = await submitted({ title: 'Tercera', points: 8 });
    const r = await review(t2.id, { action: 'reject_penalty', note: 'Sin foto', penaltyPoints: 0, penaltyMinutes: 30 });
    expect(r.body).toMatchObject({ penaltyPoints: 0, penaltyMinutes: 10 }); // solo había 10 min
    expect(await screen(F.ids.lucia)).toBe(0);
    expect(await bal(F.ids.lucia)).toBe(-15);
    const led = (await pool().query(`SELECT delta, kind FROM points_ledger WHERE ref_id = $1`, [t.id])).rows;
    expect(led).toEqual([{ delta: -20, kind: 'adjustment' }]);
    const sled = (await pool().query(`SELECT delta, kind FROM screen_ledger WHERE ref_id = $1`, [t2.id])).rows;
    expect(sled).toEqual([{ delta: -10, kind: 'penalty' }]);
    // Hay que restar algo
    const t3 = await submitted({ title: 'Cuarta' });
    expect((await review(t3.id, { action: 'reject_penalty', note: 'x', penaltyPoints: 0, penaltyMinutes: 0 })).body.error).toBe('penalty_required');
    expect(other.id).toBeTruthy();
  });

  it('el hijo recibe el aviso con el motivo y la penalidad, y todo queda en la auditoría', async () => {
    const t = await submitted();
    await review(t.id, { action: 'reject_penalty', note: 'Mal hecha', penaltyPoints: 7 });
    const notes = await pool().query(`SELECT title, body FROM notifications WHERE user_id = $1 AND kind = 'task_rejected'`, [F.ids.lucia]);
    expect(notes.rows).toHaveLength(1);
    expect(notes.rows[0].body).toContain('Mal hecha');
    expect(notes.rows[0].body).toContain('−7 puntos');
    const t2 = await submitted({ title: 'Segunda' });
    await review(t2.id, { action: 'partial', points: 3, note: 'Falta un poco' });
    const t3 = await submitted({ title: 'Tercera' });
    await review(t3.id, { action: 'return', note: 'Arréglala' });
    const t4 = await submitted({ title: 'Cuarta' });
    await review(t4.id, { action: 'reject', note: 'No está hecha' });
    const acts = (await pool().query(`SELECT action FROM audit_log WHERE family_id = $1`, [F.ids.family])).rows.map((r) => r.action);
    expect(acts).toEqual(expect.arrayContaining(['task.reject_penalty', 'task.partial', 'task.return', 'task.reject']));
  });

  it('otra familia no puede revisar', async () => {
    const t = await submitted();
    const { setSetting } = await import('../src/lib/settings.js');
    await setSetting('registration_open', true);
    const G = await createFamily(app, 'g');
    expect((await G.mama.post(`/api/instances/${t.id}/review`, { action: 'reject', note: 'x' })).status).toBe(404);
  });
});
