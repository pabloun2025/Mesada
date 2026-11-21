import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool } from '../src/lib/db.js';
import { todayIn } from '../src/lib/dates.js';
import { MockProvider, setProviders } from '../src/lib/notify/providers.js';
import { processOutbox } from '../src/lib/notify/worker.js';
import { scheduleReminders } from '../src/lib/notify/reminders.js';
import { channelBlockReason, minAge } from '../src/lib/notify/dispatch.js';
import { inQuietHours, nextAllowedTime, zonedToUtc } from '../src/lib/notify/time.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { Client, createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
let email: MockProvider;
let whatsapp: MockProvider;
const today = () => todayIn('Europe/Madrid');
const outbox = async () => (await getPool().query('SELECT * FROM notification_outbox ORDER BY created_at')).rows;

beforeAll(async () => {
  app = await buildApp({ logger: false });
});
afterAll(async () => {
  setProviders(null);
  await app.close();
  await closePool();
});
beforeEach(async () => {
  resetLoginFailures();
  delete process.env.NOTIFY_EMAIL_MONTHLY_CAP;
  email = new MockProvider('email');
  whatsapp = new MockProvider('whatsapp');
  setProviders({ email, whatsapp });
  await resetDb();
  F = await createFamily(app);
  // Sin horario de silencio, para que las pruebas no dependan de la hora.
  await F.mama.put('/api/notify/family', { quietStart: '00:00', quietEnd: '00:00', reminderTime: '00:00', dueSoonMinutes: 60 });
  // Lucía tiene 14 años (año 2012 en el helper); Hugo pasa a tener 11.
  await getPool().query('UPDATE users SET birth_year = 2015 WHERE id = $1', [F.ids.hugo]);
  for (const [id, tel] of [[F.ids.lucia, '+34600000001'], [F.ids.hugo, '+34600000002'], [F.ids.mama, '+34600000003']]) {
    const r = await F.mama.put(`/api/notify/contact/${id}`, { email: id === F.ids.mama ? 'mama@example.com' : null, phone: tel, whatsappConsent: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  }
});

async function taskFor(userId: string) {
  const t = (await F.mama.post('/api/tasks', { title: 'Sacar la basura', points: 15, recurrence: 'daily', startDate: today(), assignees: [userId] })).body.task;
  return t;
}

describe('utilidades de horario y elegibilidad', () => {
  it('horario de silencio que cruza la medianoche', () => {
    expect(inQuietHours(23 * 60, 21 * 60 + 30, 8 * 60)).toBe(true);
    expect(inQuietHours(7 * 60, 21 * 60 + 30, 8 * 60)).toBe(true);
    expect(inQuietHours(12 * 60, 21 * 60 + 30, 8 * 60)).toBe(false);
    expect(inQuietHours(12 * 60, 0, 0)).toBe(false);
  });
  it('aplaza al final del silencio en hora de Madrid', () => {
    const now = new Date('2026-11-20T22:30:00Z'); // 23:30 en Madrid
    expect(nextAllowedTime(now, 'Europe/Madrid', '21:30', '08:00').toISOString()).toBe('2026-11-21T07:00:00.000Z');
    const day = new Date('2026-11-20T11:00:00Z');
    expect(nextAllowedTime(day, 'Europe/Madrid', '21:30', '08:00')).toBe(day);
  });
  it('convierte hora civil a UTC con cambio de hora', () => {
    expect(zonedToUtc('2026-07-01', '08:00', 'Europe/Madrid').toISOString()).toBe('2026-07-01T06:00:00.000Z');
    expect(zonedToUtc('2026-12-01', '08:00', 'Europe/Madrid').toISOString()).toBe('2026-12-01T07:00:00.000Z');
  });
  it('WhatsApp solo con teléfono, consentimiento y 13 años como mínimo', () => {
    const base = { role: 'child' as const, email: null, phone: '+34600000000', whatsapp_consent_at: '2026-01-01', birth_year: 2012 };
    expect(minAge(2012, new Date('2026-06-01'))).toBe(13);
    expect(channelBlockReason(base, 'whatsapp')).toBeNull();
    expect(channelBlockReason({ ...base, birth_year: 2015 }, 'whatsapp')).toMatch(/13 años/);
    expect(channelBlockReason({ ...base, birth_year: null }, 'whatsapp')).toMatch(/año de nacimiento/);
    expect(channelBlockReason({ ...base, whatsapp_consent_at: null }, 'whatsapp')).toMatch(/consentimiento/);
    expect(channelBlockReason({ ...base, role: 'adult', birth_year: null }, 'whatsapp')).toBeNull();
    expect(channelBlockReason(base, 'email')).toBe('Sin correo');
  });
});

describe('envío por la cola', () => {
  it('un rechazo avisa por WhatsApp al hijo y el worker lo envía una sola vez', async () => {
    await taskFor(F.ids.lucia);
    const [inst] = (await F.luciaC.get('/api/instances')).body.instances;
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: false, note: 'Falta la del baño' });
    const pending = (await outbox()).filter((o) => o.event === 'task_rejected');
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ channel: 'whatsapp', to_address: '+34600000001', status: 'pending' });
    await processOutbox();
    await processOutbox();
    expect(whatsapp.sent.filter((m) => m.subject.includes('repaso'))).toHaveLength(1);
    expect((await outbox()).find((o) => o.event === 'task_rejected').status).toBe('sent');
  });

  it('el envío para validar llega a los adultos con WhatsApp', async () => {
    await taskFor(F.ids.lucia);
    const [inst] = (await F.luciaC.get('/api/instances')).body.instances;
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    const rows = (await outbox()).filter((o) => o.event === 'task_submitted');
    expect(rows.map((r) => r.to_address)).toEqual(['+34600000003']); // papá no tiene teléfono
  });

  it('un menor de 13 años nunca recibe WhatsApp aunque se active', async () => {
    const r = await F.mama.put(`/api/notify/prefs/${F.ids.hugo}`, { prefs: [{ event: 'task_rejected', channel: 'whatsapp', enabled: true }] });
    expect(r.status).toBe(200);
    await taskFor(F.ids.hugo);
    const [inst] = (await F.hugoC.get('/api/instances')).body.instances;
    await F.hugoC.post(`/api/instances/${inst.id}/complete`, {});
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: false });
    expect((await outbox()).filter((o) => o.user_id === F.ids.hugo)).toHaveLength(0);
    // Pero sí el aviso en la aplicación
    expect((await F.hugoC.get('/api/notifications')).body.notifications.some((n: any) => n.kind === 'task_rejected')).toBe(true);
    const s = (await F.mama.get('/api/notify/settings')).body.members.find((m: any) => m.id === F.ids.hugo);
    expect(s.blocked.whatsapp).toMatch(/13 años/);
  });

  it('los padres desactivan un canal y deja de enviarse', async () => {
    await F.mama.put(`/api/notify/prefs/${F.ids.lucia}`, { prefs: [{ event: 'task_rejected', channel: 'whatsapp', enabled: false }] });
    await taskFor(F.ids.lucia);
    const [inst] = (await F.luciaC.get('/api/instances')).body.instances;
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: false });
    expect((await outbox()).filter((o) => o.event === 'task_rejected')).toHaveLength(0);
  });

  it('los recordatorios no se duplican', async () => {
    await taskFor(F.ids.lucia);
    await scheduleReminders(getPool(), F.ids.family);
    await scheduleReminders(getPool(), F.ids.family);
    expect((await outbox()).filter((o) => o.event === 'task_reminder')).toHaveLength(1);
    const inApp = (await F.luciaC.get('/api/notifications')).body.notifications.filter((n: any) => n.kind === 'task_reminder');
    expect(inApp).toHaveLength(1);
  });

  it('el horario de silencio aplaza el envío', async () => {
    await F.mama.put('/api/notify/family', { quietStart: '00:00', quietEnd: '23:59', reminderTime: '00:00', dueSoonMinutes: 60 });
    await taskFor(F.ids.lucia);
    await scheduleReminders(getPool(), F.ids.family);
    const [row] = (await outbox()).filter((o) => o.event === 'task_reminder');
    expect(new Date(row.not_before).getTime()).toBeGreaterThan(Date.now());
    await processOutbox();
    expect(whatsapp.sent).toHaveLength(0);
  });

  it('una acción que falla no deja avisos (outbox transaccional)', async () => {
    await taskFor(F.ids.lucia);
    const [inst] = (await F.luciaC.get('/api/instances')).body.instances;
    await F.luciaC.post(`/api/instances/${inst.id}/complete`, {});
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true });
    const before = (await outbox()).length;
    expect((await F.papaC.post(`/api/instances/${inst.id}/review`, { approve: true })).status).toBe(409);
    expect((await outbox()).length).toBe(before);
  });

  it('fallo temporal se reintenta; resultado incierto no se reintenta', async () => {
    await taskFor(F.ids.lucia);
    await scheduleReminders(getPool(), F.ids.family);
    whatsapp.failNext = { ok: false, retryable: true, error: 'Evolution 503' };
    await processOutbox();
    let [row] = (await outbox()).filter((o) => o.event === 'task_reminder');
    expect(row).toMatchObject({ status: 'pending', attempts: 1, last_error: 'Evolution 503' });
    expect(new Date(row.not_before).getTime()).toBeGreaterThan(Date.now());
    await getPool().query('UPDATE notification_outbox SET not_before = now()');
    whatsapp.failNext = { ok: false, retryable: false, uncertain: true, error: 'sin respuesta' };
    await processOutbox();
    [row] = (await outbox()).filter((o) => o.event === 'task_reminder');
    expect(row.status).toBe('uncertain');
    await getPool().query('UPDATE notification_outbox SET not_before = now()');
    await processOutbox();
    expect(whatsapp.sent).toHaveLength(0);
  });

  it('respeta el tope mensual de correo (salvo los críticos)', async () => {
    process.env.NOTIFY_EMAIL_MONTHLY_CAP = '1';
    await F.mama.put(`/api/notify/prefs/${F.ids.mama}`, { prefs: [{ event: 'task_submitted', channel: 'email', enabled: true }] });
    await taskFor(F.ids.lucia);
    const t2 = await F.mama.post('/api/tasks', { title: 'Regar', points: 5, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia] });
    expect(t2.status).toBe(200);
    for (const i of (await F.luciaC.get('/api/instances')).body.instances) await F.luciaC.post(`/api/instances/${i.id}/complete`, {});
    await processOutbox();
    const emails = (await outbox()).filter((o) => o.channel === 'email');
    expect(emails.map((e) => e.status).sort()).toEqual(['sent', 'skipped']);
    await new Client(app).post('/api/auth/forgot', { login: 'fmama' });
    await processOutbox();
    expect((await outbox()).find((o) => o.event === 'password_reset').status).toBe('sent');
  });

  it('aviso de tarea nueva una sola vez por tarea y persona', async () => {
    await F.mama.put(`/api/notify/prefs/${F.ids.lucia}`, { prefs: [{ event: 'task_assigned', channel: 'whatsapp', enabled: true }] });
    const t = await taskFor(F.ids.lucia);
    await F.mama.put(`/api/tasks/${t.id}`, { title: 'Sacar la basura', points: 20, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia] });
    expect((await outbox()).filter((o) => o.event === 'task_assigned')).toHaveLength(1);
  });
});

