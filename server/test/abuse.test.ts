import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, one } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { clientIp } from '../src/lib/limits.js';
import { setSetting } from '../src/lib/settings.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { consent, createFamily, resetDb, Client } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const pool = () => getPool();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const saved = { limits: { ...config.limits }, caps: { ...config.caps } };

beforeAll(async () => {
  app = await buildApp({ logger: false });
  app.get('/api/_boom', async () => {
    throw new Error('fallo secreto con datos: pablo@example.com');
  });
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
afterEach(() => {
  Object.assign(config.limits, saved.limits);
  Object.assign(config.caps, saved.caps);
  vi.restoreAllMocks();
});

const signup = (c: Client, user: string, over: Record<string, unknown> = {}) =>
  c.post('/api/setup', { familyName: 'Otra', displayName: 'X', username: user, password: 'contrasena-larga', email: `${user}@example.com`, ...consent, ...over });

describe('Alta de familias: límite por IP y campo trampa (D50)', () => {
  it('pasado el límite por hora, 429 sin tocar nada más; otra IP no se ve afectada', async () => {
    await setSetting('registration_open', true, F.ids.mama);
    config.limits.setupPerHour = 2;
    const c = new Client(app);
    expect((await signup(c, 'uno')).status).toBe(200);
    expect((await signup(c, 'uno')).body.error).toBe('username_taken');
    const r = await signup(c, 'dos');
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('rate_limited');
    expect((await one(pool(), `SELECT count(*)::int AS n FROM users WHERE username = 'dos'`))!.n).toBe(0);
    expect((await signup(new Client(app), 'tres')).status).toBe(200);
  });

  it('el campo trampa relleno parece un éxito pero no crea nada', async () => {
    await setSetting('registration_open', true, F.ids.mama);
    const before = (await one(pool(), 'SELECT count(*)::int AS n FROM families'))!.n;
    const r = await signup(new Client(app), 'robot', { website: 'http://spam.example' });
    expect(r.status).toBe(200);
    expect(r.body.user).toBeNull();
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM families'))!.n).toBe(before);
    expect((await one(pool(), `SELECT count(*)::int AS n FROM users WHERE username = 'robot'`))!.n).toBe(0);
  });

  it('con el registro cerrado sigue sin dejar crear familias', async () => {
    expect((await signup(new Client(app), 'intruso')).status).toBe(403);
  });
});

describe('IP del cliente', () => {
  it('con Cloudflare se usa CF-Connecting-IP (no se puede falsear con X-Forwarded-For) y sin él, la del socket', async () => {
    const mk = (headers: Record<string, string>) => ({ headers, ip: '10.9.9.9' }) as any;
    expect(clientIp(mk({ 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.2.3.4' }))).toBe('203.0.113.7');
    expect(clientIp(mk({ 'x-forwarded-for': '1.2.3.4' }))).toBe('10.9.9.9');
    expect(clientIp(mk({ 'cf-connecting-ip': 'no es una ip!' }))).toBe('10.9.9.9');
    config.trustCloudflareIp = false;
    expect(clientIp(mk({ 'cf-connecting-ip': '203.0.113.7' }))).toBe('10.9.9.9');
    config.trustCloudflareIp = true;
  });

  it('dos IP distintas de Cloudflare no comparten el contador', async () => {
    config.limits.recoveryPerHour = 1;
    const c = new Client(app);
    const go = (ip: string) => c.post('/api/auth/forgot', { login: 'nadie' }, { 'cf-connecting-ip': ip });
    expect((await go('198.51.100.1')).status).toBe(200);
    expect((await go('198.51.100.1')).status).toBe(429);
    expect((await go('198.51.100.2')).status).toBe(200);
  });
});

describe('Recuperación e invitaciones (D50)', () => {
  it('recuperar acceso: límite por hora y misma respuesta exista o no la cuenta', async () => {
    config.limits.recoveryPerHour = 2;
    const c = new Client(app);
    const a = await c.post('/api/auth/forgot', { login: 'fmama' });
    const b = await c.post('/api/auth/forgot', { login: 'no-existe' });
    expect(a.body).toEqual(b.body);
    expect((await c.post('/api/auth/forgot', { login: 'fmama' })).status).toBe(429);
  });

  it('invitaciones: límite por hora, tope de pendientes y tope de personas', async () => {
    config.limits.invitePerHour = 3;
    config.caps.maxPendingInvitations = 2;
    const inv = (n: number) => F.mama.post('/api/invitations', { email: `inv${n}@example.com`, displayName: `Inv ${n}` });
    expect((await inv(1)).status).toBe(200);
    expect((await inv(2)).status).toBe(200);
    expect((await inv(3)).body.error).toBe('too_many_invitations');
    expect((await inv(4)).status).toBe(429);
  });

  it('tope de personas por familia al añadir miembros y al aceptar invitaciones', async () => {
    config.caps.maxMembers = 5;
    const add = (u: string) => F.mama.post('/api/members', { role: 'child', displayName: u, username: u, password: '1234' });
    expect((await add('quinto')).status).toBe(200);
    const r = await add('sexto');
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('too_many_members');
    expect((await F.mama.post('/api/invitations', { email: 'otro@example.com', displayName: 'Otro' })).body.error).toBe('too_many_members');
  });

  it('restablecer contraseña: límite por IP', async () => {
    config.limits.resetPerHour = 1;
    const c = new Client(app);
    expect((await c.post('/api/auth/reset', { token: 'x'.repeat(30), password: 'contrasena-larga' })).status).toBe(400);
    expect((await c.post('/api/auth/reset', { token: 'x'.repeat(30), password: 'contrasena-larga' })).status).toBe(429);
  });
});

describe('Subida de fotos (D50)', () => {
  let JPEG: Buffer;
  beforeAll(async () => { JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#c33' } }).jpeg().toBuffer(); });
  function form(file: { type: string; data: Buffer }) {
    const b = '----diplop' + Math.random().toString(16).slice(2);
    const payload = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="f.jpg"\r\nContent-Type: ${file.type}\r\n\r\n`),
      file.data,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
  }
  async function photoTask(title: string) {
    const r = await F.mama.post('/api/tasks', { title, points: 10, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], requiresPhoto: true });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.task_id === r.body.task.id).id as string;
  }
  const upload = (id: string, f: { type: string; data: Buffer }) => {
    const { payload, headers } = form(f);
    return F.luciaC.req('POST', `/api/instances/${id}/complete`, payload, headers);
  };
  const photosOnDisk = () => (fs.existsSync(path.join(config.uploadDir, F.ids.family)) ? fs.readdirSync(path.join(config.uploadDir, F.ids.family)).length : 0);

  it('acepta una foto buena y rechaza lo que solo dice ser una foto', async () => {
    const a = await photoTask('Una');
    const bad = await upload(a, { type: 'image/jpeg', data: Buffer.from('<script>alert(1)</script>') });
    expect(bad.status).toBe(400);
    expect(photosOnDisk()).toBe(0);
    expect((await upload(a, { type: 'application/pdf', data: JPEG })).status).toBe(400);
    expect((await upload(a, { type: 'image/jpeg', data: JPEG })).status).toBe(200);
    expect(photosOnDisk()).toBe(1);
  });

  it('una foto por encima del tamaño máximo da 413 y no deja nada en disco', async () => {
    const a = await photoTask('Grande');
    const big = Buffer.concat([JPEG, Buffer.alloc(config.maxUploadBytes + 1024, 1)]);
    const r = await upload(a, { type: 'image/jpeg', data: big });
    expect(r.status).toBe(413);
    expect(r.body.error).toBe('too_large');
    expect(photosOnDisk()).toBe(0);
  });

  it('tope de fotos guardadas por familia y límite de subidas por hora', async () => {
    config.caps.maxPhotos = 1;
    const a = await photoTask('Primera');
    const b = await photoTask('Segunda');
    expect((await upload(a, { type: 'image/jpeg', data: JPEG })).status).toBe(200);
    const r = await upload(b, { type: 'image/jpeg', data: JPEG });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('too_many_photos');
    config.caps.maxPhotos = 500;
    config.limits.uploadPerHour = 2; // la subida buena de arriba y la rechazada ya cuentan
    expect((await upload(b, { type: 'image/jpeg', data: JPEG })).status).toBe(429);
    expect(photosOnDisk()).toBe(1);
  });
});

describe('Vigilancia: salud y errores con código (D51)', () => {
  it('/api/health comprueba la base, sin sesión y sin datos', async () => {
    const r = await new Client(app).get('/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, db: 'up' });
  });

  it('si la base no responde, 503 sin detalles del fallo', async () => {
    vi.spyOn(getPool(), 'query').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=secreta'));
    const r = await new Client(app).get('/api/health');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ ok: false, db: 'down' });
    expect(JSON.stringify(r.body)).not.toMatch(/secreta|10\.0\.0\.5/);
  });

  it('un 5xx devuelve un código, lo registra y no filtra el mensaje interno ni la consulta', async () => {
    const r = await new Client(app).get('/api/_boom?token=abc123');
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('internal');
    expect(r.body.errorId).toMatch(/^[A-Z2-9]{8}$/);
    expect(r.body.message).toContain(r.body.errorId);
    expect(JSON.stringify(r.body)).not.toMatch(/pablo|secreto/);
    await new Promise((res) => setTimeout(res, 100));
    const row = await one(pool(), 'SELECT * FROM server_errors WHERE id = $1', [r.body.errorId]);
    expect(row).toMatchObject({ method: 'GET', status: 500 });
    expect(row!.route).toBe('/api/_boom');
    expect(row!.route).not.toContain('abc123');
  });

  it('los errores del cliente (4xx) no se registran como fallos del servidor', async () => {
    await new Client(app).post('/api/auth/login', { username: 'x', password: 'y' });
    await new Client(app).post('/api/setup', {});
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM server_errors'))!.n).toBe(0);
  });
});
