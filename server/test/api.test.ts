import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool } from '../src/lib/db.js';
import { todayIn } from '../src/lib/dates.js';
import { LEGAL_VERSION } from '../src/lib/legal.js';
import { Client, createFamily, resetDb } from './helpers.js';
import { resetLoginFailures } from '../src/routes/auth.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const today = () => todayIn('Europe/Madrid');

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

async function createTask(over: Record<string, unknown> = {}) {
  const r = await F.mama.post('/api/tasks', {
    title: 'Poner el lavavajillas', icon: '🍽️', points: 20, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body.task;
}
async function myInstances(c: Client) {
  return (await c.get(`/api/instances?from=${today()}&to=${today()}`)).body.instances as any[];
}

describe('autenticación y roles', () => {
  it('el setup solo funciona una vez', async () => {
    const c = new Client(app);
    const r = await c.post('/api/setup', { familyName: 'Otra', displayName: 'X', username: 'intruso', password: 'contrasena-larga', email: 'x@example.com', acceptTerms: true, termsVersion: LEGAL_VERSION });
    expect(r.status).toBe(403);
  });
  it('rechaza credenciales incorrectas y peticiones sin cabecera CSRF', async () => {
    const c = new Client(app);
    expect((await c.post('/api/auth/login', { username: 'flucia', password: 'mal' })).status).toBe(401);
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'flucia', password: '1234' } });
    expect(r.statusCode).toBe(403);
  });
  it('bloquea la cuenta tras 5 PIN fallidos aunque cambie la IP, y un adulto lo desbloquea', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: `10.0.0.${i}`, headers: { 'x-mesada': '1' }, payload: { username: 'flucia', password: `000${i}` } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await new Client(app).post('/api/auth/login', { username: 'flucia', password: '1234' });
    expect(locked.status).toBe(429);
    expect(locked.body.error).toBe('locked');
    await F.mama.patch(`/api/members/${F.ids.lucia}`, { password: '4321' });
    expect((await new Client(app).post('/api/auth/login', { username: 'flucia', password: '4321' })).status).toBe(200);
  });
  it('sin sesión no hay acceso', async () => {
    expect((await new Client(app).get('/api/me')).status).toBe(401);
  });
  it('un hijo no puede crear tareas, aprobar, pagar ni ajustar puntos', async () => {
    expect((await F.luciaC.post('/api/tasks', { title: 'x', points: 1000, recurrence: 'once', startDate: today(), assignees: [F.ids.lucia] })).status).toBe(403);
    expect((await F.luciaC.post('/api/adjustments/points', { userId: F.ids.lucia, delta: 1000, note: 'hack' })).status).toBe(403);
    expect((await F.luciaC.post('/api/payments', { userId: F.ids.lucia, amountCents: 100 })).status).toBe(403);
    expect((await F.luciaC.post('/api/allowance/settle', {})).status).toBe(403);
    expect((await F.luciaC.patch('/api/family', { rateCents: 99999 })).status).toBe(403);
  });
  it('un hijo no ve los datos económicos de su hermano', async () => {
    expect((await F.luciaC.get(`/api/wallet/${F.ids.hugo}`)).status).toBe(403);
    expect((await F.luciaC.get(`/api/ledger/${F.ids.hugo}`)).status).toBe(403);
    expect((await F.luciaC.get(`/api/progress/${F.ids.hugo}`)).status).toBe(403);
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).status).toBe(200);
  });
  it('cambiar la contraseña de un hijo cierra sus sesiones', async () => {
    await F.mama.patch(`/api/members/${F.ids.lucia}`, { password: '9999' });
    expect((await F.luciaC.get('/api/me')).status).toBe(401);
  });
});

describe('aislamiento entre familias', () => {
  it('una familia no puede ver ni tocar datos de otra', async () => {
    process.env.ALLOW_REGISTRATION = 'true';
    const { config } = await import('../src/lib/config.js');
    config.allowRegistration = true;
    const G = await createFamily(app, 'g');
    config.allowRegistration = false;
    const task = await createTask();
    const inst = (await myInstances(F.luciaC))[0];
    expect((await G.mama.post(`/api/instances/${inst.id}/review`, { approve: true })).status).toBe(404);
    expect((await G.luciaC.post(`/api/instances/${inst.id}/complete`, {})).status).toBe(404);
    expect((await G.mama.get(`/api/wallet/${F.ids.lucia}`)).status).toBe(404);
    expect((await G.mama.put(`/api/tasks/${task.id}`, { title: 'x', points: 1, recurrence: 'once', startDate: today(), assignees: [G.ids.lucia] })).status).toBe(404);
    expect((await G.mama.post('/api/payments', { userId: F.ids.lucia, amountCents: 100 })).status).toBe(404);
    expect((await G.mama.post('/api/tasks', { title: 'x', points: 1, recurrence: 'once', startDate: today(), assignees: [F.ids.lucia] })).status).toBe(400);
    const tasksG = (await G.mama.get('/api/tasks')).body.tasks;
    expect(tasksG).toHaveLength(0);
  });
});

