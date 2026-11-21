import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool } from '../src/lib/db.js';
import { base32Decode, base32Encode, hotp, seal, totp, unseal, verifyTotp } from '../src/lib/totp.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { maskEmail, resetAdminFailures } from '../src/routes/admin.js';
import { MockProvider, setProviders } from '../src/lib/notify/providers.js';
import { processOutbox } from '../src/lib/notify/worker.js';
import { Client, createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;

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
  resetAdminFailures();
  await resetDb();
  F = await createFamily(app, 'a');
});

/** Activa la verificación en dos pasos de la madre (administradora) y devuelve el secreto. */
async function enroll(c: Client) {
  const s = await c.post('/api/admin/2fa/setup', { password: 'contrasena-segura' });
  expect(s.status).toBe(200);
  const e = await c.post('/api/admin/2fa/enable', { code: totp(s.body.secret) });
  expect(e.status).toBe(200);
  return { secret: s.body.secret as string, codes: e.body.recoveryCodes as string[] };
}

describe('TOTP', () => {
  it('cumple el vector de prueba de la RFC 4226', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 1)).toBe('287082');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });
  it('acepta ±30 s y rechaza códigos viejos', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const t = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, t - 30_000), t)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, t - 120_000), t)).toBeNull();
    expect(verifyTotp(secret, 'abc', t)).toBeNull();
  });
  it('cifra el secreto', () => {
    const s = seal('SECRETO');
    expect(s).not.toContain('SECRETO');
    expect(unseal(s)).toBe('SECRETO');
  });
  it('enmascara correos', () => {
    expect(maskEmail('pablo@gmail.com')).toBe('p•••o@gmail.com');
    expect(maskEmail(null)).toBeNull();
  });
});