describe('permisos de preferencias', () => {
  it('un hijo no cambia sus avisos ni sus datos de contacto', async () => {
    expect((await F.luciaC.put(`/api/notify/prefs/${F.ids.lucia}`, { prefs: [] })).status).toBe(403);
    expect((await F.luciaC.put(`/api/notify/contact/${F.ids.lucia}`, { email: null, phone: null, whatsappConsent: false })).status).toBe(403);
    const s = (await F.luciaC.get('/api/notify/settings')).body;
    expect(s.members).toHaveLength(1);
    expect(s.members[0].editable).toBe(false);
  });
  it('un adulto no cambia los avisos de otro adulto', async () => {
    expect((await F.mama.put(`/api/notify/prefs/${F.ids.papa}`, { prefs: [] })).status).toBe(403);
  });
  it('rechaza teléfonos inválidos y normaliza los españoles', async () => {
    expect((await F.mama.put(`/api/notify/contact/${F.ids.lucia}`, { email: null, phone: '12', whatsappConsent: true })).status).toBe(400);
    await F.mama.put(`/api/notify/contact/${F.ids.lucia}`, { email: null, phone: '600 11 22 33', whatsappConsent: true });
    expect((await getPool().query('SELECT phone FROM users WHERE id = $1', [F.ids.lucia])).rows[0].phone).toBe('+34600112233');
  });
});

