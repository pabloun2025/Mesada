import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one } from '../src/lib/db.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import { zonedToUtc } from '../src/lib/notify/time.js';
import { completeInstance, unmarkInstance } from '../src/lib/task-actions.js';
import { lifetimePoints } from '../src/lib/gamification.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const TZ = 'Europe/Madrid';
const today = () => todayIn(TZ);
const pool = () => getPool();
const at = (hhmm: string, plusDays = 0) => zonedToUtc(addDays(today(), plusDays), hhmm, TZ);

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
const lucia = () => kid(F.ids.lucia, 'Lucía');
const hugo = () => kid(F.ids.hugo, 'Hugo');
const pts = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM points_ledger WHERE user_id=$1', [u]))!.b as number;
const mins = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM screen_ledger WHERE user_id=$1', [u]))!.b as number;
const instRow = async (id: string) => (await one(pool(), 'SELECT * FROM task_instances WHERE id = $1', [id]))!;
const notesFor = async (u: string) => (await many(pool(), 'SELECT title FROM notifications WHERE user_id = $1', [u])).length;

async function mkTask(over: Record<string, unknown> = {}, asKid = F.luciaC) {
  const r = await F.mama.post('/api/tasks', { title: 'Recoger el cuarto', points: 20, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  const inst = (await asKid.get('/api/instances')).body.instances.find((i: any) => i.task_id === r.body.task.id);
  return { taskId: r.body.task.id as string, id: inst.id as string };
}
const unmark = (c: any, id: string) => c.post(`/api/instances/${id}/unmark`);

describe('Desmarcar (I17)', () => {
  it('enviada a validar: vuelve a pendiente, sin avisar a los adultos, sale de «Por validar» y queda en el historial', async () => {
    const t = await mkTask();
    expect((await F.luciaC.post(`/api/instances/${t.id}/complete`)).status).toBe(200);
    expect((await F.mama.get('/api/dashboard')).body.pendingApprovals.map((x: any) => x.id)).toContain(t.id);
    const before = (await notesFor(F.ids.mama)) + (await notesFor(F.ids.papa));
    const mine = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.id === t.id);
    expect(mine.can_unmark).toBe(true);
    expect((await unmark(F.luciaC, t.id)).body).toMatchObject({ status: 'pending' });
    expect((await notesFor(F.ids.mama)) + (await notesFor(F.ids.papa))).toBe(before);
    expect((await F.mama.get('/api/dashboard')).body.pendingApprovals.map((x: any) => x.id)).not.toContain(t.id);
    expect(await instRow(t.id)).toMatchObject({ status: 'pending', completed_by: null, completed_at: null, first_submitted_at: null, on_time: null, unmark_count: 1 });
    const a = await one(pool(), `SELECT actor_id FROM audit_log WHERE action = 'task.unmark' AND entity_id = $1`, [t.id]);
    expect(a!.actor_id).toBe(F.ids.lucia);
    // Se puede volver a marcar.
    expect((await F.luciaC.post(`/api/instances/${t.id}/complete`)).status).toBe(200);
    expect((await unmark(F.luciaC, t.id)).status).toBe(200);
  });

  it('sin validación: devuelve puntos, bono y minutos con movimientos nuevos y, al volver a marcar, cuenta la hora nueva', async () => {
    const t = await mkTask({ dueTime: '09:00', dueTimeWeekend: '09:00', latePercent: 50, requiresApproval: false, bonus: { kind: 'screen', minutes: 15, surprise: false, onTimeOnly: false } });
    expect(await completeInstance(lucia(), t.id, { now: at('08:00') })).toMatchObject({ status: 'approved', onTime: true, points: 20 });
    expect(await pts(F.ids.lucia)).toBe(20);
    expect(await mins(F.ids.lucia)).toBe(15);
    expect((await unmarkInstance(lucia(), t.id, { now: at('08:30') })).pointsBack).toBe(20);
    expect(await pts(F.ids.lucia)).toBe(0);
    expect(await mins(F.ids.lucia)).toBe(0);
    // Los libros no se editan: quedan las entradas originales y las compensaciones.
    const led = (await pool().query(`SELECT delta, kind FROM points_ledger WHERE ref_id = $1 ORDER BY seq`, [t.id])).rows;
    expect(led).toEqual([{ delta: 20, kind: 'task' }, { delta: -20, kind: 'adjustment' }]);
    // Vuelve a marcar tarde: cuenta la hora nueva (la mitad de los puntos) y el bono se concede otra vez.
    expect(await completeInstance(lucia(), t.id, { now: at('15:00') })).toMatchObject({ onTime: false, points: 10 });
    expect(await pts(F.ids.lucia)).toBe(10);
    expect(await mins(F.ids.lucia)).toBe(15);
    // Y otra vez desmarcada: todo a cero sin choques de claves.
    await unmarkInstance(lucia(), t.id, { now: at('15:10') });
    expect(await pts(F.ids.lucia)).toBe(0);
    expect(await mins(F.ids.lucia)).toBe(0);
    expect(await completeInstance(lucia(), t.id, { now: at('16:00') })).toMatchObject({ points: 10 });
    expect(await pts(F.ids.lucia)).toBe(10);
  });

  it('los puntos de toda la vida (niveles) también bajan', async () => {
    const t = await mkTask({ requiresApproval: false, bonus: { kind: 'points', points: 5, surprise: false, onTimeOnly: false } });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect(await lifetimePoints(pool(), F.ids.lucia)).toBe(25);
    await unmark(F.luciaC, t.id);
    expect(await lifetimePoints(pool(), F.ids.lucia)).toBe(0);
    expect(await pts(F.ids.lucia)).toBe(0);
  });

  it('una sorpresa ya ganada se deshace y vuelve a estar disponible', async () => {
    const t = await mkTask({ requiresApproval: false, bonus: { kind: 'points', points: 7, surprise: true, onTimeOnly: false } });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect(await pts(F.ids.lucia)).toBe(27);
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM bonus_claims WHERE user_id = $1', [F.ids.lucia]))!.n).toBe(1);
    await unmark(F.luciaC, t.id);
    expect(await pts(F.ids.lucia)).toBe(0);
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM bonus_claims WHERE user_id = $1', [F.ids.lucia]))!.n).toBe(0);
    // El hijo vuelve a ver la tarea con sorpresa por ganar.
    const mine = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.id === t.id);
    expect(mine.bonus).toMatchObject({ surprise: true });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect(await pts(F.ids.lucia)).toBe(27);
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM bonus_claims WHERE user_id = $1', [F.ids.lucia]))!.n).toBe(1);
  });

  it('un adulto ya validó la tarea o pasó el día: no se puede', async () => {
    const t = await mkTask();
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    await F.mama.post(`/api/instances/${t.id}/review`, { approve: true });
    expect((await unmark(F.luciaC, t.id)).body.error).toBe('already_validated');
    const mine = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.id === t.id);
    expect(mine.can_unmark).toBe(false);
    // Sin validación, pasado el día.
    const t2 = await mkTask({ title: 'Otra', requiresApproval: false });
    await completeInstance(lucia(), t2.id, { now: at('10:00') });
    await expect(unmarkInstance(lucia(), t2.id, { now: at('10:00', 1) })).rejects.toMatchObject({ code: 'day_over' });
    await expect(unmarkInstance(lucia(), t2.id, { now: at('23:30') })).resolves.toMatchObject({ status: 'pending' }); // el mismo día, sí
  });

  it('solo quien la marcó, y solo hijos', async () => {
    const t = await mkTask({ assignmentMode: 'shared', assignees: [F.ids.lucia, F.ids.hugo] }, F.luciaC);
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect((await unmark(F.hugoC, t.id)).status).toBe(403);
    expect((await unmark(F.mama, t.id)).status).toBe(403);
    expect((await unmark(F.luciaC, t.id)).status).toBe(200);
    expect((await unmark(F.luciaC, t.id)).status).toBe(409); // ya no está marcada
  });

  it('compartida: al desmarcar queda libre para el otro hijo', async () => {
    const t = await mkTask({ assignmentMode: 'shared', assignees: [F.ids.lucia, F.ids.hugo] });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect((await F.hugoC.post(`/api/instances/${t.id}/complete`)).status).toBe(409);
    await unmark(F.luciaC, t.id);
    expect((await F.hugoC.post(`/api/instances/${t.id}/complete`)).status).toBe(200);
    expect(await instRow(t.id)).toMatchObject({ completed_by: F.ids.hugo });
  });

  it('«Cuando haga falta» con espera: al desmarcar se levanta la espera', async () => {
    const t = await mkTask({ recurrence: 'as_needed', cooldownDays: 3, assignees: [F.ids.lucia, F.ids.hugo] });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    await unmark(F.luciaC, t.id);
    const mine = (await F.hugoC.get('/api/instances')).body.instances.find((i: any) => i.id === t.id);
    expect(mine.status).toBe('pending');
    expect(mine.blocked_until).toBeNull();
    expect((await F.hugoC.post(`/api/instances/${t.id}/complete`)).status).toBe(200);
  });

  it('repetible: se quita la repetición que se había abierto detrás', async () => {
    const t = await mkTask({ repeatable: true, maxPerDay: 3 });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    const all = async () => (await F.luciaC.get('/api/instances')).body.instances.filter((i: any) => i.task_id === t.taskId);
    expect((await all()).length).toBe(2);
    await unmark(F.luciaC, t.id);
    const after = await all();
    expect(after.map((i: any) => i.repeat_no)).toEqual([1]);
    expect(after[0].status).toBe('pending');
    // Marcar de nuevo abre otra vez la siguiente.
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect((await all()).length).toBe(2);
  });

  it('repetible: no se puede desmarcar una vez anterior si ya hizo otra después', async () => {
    const t = await mkTask({ repeatable: true, maxPerDay: 3, requiresApproval: false });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    const second = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.task_id === t.taskId && i.repeat_no === 2);
    await F.luciaC.post(`/api/instances/${second.id}/complete`);
    expect((await unmark(F.luciaC, t.id)).body.error).toBe('later_repeat_done');
    expect((await unmark(F.luciaC, second.id)).status).toBe(200);
    expect((await unmark(F.luciaC, t.id)).status).toBe(200);
  });

  it('trabajo extra: vuelve a estar reservado por ese hijo; si ya se había aprobado sola y se republicó, no', async () => {
    const e = (await F.mama.post('/api/extras', { title: 'Lavar el coche', points: 12, requiresApproval: false })).body.id;
    const act = (await F.mama.post(`/api/extras/${e}/activate`, {})).body.id;
    await F.luciaC.post(`/api/extra-instances/${act}/claim`);
    await F.luciaC.post(`/api/instances/${act}/complete`);
    expect(await pts(F.ids.lucia)).toBe(12);
    // Aprobada sola: ya no está en el tablón; republicarla impide desmarcar.
    await F.mama.post(`/api/extras/${e}/activate`, {});
    expect((await unmark(F.luciaC, act)).body.error).toBe('reactivated');
    const e2 = (await F.mama.post('/api/extras', { title: 'Regar', points: 5, requiresApproval: true })).body.id;
    const act2 = (await F.mama.post(`/api/extras/${e2}/activate`, {})).body.id;
    await F.luciaC.post(`/api/extra-instances/${act2}/claim`);
    await F.luciaC.post(`/api/instances/${act2}/complete`);
    expect((await F.luciaC.get('/api/extras')).body.board.find((b: any) => b.id === act2)).toMatchObject({ status: 'submitted', can_unmark: true });
    await unmark(F.luciaC, act2);
    const back = (await F.hugoC.get('/api/extras')).body.board.find((b: any) => b.id === act2);
    expect(back).toMatchObject({ status: 'pending', assignee_id: F.ids.lucia });
    expect((await F.hugoC.post(`/api/extra-instances/${act2}/claim`)).status).toBe(409); // sigue reservada por Lucía
  });

  it('extra con «forma de recuperar» auto-aprobada: al desmarcar se deshace la recuperación', async () => {
    await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 60, note: 'regalo' });
    const e = (await F.mama.post('/api/extras', { title: 'Barrer', points: 3, requiresApproval: false })).body.id;
    const reasons = (await F.mama.get('/api/screen/reasons')).body.reasons;
    await F.mama.post('/api/screen/adjustments', { userId: F.ids.lucia, reasonId: reasons[0].id, effect: 'minutes', minutes: 30, recoveryTaskId: e });
    expect(await mins(F.ids.lucia)).toBe(30);
    const inst = (await F.luciaC.get('/api/extras')).body.board.find((b: any) => b.task_id === e);
    await F.luciaC.post(`/api/instances/${inst.id}/complete`);
    expect(await mins(F.ids.lucia)).toBe(60);
    await unmark(F.luciaC, inst.id);
    expect(await mins(F.ids.lucia)).toBe(30);
    expect(await one(pool(), 'SELECT status FROM screen_adjustments WHERE user_id = $1', [F.ids.lucia])).toMatchObject({ status: 'active' });
    // Al hacerlo otra vez, se recupera de nuevo.
    await F.luciaC.post(`/api/instances/${inst.id}/complete`);
    expect(await mins(F.ids.lucia)).toBe(60);
    const sum = (await one(pool(), 'SELECT COALESCE(SUM(remaining),0)::int AS s FROM screen_lots WHERE user_id = $1', [F.ids.lucia]))!.s;
    expect(sum).toBe(60);
  });

  it('devuelta por un adulto: al desmarcar el reenvío vuelve a «devuelta» y conserva la primera hora de envío', async () => {
    const t = await mkTask({ dueTime: '09:00', dueTimeWeekend: '09:00', latePercent: 50 });
    await completeInstance(lucia(), t.id, { now: at('08:30') });
    await F.mama.post(`/api/instances/${t.id}/review`, { action: 'return', note: 'Falta un poco' });
    await completeInstance(lucia(), t.id, { now: at('13:00') });
    expect((await instRow(t.id)).review_note).toBeNull();
    expect((await unmarkInstance(lucia(), t.id, { now: at('13:05') })).status).toBe('rejected');
    const mine = (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.id === t.id);
    expect(mine).toMatchObject({ status: 'rejected', review_outcome: 'returned', review_note: 'Falta un poco' });
    expect((await instRow(t.id)).first_submitted_at.toISOString()).toBe(at('08:30').toISOString());
    // Si vuelve a enviarla, sigue a tiempo (la primera vez fue a tiempo).
    expect(await completeInstance(lucia(), t.id, { now: at('14:00') })).toMatchObject({ onTime: true });
  });

  it('puntos de honestidad anulados también bajan los puntos de toda la vida', async () => {
    await F.mama.post('/api/screen/adjust', { userId: F.ids.lucia, delta: 60, note: 'regalo' });
    const log = (await F.luciaC.post('/api/screen-logs', { minutes: 20, category: 'tele' })).body.log;
    await F.mama.post(`/api/screen-logs/${log.id}/confirm`, {});
    expect(await lifetimePoints(pool(), F.ids.lucia)).toBe(5);
    await F.mama.post(`/api/screen-logs/${log.id}/void`, {});
    expect(await pts(F.ids.lucia)).toBe(0);
    expect(await lifetimePoints(pool(), F.ids.lucia)).toBe(0);
  });
});

