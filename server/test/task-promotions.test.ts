import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many } from '../src/lib/db.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import { pointsBalance } from '../src/lib/ledger.js';
import { zonedToUtc } from '../src/lib/notify/time.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const today = () => todayIn('Europe/Madrid');

beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); await closePool(); });
beforeEach(async () => { resetLoginFailures(); await resetDb(); F = await createFamily(app); });

async function task(title: string, over: Record<string, unknown> = {}) {
  const r = await F.mama.post('/api/tasks', {
    title, recurrence: 'as_needed', points: 10, startDate: addDays(today(), -7), assignees: [F.ids.lucia, F.ids.hugo], ...over,
  });
  expect(r.status).toBe(200);
  return r.body.task.id as string;
}
const activate = (id: string, percentage = 30) => F.mama.post(`/api/tasks/${id}/promotion`, { percentage });
async function occurrence(taskId: string) {
  const { instances } = (await F.mama.get('/api/instances')).body;
  return (instances.find((i: any) => i.task_id === taskId)).id as string;
}

describe('sugerencias y promoción de tarea opcional', () => {
  it('sugiere al séptimo día solo tareas disponibles para el hijo', async () => {
    const eligible = await task('Regar las plantas', { assignees: [F.ids.lucia] });
    await task('Ordenar juegos', { startDate: addDays(today(), -6) });
    await task('Revisar tornillos', { endDate: addDays(today(), -1) });
    await task('Lavar los platos', { recurrence: 'daily' });
    const done = await task('Doblar la manta');
    await getPool().query(`INSERT INTO task_instances (task_id, family_id, due_date, points, status, completed_by, completed_at)
      VALUES ($1,$2,$3,10,'approved',$4,now() - interval '1 day')`, [done, F.ids.family, addDays(today(), -1), F.ids.hugo]);
    const result = await F.luciaC.get('/api/task-suggestions');
    expect(result.status).toBe(200);
    expect(result.body.suggestions).toMatchObject([{ task_id: eligible, base_points: 10 }]);
    expect((await F.hugoC.get('/api/task-suggestions')).body.suggestions).toEqual([]);
    expect((await F.luciaC.post(`/api/tasks/${eligible}/promotion`, { percentage: 30 })).status).toBe(403);
    expect((await activate(done)).status).toBe(409);
  });

  it('reserva el extra una vez en una compartida y conserva el importe al validar después del vencimiento', async () => {
    const id = await task('Aspirar el sofá');
    const offer = await activate(id);
    expect(offer).toMatchObject({ status: 200, body: { promotion: { base_points: 10, percentage: 30, extra_points: 3 } } });
    expect((await activate(id, 50)).status).toBe(409);
    const instanceId = await occurrence(id);
    const claims = await Promise.all([F.luciaC, F.hugoC].map((child) => child.post(`/api/instances/${instanceId}/complete`)));
    expect(claims.map((r) => r.status).sort()).toEqual([200, 409]);
    const beneficiary = claims[0].status === 200 ? F.ids.lucia : F.ids.hugo;
    await getPool().query(`UPDATE task_promotions SET expires_at = now() - interval '1 second' WHERE task_id = $1`, [id]);
    const approved = await F.mama.post(`/api/instances/${instanceId}/review`, { action: 'approve' });
    expect(approved.status).toBe(200);
    expect(await pointsBalance(getPool(), beneficiary)).toBe(13);
    expect(await many(getPool(), 'SELECT delta FROM points_ledger WHERE user_id = $1 ORDER BY seq', [beneficiary])).toEqual([{ delta: 10 }, { delta: 3 }]);
    expect((await F.papaC.post(`/api/instances/${instanceId}/review`, { action: 'approve' })).status).toBe(409);
  });

  it('compensa el extra al desmarcar y permite una nueva entrega ese mismo día', async () => {
    const taskId = await task('Doblar la ropa', { requiresApproval: false });
    expect((await activate(taskId, 50)).status).toBe(200);
    const id = await occurrence(taskId);
    expect((await F.luciaC.post(`/api/instances/${id}/complete`)).body.points).toBe(15);
    expect((await F.luciaC.post(`/api/instances/${id}/unmark`)).body.pointsBack).toBe(15);
    expect(await pointsBalance(getPool(), F.ids.lucia)).toBe(0);
    expect((await F.hugoC.post(`/api/instances/${id}/complete`)).body.points).toBe(15);
    expect(await pointsBalance(getPool(), F.ids.hugo)).toBe(15);
  });

  it('no premia una aprobación parcial ni una realización anterior a la promoción', async () => {
    const partial = await task('Limpiar la mesa');
    expect((await activate(partial)).status).toBe(200);
    const i = await occurrence(partial);
    expect((await F.luciaC.post(`/api/instances/${i}/complete`)).status).toBe(200);
    expect((await F.mama.post(`/api/instances/${i}/review`, { action: 'partial', points: 5, note: 'Solo limpió la mitad' })).status).toBe(200);
    const earlier = await task('Recoger la manta');
    expect((await activate(earlier)).status).toBe(200);
    const e = await occurrence(earlier);
    expect((await F.mama.post(`/api/instances/${e}/register`, { childId: F.ids.hugo, completedTime: '00:00' })).status).toBe(200);
    expect(await pointsBalance(getPool(), F.ids.lucia)).toBe(5);
    expect(await pointsBalance(getPool(), F.ids.hugo)).toBe(10);
  });

  it('no empieza una nueva reserva después de que caduque la promoción, aunque la tarea se hiciera antes', async () => {
    const taskId = await task('Recoger la terraza');
    expect((await activate(taskId)).status).toBe(200);
    const id = await occurrence(taskId);
    const yesterday = addDays(today(), -1);
    await getPool().query('UPDATE task_instances SET due_date = $2 WHERE id = $1', [id, yesterday]);
    await getPool().query('UPDATE task_promotions SET day = $2, activated_at = $3, expires_at = $4 WHERE task_id = $1',
      [taskId, yesterday, zonedToUtc(yesterday, '11:00', 'Europe/Madrid'), zonedToUtc(today(), '00:00', 'Europe/Madrid')]);
    expect((await F.mama.post(`/api/instances/${id}/register`, { childId: F.ids.lucia, completedTime: '12:00' })).status).toBe(200);
    expect(await pointsBalance(getPool(), F.ids.lucia)).toBe(10);
  });

  it('mantiene la ocurrencia y los puntos prometidos al corregir el título o el valor normal', async () => {
    const taskId = await task('Limpiar el patio', { requiresApproval: false });
    expect((await activate(taskId)).status).toBe(200);
    const id = await occurrence(taskId);
    expect((await F.mama.put(`/api/tasks/${taskId}`, {
      title: 'Limpiar todo el patio', description: 'También el rincón', recurrence: 'as_needed', points: 20, startDate: addDays(today(), -7),
      assignees: [F.ids.lucia, F.ids.hugo], requiresApproval: false,
    })).status).toBe(200);
    expect(await occurrence(taskId)).toBe(id);
    expect((await F.luciaC.post(`/api/instances/${id}/complete`)).body.points).toBe(13);
    expect((await F.luciaC.post(`/api/instances/${id}/unmark`)).body.pointsBack).toBe(13);
    expect((await F.hugoC.post(`/api/instances/${id}/complete`)).body.points).toBe(13);
  });
});