describe('tareas y aprobaciones', () => {
  it('flujo completo: hijo marca, adulto aprueba, se acreditan los puntos una sola vez', async () => {
    await createTask();
    const [inst] = await myInstances(F.luciaC);
    expect(inst.status).toBe('pending');
    const done = await F.luciaC.post(`/api/instances/${inst.id}/complete`, { note: 'Hecho' });
    expect(done.body.status).toBe('submitted');
    // Marcar dos veces no duplica
    expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`, {})).status).toBe(409);
    // Aún no hay puntos
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(0);
    // Hugo no puede marcar la tarea de Lucía
    expect((await F.hugoC.post(`/api/instances/${inst.id}/complete`, {})).status).toBe(403);
    const ok = await F.papaC.post(`/api/instances/${inst.id}/review`, { approve: true });
    expect(ok.body.status).toBe('approved');
    // Aprobación duplicada (otro adulto a la vez) se rechaza
    expect((await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true })).status).toBe(409);
    const w = (await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet;
    expect(w.points_available).toBe(20);
    expect(w.points_lifetime).toBe(20);
    const badges = (await F.luciaC.get(`/api/progress/${F.ids.lucia}`)).body.badges;
    expect(badges.find((b: any) => b.key === 'first_task').awardedAt).not.toBeNull();
  });

  it('aprobaciones concurrentes no duplican puntos', async () => {
    await createTask();
    const [inst] = await myInstances(F.luciaC);
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    const rs = await Promise.all([
      F.mama.post(`/api/instances/${inst.id}/review`, { approve: true }),
      F.papaC.post(`/api/instances/${inst.id}/review`, { approve: true }),
      F.mama.post(`/api/instances/${inst.id}/review`, { approve: true }),
    ]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await F.mama.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(20);
  });

  it('rechazo con nota y reenvío', async () => {
    await createTask();
    const [inst] = await myInstances(F.luciaC);
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: false, note: 'Faltan los vasos' });
    const [again] = await myInstances(F.luciaC);
    expect(again).toMatchObject({ status: 'rejected', review_note: 'Faltan los vasos' });
    expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`, {})).body.status).toBe('submitted');
  });

  it('el adulto puede ajustar los puntos al aprobar', async () => {
    await createTask();
    const [inst] = await myInstances(F.luciaC);
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true, points: 30 });
    expect((await F.mama.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(30);
  });

  it('sin validación parental se acredita al instante', async () => {
    await createTask({ requiresApproval: false });
    const [inst] = await myInstances(F.luciaC);
    expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`, {})).body.status).toBe('approved');
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(20);
  });

  it('exige foto cuando la tarea lo requiere', async () => {
    await createTask({ requiresPhoto: true });
    const [inst] = await myInstances(F.luciaC);
    expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`, {})).body.error).toBe('photo_required');
  });

  it('compartida: la primera persona en hacerla se lleva los puntos', async () => {
    await createTask({ assignmentMode: 'shared', assignees: [F.ids.lucia, F.ids.hugo] });
    const [instL] = await myInstances(F.luciaC);
    const [instH] = await myInstances(F.hugoC);
    expect(instL.id).toBe(instH.id);
    await F.hugoC.post(`/api/instances/${instH.id}/complete`, {});
    expect((await F.luciaC.post(`/api/instances/${instL.id}/complete`, {})).status).toBe(409);
    await F.mama.post(`/api/instances/${instH.id}/review`, { approve: true });
    expect((await F.mama.get(`/api/wallet/${F.ids.hugo}`)).body.wallet.points_available).toBe(20);
    expect((await F.mama.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(0);
  });

  it('individual para dos hijos crea una ocurrencia para cada uno', async () => {
    await createTask({ assignees: [F.ids.lucia, F.ids.hugo] });
    expect(await myInstances(F.luciaC)).toHaveLength(1);
    expect(await myInstances(F.hugoC)).toHaveLength(1);
  });

  it('rotación alterna entre hermanos día a día', async () => {
    const t = await createTask({ assignmentMode: 'rotation', assignees: [F.ids.lucia, F.ids.hugo] });
    const rows = (await getPool().query('SELECT assignee_id, due_date FROM task_instances WHERE task_id = $1 ORDER BY due_date LIMIT 4', [t.id])).rows;
    expect(rows.map((r) => r.assignee_id)).toEqual([F.ids.lucia, F.ids.hugo, F.ids.lucia, F.ids.hugo]);
  });

  it('no se pueden marcar tareas futuras y las pasadas pendientes vencen', async () => {
    const { addDays } = await import('../src/lib/dates.js');
    const t = await createTask({ startDate: addDays(today(), -3) });
    const fut = (await F.luciaC.get(`/api/instances?from=${addDays(today(), 1)}&to=${addDays(today(), 1)}`)).body.instances[0];
    expect((await F.luciaC.post(`/api/instances/${fut.id}/complete`, {})).body.error).toBe('not_due');
    const past = (await F.luciaC.get(`/api/instances?from=${addDays(today(), -2)}&to=${addDays(today(), -2)}`)).body.instances[0];
    expect(past.status).toBe('expired');
    expect((await F.luciaC.post(`/api/instances/${past.id}/complete`, {})).body.error).toBe('expired');
    // Un adulto sí puede darla por hecha
    expect((await F.mama.post(`/api/instances/${past.id}/review`, { approve: true })).status).toBe(200);
    expect(t.id).toBeTruthy();
  });

  it('editar una tarea regenera las ocurrencias futuras pendientes', async () => {
    const t = await createTask();
    await F.mama.put(`/api/tasks/${t.id}`, { title: 'Poner el lavavajillas', points: 50, recurrence: 'daily', startDate: today(), assignees: [F.ids.hugo] });
    expect(await myInstances(F.luciaC)).toHaveLength(0);
    const [h] = await myInstances(F.hugoC);
    expect(h.points).toBe(50);
  });
});