describe('Administración', () => {
  it('solo el adulto que creó la primera familia puede entrar', async () => {
    expect((await F.mama.get('/api/admin/status')).body).toMatchObject({ eligible: true, totpEnabled: false, verified: false });
    expect((await F.papaC.get('/api/admin/status')).body).toMatchObject({ eligible: false });
    expect((await F.papaC.post('/api/admin/2fa/setup', { password: 'otra-contrasena' })).status).toBe(403);
    expect((await F.luciaC.get('/api/admin/status')).status).toBe(403);
    expect((await F.mama.get('/api/me')).body.user.is_superadmin).toBe(true);
  });

  it('exige la verificación en dos pasos antes de mostrar datos', async () => {
    expect((await F.mama.get('/api/admin/overview')).body.error).toBe('admin_verify_required');
    expect((await F.mama.post('/api/admin/2fa/setup', { password: 'mal' })).status).toBe(400);
    const { secret, codes } = await enroll(F.mama);
    expect(codes).toHaveLength(10);
    const row = (await getPool().query('SELECT totp_secret FROM users WHERE id = $1', [F.ids.mama])).rows[0];
    expect(row.totp_secret).not.toContain(secret);
    // Tras activarla, la sesión ya queda verificada.
    expect((await F.mama.get('/api/admin/overview')).status).toBe(200);

    // Otra sesión de la misma persona debe verificarse; el mismo código no vale dos veces.
    const other = new Client(app);
    await other.post('/api/auth/login', { username: 'amama', password: 'contrasena-segura' });
    expect((await other.get('/api/admin/families')).status).toBe(403);
    expect((await other.post('/api/admin/verify', { code: totp(secret) })).status).toBe(400);
    // Con un código de recuperación sí, y solo una vez.
    expect((await other.post('/api/admin/verify', { code: codes[0] })).body).toMatchObject({ ok: true, recoveryCodesLeft: 9 });
    expect((await other.get('/api/admin/families')).status).toBe(200);
    await other.post('/api/admin/lock');
    expect((await other.get('/api/admin/families')).status).toBe(403);
    expect((await other.post('/api/admin/verify', { code: codes[0] })).status).toBe(400);
  });

  it('bloquea tras 5 códigos incorrectos', async () => {
    await enroll(F.mama);
    const c = new Client(app);
    await c.post('/api/auth/login', { username: 'amama', password: 'contrasena-segura' });
    for (let i = 0; i < 5; i++) expect((await c.post('/api/admin/verify', { code: '000000' })).status).toBe(400);
    expect((await c.post('/api/admin/verify', { code: '000000' })).status).toBe(429);
  });

  it('lista familias y cuentas sin datos económicos', async () => {
    await enroll(F.mama);
    const list = await F.mama.get('/api/admin/families');
    expect(list.body.families).toHaveLength(1);
    expect(list.body.families[0]).toMatchObject({ adults: 2, children: 2, is_admin_family: true });
    const det = await F.mama.get(`/api/admin/families/${F.ids.family}`);
    const json = JSON.stringify(det.body);
    for (const forbidden of ['points', 'cents', 'balance', 'password_hash', 'totp_secret']) expect(json).not.toContain(forbidden);
    const mama = det.body.members.find((m: any) => m.username === 'amama');
    expect(mama.email).toBe('a•••a@example.com');
    expect(mama.two_factor).toBe(true);
  });

  it('abre el registro, bloquea otra familia y le pone una contraseña temporal', async () => {
    await enroll(F.mama);
    expect((await new Client(app).get('/api/setup/status')).body.registrationOpen).toBe(false);
    await F.mama.put('/api/admin/settings', { registrationOpen: true });
    expect((await new Client(app).get('/api/setup/status')).body.registrationOpen).toBe(true);
    const G = await createFamily(app, 'b');

    // Bloqueo: cierra sesiones y no deja entrar.
    expect((await F.mama.post(`/api/admin/families/${G.ids.family}/block`, { blocked: true, reason: 'prueba' })).status).toBe(200);
    expect((await G.mama.get('/api/me')).status).toBe(401);
    const login = await new Client(app).post('/api/auth/login', { username: 'bmama', password: 'contrasena-segura' });
    expect(login.status).toBe(403);
    expect((await F.mama.post(`/api/admin/families/${F.ids.family}/block`, { blocked: true })).status).toBe(400);
    await F.mama.post(`/api/admin/families/${G.ids.family}/block`, { blocked: false });

    // Contraseña temporal y PIN temporal.
    const t = await F.mama.post(`/api/admin/users/${G.ids.mama}/temp-password`);
    expect(t.body.kind).toBe('password');
    expect((await new Client(app).post('/api/auth/login', { username: 'bmama', password: t.body.secret })).status).toBe(200);
    const pin = await F.mama.post(`/api/admin/users/${G.ids.lucia}/temp-password`);
    expect(pin.body.secret).toMatch(/^\d{6}$/);
    expect((await F.mama.post(`/api/admin/users/${F.ids.mama}/temp-password`)).status).toBe(400);

    // Desactivar una cuenta.
    await F.mama.post(`/api/admin/users/${G.ids.papa}/active`, { active: false });
    expect((await G.papaC.get('/api/me')).status).toBe(401);

    const audit = await F.mama.get('/api/admin/audit');
    const actions = audit.body.entries.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['family.block', 'family.unblock', 'user.temp_password', 'user.deactivate', 'settings.registration']));
  });

  it('pausa los envíos sin perder mensajes', async () => {
    await enroll(F.mama);
    const mock = new MockProvider('email');
    setProviders({ email: mock, whatsapp: new MockProvider('whatsapp') });
    await getPool().query(
      `INSERT INTO notification_outbox(family_id, user_id, channel, event, to_address, subject, body, dedupe_key)
       VALUES ($1, $2, 'email', 'settlement', 'x@example.com', 'Prueba', 'Hola', 'admin-test')`,
      [F.ids.family, F.ids.mama],
    );
    await F.mama.put('/api/admin/settings', { notifyPaused: true });
    expect(await processOutbox()).toBe(0);
    expect((await F.mama.get('/api/admin/overview')).body.notify).toMatchObject({ paused: true, outbox: { pending: 1 } });
    await F.mama.put('/api/admin/settings', { notifyPaused: false });
    expect(await processOutbox()).toBe(1);
    expect(mock.sent).toHaveLength(1);
  });
});