describe('recuperación de contraseña e invitaciones por correo', () => {
  const tokenFrom = (link?: string | null) => new URL(link!, 'http://x').searchParams.get('token')!;

  it('recupera la contraseña con un enlace de un solo uso', async () => {
    const anon = new Client(app);
    const r = await anon.post('/api/auth/forgot', { login: 'mama@example.com' });
    expect(r.body.ok).toBe(true);
    const unknown = await anon.post('/api/auth/forgot', { login: 'nadie' });
    expect(unknown.body).toEqual(r.body);
    await processOutbox();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('mama@example.com');
    const token = tokenFrom(email.sent[0].link);
    expect((await anon.post('/api/auth/reset', { token, password: 'nueva-contrasena' })).status).toBe(200);
    expect((await F.mama.get('/api/me')).status).toBe(401); // sesiones cerradas
    expect((await anon.post('/api/auth/reset', { token, password: 'otra-contrasena' })).status).toBe(400);
    expect((await new Client(app).post('/api/auth/login', { username: 'fmama', password: 'nueva-contrasena' })).status).toBe(200);
  });

  it('los hijos no recuperan por correo (lo hace un adulto)', async () => {
    await new Client(app).post('/api/auth/forgot', { login: 'flucia' });
    expect((await outbox()).filter((o) => o.event === 'password_reset')).toHaveLength(0);
  });

  it('invita a otro adulto por correo y la invitación solo sirve una vez', async () => {
    expect((await F.luciaC.post('/api/invitations', { email: 'abuela@example.com', displayName: 'Abuela' })).status).toBe(403);
    expect((await F.mama.post('/api/invitations', { email: 'abuela@example.com', displayName: 'Abuela' })).status).toBe(200);
    await processOutbox();
    const token = tokenFrom(email.sent.at(-1)!.link);
    const anon = new Client(app);
    expect((await anon.post('/api/invitations/lookup', { token })).body.invitation).toMatchObject({ display_name: 'Abuela', family_name: 'Familia f' });
    const acc = await anon.post('/api/invitations/accept', { token, username: 'abuela', password: 'contrasena-abuela' });
    expect(acc.status, JSON.stringify(acc.body)).toBe(200);
    expect(acc.body.user).toMatchObject({ role: 'adult', family_id: F.ids.family });
    expect((await anon.get('/api/me')).status).toBe(200);
    expect((await new Client(app).post('/api/invitations/accept', { token, username: 'otra', password: 'contrasena-larga' })).status).toBe(404);
  });
});