describe('puntos, mesada, recompensas y pagos', () => {
  async function givePoints(userId: string, pts: number) {
    const r = await F.mama.post('/api/adjustments/points', { userId, delta: pts, note: 'Prueba', bonus: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }

  it('cierre semanal convierte puntos a euros y no se puede repetir', async () => {
    await givePoints(F.ids.lucia, 230);
    const r = await F.mama.post('/api/allowance/settle', { userId: F.ids.lucia, date: today() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.results[0].settlement).toMatchObject({ points_converted: 230, cents: 1150, capped: false });
    const w = (await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet;
    expect(w).toMatchObject({ points_available: 0, cents_pending: 1150, cents_converted_total: 1150, cents_paid_total: 0 });
    expect((await F.mama.post('/api/allowance/settle', { userId: F.ids.lucia, date: today() })).status).toBe(409);
  });

  it('aplica el límite por periodo y conserva los puntos sobrantes', async () => {
    await F.mama.patch('/api/family', { capCents: 1000 });
    await givePoints(F.ids.lucia, 300); // 15 € sin límite
    const r = await F.mama.post('/api/allowance/settle', { userId: F.ids.lucia, date: today() });
    expect(r.body.results[0].settlement).toMatchObject({ points_converted: 200, cents: 1000, capped: true });
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(100);
  });

  it('tasa configurable por familia', async () => {
    await F.mama.patch('/api/family', { ratePoints: 10, rateCents: 25 });
    await givePoints(F.ids.hugo, 47);
    const r = await F.mama.post('/api/allowance/settle', { userId: F.ids.hugo, date: today() });
    expect(r.body.results[0].settlement.cents).toBe(117);
  });

  it('pagos: no superan el saldo y son idempotentes', async () => {
    await givePoints(F.ids.lucia, 200);
    await F.mama.post('/api/allowance/settle', { userId: F.ids.lucia, date: today() });
    expect((await F.mama.post('/api/payments', { userId: F.ids.lucia, amountCents: 2000 })).status).toBe(409);
    const h = { 'idempotency-key': 'pago-123456' };
    const p1 = await F.mama.post('/api/payments', { userId: F.ids.lucia, amountCents: 600, method: 'bizum' }, h);
    const p2 = await F.mama.post('/api/payments', { userId: F.ids.lucia, amountCents: 600, method: 'bizum' }, h);
    expect(p1.status).toBe(200);
    expect(p2.body.payment.duplicate).toBe(true);
    const w = (await F.mama.get(`/api/wallet/${F.ids.lucia}`)).body.wallet;
    expect(w).toMatchObject({ cents_pending: 400, cents_paid_total: 600, cents_converted_total: 1000 });
  });

  it('recompensas: reserva puntos, devolución al rechazar y sin saldo negativo', async () => {
    const reward = (await F.mama.post('/api/rewards', { title: 'Elegir la peli', icon: '🎬', costPoints: 50 })).body.reward;
    expect((await F.luciaC.post(`/api/rewards/${reward.id}/redeem`)).status).toBe(409);
    await givePoints(F.ids.lucia, 80);
    const red = (await F.luciaC.post(`/api/rewards/${reward.id}/redeem`)).body.redemption;
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(30);
    expect((await F.luciaC.post(`/api/rewards/${reward.id}/redeem`)).status).toBe(409);
    expect((await F.luciaC.post(`/api/redemptions/${red.id}/decide`, { decision: 'approved' })).status).toBe(403);
    await F.mama.post(`/api/redemptions/${red.id}/decide`, { decision: 'rejected', note: 'Hoy no' });
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(80);
    expect((await F.mama.post(`/api/redemptions/${red.id}/decide`, { decision: 'rejected' })).status).toBe(409);
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(80);
  });

  it('canjes simultáneos no dejan el saldo en negativo', async () => {
    const reward = (await F.mama.post('/api/rewards', { title: 'Helado', costPoints: 60 })).body.reward;
    await givePoints(F.ids.lucia, 100);
    const rs = await Promise.all([1, 2, 3].map(() => F.luciaC.post(`/api/rewards/${reward.id}/redeem`)));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await F.luciaC.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(40);
  });

  it('hucha: el hijo ahorra pero no puede sacar; el adulto sí', async () => {
    await givePoints(F.ids.lucia, 100);
    await F.mama.post('/api/allowance/settle', { userId: F.ids.lucia, date: today() });
    expect((await F.luciaC.post('/api/savings/transfer', { userId: F.ids.lucia, cents: 300, direction: 'to_savings' })).status).toBe(200);
    expect((await F.luciaC.post('/api/savings/transfer', { userId: F.ids.lucia, cents: 100, direction: 'from_savings' })).status).toBe(403);
    expect((await F.hugoC.post('/api/savings/transfer', { userId: F.ids.lucia, cents: 100, direction: 'to_savings' })).status).toBe(403);
    expect((await F.mama.post('/api/savings/transfer', { userId: F.ids.lucia, cents: 100, direction: 'from_savings' })).status).toBe(200);
    const w = (await F.mama.get(`/api/wallet/${F.ids.lucia}`)).body.wallet;
    expect(w).toMatchObject({ cents_pending: 300, cents_savings: 200 });
  });

  it('ajustes de puntos idempotentes, con motivo obligatorio y auditados', async () => {
    expect((await F.mama.post('/api/adjustments/points', { userId: F.ids.hugo, delta: 10, note: '' })).status).toBe(400);
    const h = { 'idempotency-key': 'ajuste-abcdef' };
    await F.mama.post('/api/adjustments/points', { userId: F.ids.hugo, delta: 10, note: 'Gracias por ayudar' }, h);
    const dup = await F.mama.post('/api/adjustments/points', { userId: F.ids.hugo, delta: 10, note: 'Gracias por ayudar' }, h);
    expect(dup.body.duplicate).toBe(true);
    expect((await F.mama.get(`/api/wallet/${F.ids.hugo}`)).body.wallet.points_available).toBe(10);
    const act = (await F.mama.get('/api/activity')).body.entries;
    expect(act.filter((a: any) => a.action === 'points.adjust')).toHaveLength(1);
    // Un hijo ve solo lo que ha hecho él: nada de los ajustes que hace un adulto.
    const own = (await F.luciaC.get('/api/activity')).body.entries;
    expect(own.some((a: any) => a.action === 'points.adjust')).toBe(false);
  });

  it('los libros de puntos y dinero son inmutables en la base de datos', async () => {
    await givePoints(F.ids.lucia, 50);
    await expect(getPool().query('UPDATE points_ledger SET delta = 5000')).rejects.toThrow(/no se pueden modificar/);
    await expect(getPool().query('DELETE FROM points_ledger')).rejects.toThrow(/no se pueden borrar/);
    await expect(getPool().query('DELETE FROM audit_log')).rejects.toThrow(/no se pueden borrar/);
    await expect(getPool().query("UPDATE audit_log SET action = 'x'")).rejects.toThrow(/no se puede modificar/);
    await getPool().query(`UPDATE points_ledger SET note = 'nota corregida'`); // metadatos sí
    expect((await F.mama.get(`/api/wallet/${F.ids.lucia}`)).body.wallet.points_available).toBe(50);
  });

  it('el panel parental resume a cada hijo', async () => {
    await createTask({ assignees: [F.ids.lucia, F.ids.hugo] });
    const [inst] = await myInstances(F.luciaC);
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    const d = (await F.mama.get('/api/dashboard')).body;
    expect(d.kids).toHaveLength(2);
    expect(d.pendingApprovals).toHaveLength(1);
    const lucia = d.kids.find((k: any) => k.id === F.ids.lucia);
    expect(lucia.today).toMatchObject({ total: 1, submitted: 1 });
    expect((await F.luciaC.get('/api/dashboard')).status).toBe(403);
  });
});
