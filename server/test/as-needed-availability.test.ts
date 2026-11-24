import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool } from '../src/lib/db.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const today = () => todayIn('Europe/Madrid');

beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); await closePool(); });
beforeEach(async () => { resetLoginFailures(); await resetDb(); F = await createFamily(app); });

const mk = async (over: Record<string, unknown> = {}) => {
  const r = await F.mama.post('/api/tasks', { title: 'Descargar el lavavajillas', points: 10, recurrence: 'as_needed', startDate: today(), assignees: [F.ids.lucia, F.ids.hugo], ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.task;
};
const openToday = async (taskId: string) =>
  ((await F.luciaC.get(`/api/instances?from=${today()}&to=${today()}`)).body.instances as any[]).filter((i) => i.task_id === taskId && i.status === 'pending');

describe('Activar y pausar «cuando haga falta»', () => {
  it('pausar la quita de hoy; activar por 3 días la devuelve y fija el fin', async () => {
    const t = await mk();
    expect(await openToday(t.id)).toHaveLength(1);

    const p = await F.mama.post(`/api/tasks/${t.id}/availability`, { pause: true });
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.task.end_date).toBe(addDays(today(), -1));
    expect(await openToday(t.id)).toHaveLength(0);

    const a = await F.mama.post(`/api/tasks/${t.id}/availability`, { days: 3 });
    expect(a.status).toBe(200);
    expect(a.body.task.start_date).toBe(today());
    expect(a.body.task.end_date).toBe(addDays(today(), 2));
    expect(await openToday(t.id)).toHaveLength(1);

    const s = await F.mama.post(`/api/tasks/${t.id}/availability`, { days: null });
    expect(s.body.task.end_date).toBeNull();
  });

  it('al activarla se avisa a los hijos animando a ser el primero; pausar o cambiar el plazo no avisa', async () => {
    const t = await mk({ points: 20 });
    await F.mama.post(`/api/tasks/${t.id}/availability`, { pause: true });
    const notes = async () => ((await F.luciaC.get('/api/notifications')).body.notifications as any[]).filter((n) => n.kind === 'task_available');
    expect(await notes()).toHaveLength(0);
    await F.mama.post(`/api/tasks/${t.id}/availability`, { days: 3 });
    const [n] = await notes();
    expect(n.title).toBe('¡Toca «Descargar el lavavajillas»!');
    expect(n.body).toBe('El primero que la haga se lleva +20 puntos para su paga. ¡A por ella!');
    expect(((await F.hugoC.get('/api/notifications')).body.notifications as any[]).some((x) => x.kind === 'task_available')).toBe(true);
    // Ya activa: cambiar el plazo no vuelve a avisar
    await F.mama.post(`/api/tasks/${t.id}/availability`, { days: 7 });
    expect(await notes()).toHaveLength(1);
  });

  it('si ya la hicieron hoy, pausar no borra lo hecho', async () => {
    const t = await mk();
    const [i] = await openToday(t.id);
    expect((await F.luciaC.post(`/api/instances/${i.id}/complete`)).status).toBe(200);
    expect((await F.mama.post(`/api/tasks/${t.id}/availability`, { pause: true })).status).toBe(200);
    const all = (await F.luciaC.get(`/api/instances?from=${today()}&to=${today()}`)).body.instances.filter((x: any) => x.task_id === t.id);
    expect(all).toHaveLength(1);
    expect(all[0].status).not.toBe('pending');
  });

  it('solo adultos y solo tareas «cuando haga falta»', async () => {
    const t = await mk();
    expect((await F.luciaC.post(`/api/tasks/${t.id}/availability`, { pause: true })).status).toBe(403);
    const d = await mk({ recurrence: 'daily', assignees: [F.ids.lucia] });
    const r = await F.mama.post(`/api/tasks/${d.id}/availability`, { pause: true });
    expect(r.status).toBe(400);
    expect((await F.mama.post(`/api/tasks/${t.id}/availability`, { days: 0 })).status).toBe(400);
  });
});