describe('Desmarcar retira las insignias que ya no se cumplen (D55)', () => {
  const badges = async (u: string) => (await many(pool(), 'SELECT badge FROM user_badges WHERE user_id = $1 ORDER BY badge', [u])).map((r) => r.badge as string);

  it('la insignia que dio esa tarea se retira, con su aviso, y vuelve a darse al volver a marcarla', async () => {
    const t = await mkTask({ requiresApproval: false });
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect(await badges(F.ids.lucia)).toContain('first_task');
    const notes = async () => (await many(pool(), `SELECT title FROM notifications WHERE user_id = $1 AND title LIKE '%Nueva insignia%'`, [F.ids.lucia])).length;
    expect(await notes()).toBe(1);
    const r = await unmark(F.luciaC, t.id);
    expect(r.body.badgesRevoked).toContain('first_task');
    expect(await badges(F.ids.lucia)).not.toContain('first_task');
    expect(await notes()).toBe(0);
    const a = await one(pool(), `SELECT data FROM audit_log WHERE action = 'task.unmark' AND entity_id = $1`, [t.id]);
    expect(a!.data.badgesRevoked).toContain('first_task');
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect(await badges(F.ids.lucia)).toContain('first_task');
    expect(await notes()).toBe(1);
  });

  it('una insignia ganada antes con otra tarea no se toca', async () => {
    const a = await mkTask({ title: 'Primera', requiresApproval: false });
    await F.luciaC.post(`/api/instances/${a.id}/complete`);
    const b = await mkTask({ title: 'Segunda', requiresApproval: false });
    await F.luciaC.post(`/api/instances/${b.id}/complete`);
    await unmark(F.luciaC, b.id);
    expect(await badges(F.ids.lucia)).toContain('first_task');
  });

  it('si otra tarea sigue sosteniéndola, se queda; y las que no vienen de tareas (canje, ahorro) nunca se retiran', async () => {
    const a = await mkTask({ title: 'Primera', requiresApproval: false });
    const b = await mkTask({ title: 'Segunda', requiresApproval: false });
    // Las dos se marcan «a la vez» (misma pasada): la insignia queda atribuida a la primera que la cumplió.
    await F.luciaC.post(`/api/instances/${b.id}/complete`);
    await F.luciaC.post(`/api/instances/${a.id}/complete`);
    await unmark(F.luciaC, b.id); // b la dio; sin b sigue habiendo una tarea aprobada
    expect(await badges(F.ids.lucia)).toContain('first_task');
    // Una insignia ficticia sin relación con tareas y atribuida a la instancia no se retira.
    await pool().query(`INSERT INTO user_badges(user_id, badge, source_instance_id) VALUES ($1,'saver',$2)`, [F.ids.lucia, a.id]);
    await unmark(F.luciaC, a.id);
    expect(await badges(F.ids.lucia)).toContain('saver');
    expect(await badges(F.ids.lucia)).not.toContain('first_task');
  });

  it('con validación de un adulto: la insignia llega al validar, y desmarcar antes de validar no concede nada', async () => {
    const t = await mkTask();
    await F.luciaC.post(`/api/instances/${t.id}/complete`);
    expect(await badges(F.ids.lucia)).toEqual([]);
    await unmark(F.luciaC, t.id);
    expect(await badges(F.ids.lucia)).toEqual([]);
  });
});
