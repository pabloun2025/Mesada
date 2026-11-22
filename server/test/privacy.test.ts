import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { LEGAL_VERSION } from '../src/lib/legal.js';
import { crc32 } from '../src/lib/zip.js';
import { EXPORTED_TABLES, NOT_EXPORTED_TABLES } from '../src/lib/privacy.js';
import { setSetting } from '../src/lib/settings.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { consent, createFamily, resetDb, Client } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const pool = () => getPool();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const PHRASE = 'BORRAR MI FAMILIA';

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

/** Lee un ZIP sencillo (el que genera la app): nombre → contenido, comprobando el CRC de cada fichero. */
function unzip(buf: Buffer) {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    expect(crc32(data), `CRC de ${name}`).toBe(crc);
    out.set(name, data);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

/** Foto de evidencia de un hijo: un fichero real en disco y la fila que la señala. */
async function addPhoto(familyId: string, kidId: string, title: string, name: string) {
  const taskId = (await one(pool(), `INSERT INTO tasks(family_id, title, points, recurrence, start_date) VALUES ($1,$2,10,'once',$3) RETURNING id`, [familyId, title, today()]))!.id;
  const rel = path.join(familyId, name);
  const abs = path.join(config.uploadDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  const inst = (await one(pool(), `INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, status, points, completed_by, completed_at, child_note, photo_path) VALUES ($1,$2,$3,$4,'submitted',10,$3,now(),'nota privada',$5) RETURNING id`, [taskId, familyId, kidId, today(), rel]))!.id;
  return { rel, abs, inst: inst as string };
}

describe('Alta con consentimiento (D48)', () => {
  it('sin la casilla o con otra versión no se crea la familia; con ella se guarda versión y fecha', async () => {
    await resetDb();
    const body = { familyName: 'Z', displayName: 'Z', username: 'zeta', password: 'contrasena-larga', email: 'z@example.com' };
    const c = new Client(app);
    expect((await c.post('/api/setup', body)).status).toBe(400);
    expect((await c.post('/api/setup', { ...body, acceptTerms: false, termsVersion: LEGAL_VERSION })).status).toBe(400);
    expect((await c.post('/api/setup', { ...body, acceptTerms: true, termsVersion: '1999-01-01' })).body.error).toBe('terms_outdated');
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM families'))!.n).toBe(0);
    const ok = await c.post('/api/setup', { ...body, ...consent });
    expect(ok.status).toBe(200);
    expect(ok.body.user.terms_version).toBe(LEGAL_VERSION);
    expect(new Date(ok.body.user.terms_accepted_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect((await c.get('/api/setup/status')).body.legalVersion).toBe(LEGAL_VERSION);
  });

  it('quien acepta una invitación también acepta los textos', async () => {
    await F.mama.post('/api/invitations', { email: 'abuela@example.com', displayName: 'Abuela', relationship: 'grandparent' });
    const out = (await pool().query(`SELECT link FROM notification_outbox WHERE event = 'invitation'`)).rows[0];
    const token = new URL(out.link, 'http://x').searchParams.get('token')!;
    const c = new Client(app);
    const base = { token, username: 'abuela', password: 'contrasena-larga' };
    expect((await c.post('/api/invitations/accept', base)).status).toBe(400);
    const ok = await c.post('/api/invitations/accept', { ...base, ...consent });
    expect(ok.status).toBe(200);
    expect(ok.body.user.terms_version).toBe(LEGAL_VERSION);
  });
});

describe('Descargar los datos de la familia (D49)', () => {
  it('solo un adulto; el ZIP trae JSON legible, las fotos y ni contraseñas ni claves', async () => {
    const photo = await addPhoto(F.ids.family, F.ids.lucia, 'Recoger', 'a1.jpg');
    expect((await F.luciaC.get('/api/privacy/export')).status).toBe(403);
    expect((await new Client(app).get('/api/privacy/export')).status).toBe(401);

    const r = await F.papaC.get('/api/privacy/export');
    expect(r.status).toBe(200);
    expect(r.raw.headers['content-type']).toContain('application/zip');
    expect(String(r.raw.headers['content-disposition'])).toMatch(/attachment; filename="diplop-familia-\d{4}-\d{2}-\d{2}\.zip"/);
    const files = unzip(r.raw.rawPayload);
    expect([...files.keys()]).toEqual(expect.arrayContaining(['LEEME.txt', 'familia.json', 'miembros.json', 'tareas-hechas.json', 'puntos.json', 'dinero.json', 'historial.json', `fotos/a1.jpg`]));
    expect(files.get('fotos/a1.jpg')!.equals(fs.readFileSync(photo.abs))).toBe(true);

    const members = JSON.parse(files.get('miembros.json')!.toString());
    expect(members.miembros).toHaveLength(4);
    expect(members.miembros.map((m: any) => m.display_name).sort()).toEqual(['Hugo', 'Lucía', 'Mamá', 'Papá']);
    const all = [...files.values()].map((b) => b.toString('latin1')).join('\n');
    expect(all).not.toMatch(/password_hash|scrypt\$|totp_secret/);
    const inst = JSON.parse(files.get('tareas-hechas.json')!.toString()).tareas_hechas[0];
    expect(inst).toMatchObject({ child_note: 'nota privada', photo_path: 'fotos/a1.jpg' });
  });

  it('no mezcla datos de otra familia', async () => {
    await setSetting('registration_open', true, F.ids.mama);
    const G = await createFamily(app, 'g');
    const r = await G.mama.get('/api/privacy/export');
    const files = unzip(r.raw.rawPayload);
    const text = [...files.values()].map((b) => b.toString()).join('\n');
    expect(text).toContain('Familia g');
    expect(text).not.toContain('Familia f');
    expect(text).not.toContain('fmama');
  });
});

describe('La descarga cubre todo lo que se guarda (D49)', () => {
  it('toda tabla con datos de una familia o de una persona está en la descarga o excluida a propósito: una tabla nueva obliga a decidir', async () => {
    const rows = await many(pool(), `SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name IN ('family_id', 'user_id', 'task_id') ORDER BY 1`);
    const covered = new Set([...EXPORTED_TABLES, ...NOT_EXPORTED_TABLES]);
    expect(rows.map((r) => r.t as string).filter((t) => !covered.has(t)), 'tablas sin decidir').toEqual([]);
  });
});

describe('Borrar un hijo (D49)', () => {
  it('pide la contraseña de un adulto, y solo funciona con hijos de la propia familia', async () => {
    const lucia = F.ids.lucia;
    expect((await F.luciaC.post(`/api/members/${lucia}/delete`, { password: '1234' })).status).toBe(403);
    expect((await F.mama.post(`/api/members/${lucia}/delete`, { password: 'incorrecta-1' })).body.error).toBe('wrong_password');
    expect((await F.mama.post(`/api/members/${F.ids.papa}/delete`, { password: 'contrasena-segura' })).status).toBe(403); // un adulto no
    await setSetting('registration_open', true, F.ids.mama);
    const G = await createFamily(app, 'g');
    expect((await G.mama.post(`/api/members/${lucia}/delete`, { password: 'contrasena-segura' })).status).toBe(404);
    expect((await one(pool(), 'SELECT 1 FROM users WHERE id = $1', [lucia]))).toBeTruthy();
  });

  it('borra su cuenta, movimientos, avisos, sesiones, fotos y rastro en el historial; el hermano queda intacto', async () => {
    const lucia = F.ids.lucia, hugo = F.ids.hugo;
    const pl = await addPhoto(F.ids.family, lucia, 'De Lucía', 'lucia.jpg');
    const ph = await addPhoto(F.ids.family, hugo, 'De Hugo', 'hugo.jpg');
    await F.mama.post('/api/adjustments/points', { userId: lucia, delta: 40, note: 'Regalo', bonus: true });
    await F.mama.post('/api/adjustments/points', { userId: hugo, delta: 10, note: 'Regalo', bonus: true });
    await F.mama.post('/api/screen/give', { userId: lucia, minutes: 15, note: 'x' }).catch(() => {});
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM audit_log WHERE data->>\'userId\' = $1::text OR actor_id = $1::uuid OR entity_id = $1::uuid', [lucia]))!.n).toBeGreaterThan(0);

    const r = await F.mama.post(`/api/members/${lucia}/delete`, { password: 'contrasena-segura' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.photos).toBe(1);

    expect(fs.existsSync(pl.abs)).toBe(false);
    expect(fs.existsSync(ph.abs)).toBe(true);
    expect(await one(pool(), 'SELECT 1 FROM users WHERE id = $1', [lucia])).toBeUndefined();
    for (const t of ['points_ledger', 'money_ledger', 'screen_ledger', 'notifications', 'sessions', 'task_instances']) {
      const col = t === 'task_instances' ? 'assignee_id' : 'user_id';
      expect((await one(pool(), `SELECT count(*)::int AS n FROM ${t} WHERE ${col} = $1`, [lucia]))!.n, t).toBe(0);
    }
    expect((await one(pool(), `SELECT count(*)::int AS n FROM audit_log WHERE actor_id = $1::uuid OR entity_id = $1::uuid OR data->>'userId' = $1::text OR data->>'for' = $1::text`, [lucia]))!.n).toBe(0);
    // Su sesión ya no vale y el hermano sigue con sus datos y su foto.
    expect((await F.luciaC.get('/api/me')).status).toBe(401);
    expect((await F.hugoC.get('/api/me')).status).toBe(200);
    expect((await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS n FROM points_ledger WHERE user_id = $1', [hugo]))!.n).toBe(10);
    expect((await one(pool(), 'SELECT photo_path FROM task_instances WHERE id = $1', [ph.inst]))!.photo_path).toBe(ph.rel);
    // Y el historial sigue protegido: sin el modo de borrado, nadie borra un movimiento.
    await expect(pool().query('DELETE FROM points_ledger WHERE user_id = $1', [hugo])).rejects.toThrow(/no se pueden borrar/);
  });

  it('también borra la foto y la nota de lo que marcó en una tarea compartida', async () => {
    const lucia = F.ids.lucia;
    const taskId = (await one(pool(), `INSERT INTO tasks(family_id, title, points, recurrence, start_date, assignment_mode) VALUES ($1,'Compartida',10,'once',$2,'shared') RETURNING id`, [F.ids.family, today()]))!.id;
    const abs = path.join(config.uploadDir, F.ids.family, 'shared.jpg');
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from([0xff, 0xd8, 0xff]));
    const inst = (await one(pool(), `INSERT INTO task_instances(task_id, family_id, due_date, status, points, completed_by, completed_at, child_note, photo_path) VALUES ($1,$2,$3,'submitted',10,$4,now(),'privado',$5) RETURNING id`, [taskId, F.ids.family, today(), lucia, path.join(F.ids.family, 'shared.jpg')]))!.id;
    await F.mama.post(`/api/members/${lucia}/delete`, { password: 'contrasena-segura' });
    expect(fs.existsSync(abs)).toBe(false);
    expect(await one(pool(), 'SELECT photo_path, child_note FROM task_instances WHERE id = $1', [inst])).toMatchObject({ photo_path: null, child_note: null });
  });
});

describe('Borrar la familia entera (D49)', () => {
  it('ninguna clave foránea hacia familias, usuarios, tareas o instancias impide borrar (todas en cascada o a NULL)', async () => {
    const rows = await many(
      pool(),
      `SELECT conrelid::regclass::text AS tabla, conname FROM pg_constraint
        WHERE contype = 'f' AND confrelid IN ('families'::regclass, 'users'::regclass, 'tasks'::regclass, 'task_instances'::regclass) AND confdeltype IN ('a', 'r')`,
    );
    expect(rows, 'claves que bloquearían el borrado').toEqual([]);
  });

  const del = (c: Client, over: Record<string, unknown> = {}) => c.post('/api/privacy/delete-family', { password: 'contrasena-segura', phrase: PHRASE, ...over });

  it('exige ser adulto, la contraseña y la frase exacta', async () => {
    expect((await del(F.luciaC)).status).toBe(403);
    expect((await del(F.mama, { password: 'mala-mala-1' })).body.error).toBe('wrong_password');
    expect((await del(F.mama, { phrase: 'borrar' })).body.error).toBe('phrase_mismatch');
    expect((await del(F.mama, { phrase: '' })).status).toBe(400);
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM families'))!.n).toBe(1);
  });

  it('la administración de la instalación no puede quedarse sin cuenta', async () => {
    expect((await del(F.mama)).body.error).toBe('is_installation_admin');
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM families'))!.n).toBe(1);
  });

  it('borra todo de esa familia (filas, sesiones, fotos y rastro) y deja la otra familia intacta', async () => {
    await setSetting('registration_open', true, F.ids.mama);
    const G = await createFamily(app, 'g');
    const gp = await addPhoto(G.ids.family, G.ids.lucia, 'De G', 'g.jpg');
    const fp = await addPhoto(F.ids.family, F.ids.lucia, 'De F', 'f.jpg');
    await G.mama.post('/api/adjustments/points', { userId: G.ids.lucia, delta: 30, note: 'Regalo', bonus: true });
    await G.mama.post('/api/invitations', { email: 'tio@example.com', displayName: 'Tío', relationship: 'aunt_uncle' });
    await pool().query(`INSERT INTO admin_audit(actor_id, action, family_id) VALUES ($1, 'family.block', $2)`, [F.ids.mama, G.ids.family]);

    const r = await del(G.mama);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.raw.headers['set-cookie']).toMatch(/mesada_session=;/);

    const gone = ['users', 'tasks', 'task_instances', 'points_ledger', 'money_ledger', 'screen_ledger', 'audit_log', 'notification_outbox', 'invitations', 'rewards', 'savings_goals'];
    for (const t of gone) expect((await one(pool(), `SELECT count(*)::int AS n FROM ${t} WHERE family_id = $1`, [G.ids.family]))!.n, t).toBe(0);
    expect(await one(pool(), 'SELECT 1 FROM families WHERE id = $1', [G.ids.family])).toBeUndefined();
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM sessions WHERE user_id IN ($1,$2,$3)', [G.ids.mama, G.ids.papa, G.ids.lucia]))!.n).toBe(0);
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM admin_audit WHERE family_id = $1', [G.ids.family]))!.n).toBe(0);
    expect((await G.mama.get('/api/me')).status).toBe(401);
    expect((await G.luciaC.get('/api/me')).status).toBe(401);
    // Ya no puede entrar ni recuperar nada con esas credenciales.
    expect((await new Client(app).post('/api/auth/login', { username: 'gmama', password: 'contrasena-segura' })).status).toBe(401);
    expect(fs.existsSync(gp.abs)).toBe(false);
    expect(fs.existsSync(path.join(config.uploadDir, G.ids.family))).toBe(false);
    // Queda constancia sin datos personales.
    expect((await one(pool(), `SELECT count(*)::int AS n FROM admin_audit WHERE action = 'family.erased' AND family_id IS NULL AND user_id IS NULL`))!.n).toBe(1);
    // La otra familia, intacta.
    expect(fs.existsSync(fp.abs)).toBe(true);
    expect((await F.mama.get('/api/me')).status).toBe(200);
    expect((await one(pool(), 'SELECT count(*)::int AS n FROM users WHERE family_id = $1', [F.ids.family]))!.n).toBe(4);
    expect((await many(pool(), 'SELECT 1 FROM audit_log WHERE family_id = $1', [F.ids.family])).length).toBeGreaterThan(0);
  });
});
