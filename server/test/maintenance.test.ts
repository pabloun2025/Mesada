import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, one } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { totp } from '../src/lib/totp.js';
import { runCleanup, maybeNightlyCleanup } from '../src/lib/cleanup.js';
import { backupsInfo, inactiveFamilies } from '../src/lib/storage-info.js';
import { setSetting } from '../src/lib/settings.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { resetAdminFailures } from '../src/routes/admin.js';
import { createFamily, resetDb, Client } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const pool = () => getPool();
const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const DAY = 86_400_000;

beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); await closePool(); });
beforeEach(async () => { resetLoginFailures(); resetAdminFailures(); await resetDb(); F = await createFamily(app); });

/* ---------- Fotos: reducción, EXIF, reemplazo y desmarcado ---------- */

function form(data: Buffer, type = 'image/jpeg') {
  const b = '----diplop' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="f.jpg"\r\nContent-Type: ${type}\r\n\r\n`), data, Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}
async function photoTask(title: string, over: Record<string, unknown> = {}) {
  const r = await F.mama.post('/api/tasks', { title, points: 10, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], requiresPhoto: true, ...over });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (await F.luciaC.get('/api/instances')).body.instances.find((i: any) => i.task_id === r.body.task.id).id as string;
}
const upload = (id: string, data: Buffer, type?: string) => { const f = form(data, type); return F.luciaC.req('POST', `/api/instances/${id}/complete`, f.payload, f.headers); };
const photoPath = async (id: string) => (await one(pool(), 'SELECT photo_path FROM task_instances WHERE id = $1', [id]))!.photo_path as string | null;
const abs = (rel: string) => path.join(config.uploadDir, rel);
const files = () => { const d = path.join(config.uploadDir, F.ids.family); return fs.existsSync(d) ? fs.readdirSync(d) : []; };

/** Una foto de móvil: grande, con EXIF (marca, GPS y orientación). */
async function bigPhoto(w = 3000, h = 2000, mime: 'jpeg' | 'png' | 'webp' = 'jpeg') {
  const s = sharp({ create: { width: w, height: h, channels: 3, background: '#3a7' } }).withExif({
    IFD0: { Make: 'TelefonoSecreto', Copyright: 'Pablo Perez' },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '40/1 25/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '3/1 42/1 0/1' },
  });
  return mime === 'jpeg' ? s.jpeg().toBuffer() : mime === 'png' ? s.png().toBuffer() : s.webp().toBuffer();
}

describe('Fotos de evidencia: reducción y metadatos (D56)', () => {
  it('reduce a 1280 px de lado largo y no deja ni EXIF ni GPS (JPEG)', async () => {
    const src = await bigPhoto();
    expect((await sharp(src).metadata()).exif, 'la prueba necesita EXIF de origen').toBeTruthy();
    const id = await photoTask('Foto grande');
    expect((await upload(id, src)).status).toBe(200);
    const rel = (await photoPath(id))!;
    expect(rel).toMatch(/\.jpg$/);
    const out = fs.readFileSync(abs(rel));
    const m = await sharp(out).metadata();
    expect(Math.max(m.width!, m.height!)).toBe(1280);
    expect(m.width! / m.height!).toBeCloseTo(1.5, 1);
    expect(m.exif).toBeUndefined();
    expect(out.toString('latin1')).not.toMatch(/TelefonoSecreto|Pablo Perez|GPS/);
    expect(out.length).toBeLessThan(src.length);
  });

  it('PNG y WebP salen en WebP, también reducidos y sin metadatos; una foto pequeña no se agranda', async () => {
    const a = await photoTask('Png');
    expect((await upload(a, await bigPhoto(2400, 1800, 'png'), 'image/png')).status).toBe(200);
    const ra = (await photoPath(a))!;
    expect(ra).toMatch(/\.webp$/);
    expect((await sharp(abs(ra)).metadata()).width).toBe(1280);
    const b = await photoTask('Webp pequeña');
    expect((await upload(b, await bigPhoto(300, 200, 'webp'), 'image/webp')).status).toBe(200);
    const mb = await sharp(abs((await photoPath(b))!)).metadata();
    expect([mb.width, mb.height]).toEqual([300, 200]);
    expect(mb.exif).toBeUndefined();
  });

  it('aplica la orientación EXIF antes de quitarla (la foto no sale girada)', async () => {
    const rotated = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#00f' } }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const id = await photoTask('Girada');
    expect((await upload(id, rotated)).status).toBe(200);
    const m = await sharp(abs((await photoPath(id))!)).metadata();
    expect([m.width, m.height]).toEqual([400, 800]);
    expect(m.orientation).toBeUndefined();
  });

  it('un archivo con cabecera de imagen pero corrupto se rechaza sin dejar nada', async () => {
    const id = await photoTask('Rota');
    const r = await upload(id, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(500, 7)]));
    expect(r.status).toBe(400);
    expect(files()).toHaveLength(0);
  });
});

describe('Fotos: reemplazo, desmarcado y retención de 7 días (D56)', () => {
  const review = (id: string, body: Record<string, unknown>) => F.mama.post(`/api/instances/${id}/review`, body);

  it('al devolver y reenviar con otra foto, la anterior se borra (no queda huérfana)', async () => {
    const id = await photoTask('Reenviada');
    await upload(id, await bigPhoto(500, 400));
    const first = (await photoPath(id))!;
    expect((await review(id, { action: 'return', note: 'Otra foto' })).status).toBe(200);
    expect((await upload(id, await bigPhoto(600, 400))).status).toBe(200);
    const second = (await photoPath(id))!;
    expect(second).not.toBe(first);
    expect(fs.existsSync(abs(first))).toBe(false);
    expect(fs.existsSync(abs(second))).toBe(true);
    expect(files()).toHaveLength(1);
  });

  it('al desmarcar, se borra el archivo', async () => {
    const id = await photoTask('Desmarcada');
    await upload(id, await bigPhoto(500, 400));
    const rel = (await photoPath(id))!;
    expect((await F.luciaC.post(`/api/instances/${id}/unmark`)).status).toBe(200);
    expect(await photoPath(id)).toBeNull();
    expect(fs.existsSync(abs(rel))).toBe(false);
  });

  it('se borra 7 días después de validar (aceptada, parcial o rechazada); antes, no; y sin validar, nunca', async () => {
    const ids = { ok: await photoTask('A'), partial: await photoTask('B'), declined: await photoTask('C'), pending: await photoTask('D'), returned: await photoTask('E') };
    for (const id of Object.values(ids)) await upload(id, await bigPhoto(500, 400));
    expect((await review(ids.ok, { action: 'approve' })).status).toBe(200);
    expect((await review(ids.partial, { action: 'partial', points: 5, note: 'Parte' })).status).toBe(200);
    expect((await review(ids.declined, { action: 'reject', note: 'No' })).status).toBe(200);
    expect((await review(ids.returned, { action: 'return', note: 'Repite' })).status).toBe(200);
    const paths = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, (await photoPath(id))!])));
    // A los 6 días todavía están.
    await pool().query(`UPDATE task_instances SET reviewed_at = now() - interval '6 days 23 hours' WHERE id = ANY($1)`, [Object.values(ids)]);
    let rep = await runCleanup();
    expect(rep.expiredPhotos).toBe(0);
    // A los 7 días y un minuto, las validadas se van; la pendiente y la devuelta se quedan.
    await pool().query(`UPDATE task_instances SET reviewed_at = now() - interval '7 days 1 minute' WHERE id = ANY($1)`, [Object.values(ids)]);
    rep = await runCleanup();
    expect(rep.expiredPhotos).toBe(3);
    expect(rep.freedBytes).toBeGreaterThan(0);
    for (const k of ['ok', 'partial', 'declined']) {
      expect(fs.existsSync(abs(paths[k])), k).toBe(false);
      expect(await one(pool(), 'SELECT photo_path, photo_deleted_at FROM task_instances WHERE id = $1', [(ids as any)[k]])).toMatchObject({ photo_path: null });
    }
    for (const k of ['pending', 'returned']) expect(fs.existsSync(abs(paths[k])), k).toBe(true);
    // La API dice «Foto ya borrada», no un error genérico.
    const ph = await F.mama.get(`/api/instances/${ids.ok}/photo`);
    expect(ph.status).toBe(410);
    expect(ph.body.message).toBe('Foto ya borrada');
    const list = (await F.mama.get('/api/instances?from=2000-01-01&to=2100-01-01')).body.instances.find((i: any) => i.id === ids.ok);
    expect(list).toMatchObject({ has_photo: false, photo_deleted: true });
  });
});

/* ---------- Limpieza ---------- */

describe('Limpieza nocturna y manual (D57)', () => {
  async function seedJunk() {
    const old = new Date(Date.now() - 40 * DAY);
    // Sesiones y dispositivos caducados.
    await pool().query(`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,'caducada', now() - interval '1 day'), ($1,'vigente', now() + interval '1 day')`, [F.ids.mama]);
    await pool().query(`INSERT INTO admin_trusted_devices(user_id, token_hash, expires_at) VALUES ($1,'d1', now() - interval '1 day'), ($1,'d2', now() + interval '1 day')`, [F.ids.mama]);
    // Avisos y envíos: viejos (95 días) y recientes.
    await pool().query(`INSERT INTO notifications(user_id, kind, title, created_at) VALUES ($1,'x','vieja', now() - interval '95 days'), ($1,'x','reciente', now())`, [F.ids.mama]);
    await pool().query(
      `INSERT INTO notification_outbox(family_id, user_id, event, channel, subject, body, dedupe_key, status, created_at) VALUES
        ($1,$2,'e','email','s','b','o1','sent', now() - interval '95 days'), ($1,$2,'e','email','s','b','o2','pending', now() - interval '95 days'), ($1,$2,'e','email','s','b','o3','sent', now())`,
      [F.ids.family, F.ids.mama],
    );
    // Enlaces e invitaciones.
    await pool().query(`INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,'r1', now() - interval '1 hour'), ($1,'r2', now() + interval '1 hour')`, [F.ids.mama]);
    await pool().query(`INSERT INTO invitations(family_id, email, display_name, token_hash, expires_at) VALUES ($1,'a@x.es','A','i1', now() - interval '1 day'), ($1,'b@x.es','B','i2', now() + interval '1 day')`, [F.ids.family]);
    return old;
  }

  it('borra solo lo caducado y deja lo vivo; informa de cuánto', async () => {
    await seedJunk();
    const rep = await runCleanup();
    expect(rep).toMatchObject({ sessions: 1, trustedDevices: 1, notifications: 1, outbox: 1, resets: 1, invitations: 1 });
    const n = async (sql: string) => (await one(pool(), sql))!.n as number;
    expect(await n(`SELECT count(*)::int AS n FROM sessions WHERE token_hash = 'vigente'`)).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM notifications WHERE title = 'reciente'`)).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM notification_outbox WHERE dedupe_key IN ('o2','o3')`)).toBe(2); // pendiente y reciente
    expect(await n(`SELECT count(*)::int AS n FROM password_resets WHERE token_hash = 'r2'`)).toBe(1);
    expect(await n(`SELECT count(*)::int AS n FROM invitations WHERE token_hash = 'i2'`)).toBe(1);
    // Idempotente.
    expect(await runCleanup()).toMatchObject({ sessions: 0, notifications: 0, outbox: 0, resets: 0, invitations: 0, expiredPhotos: 0 });
  });

  it('el plazo de avisos y envíos es configurable', async () => {
    await pool().query(`INSERT INTO notifications(user_id, kind, title, created_at) VALUES ($1,'x','de 10 días', now() - interval '10 days')`, [F.ids.mama]);
    expect((await runCleanup()).notifications).toBe(0);
    config.retention.notificationDays = 5;
    try { expect((await runCleanup()).notifications).toBe(1); } finally { config.retention.notificationDays = 90; }
  });

  it('fotos huérfanas (archivo sin fila) y filas sin archivo; no toca archivos recién subidos', async () => {
    const id = await photoTask('Con foto');
    await upload(id, await bigPhoto(500, 400));
    const rel = (await photoPath(id))!;
    const dir = path.join(config.uploadDir, F.ids.family);
    const orphanOld = path.join(dir, 'huerfana-vieja.jpg');
    const orphanNew = path.join(dir, 'huerfana-nueva.jpg');
    fs.writeFileSync(orphanOld, Buffer.alloc(1000, 1));
    fs.writeFileSync(orphanNew, Buffer.alloc(1000, 1));
    fs.utimesSync(orphanOld, new Date(Date.now() - 3 * 3600_000), new Date(Date.now() - 3 * 3600_000));
    // Fila cuyo archivo desapareció.
    const id2 = await photoTask('Sin archivo');
    await upload(id2, await bigPhoto(500, 400));
    const rel2 = (await photoPath(id2))!;
    fs.rmSync(abs(rel2));
    const rep = await runCleanup();
    expect(rep.orphanFiles).toBe(1);
    expect(rep.missingFileRows).toBe(1);
    expect(rep.freedBytes).toBeGreaterThanOrEqual(1000);
    expect(fs.existsSync(orphanOld)).toBe(false);
    expect(fs.existsSync(orphanNew)).toBe(true);
    expect(fs.existsSync(abs(rel))).toBe(true);
    expect((await one(pool(), 'SELECT photo_path, photo_deleted_at FROM task_instances WHERE id = $1', [id2]))!.photo_path).toBeNull();
  });

  it('de noche (03:00–05:00 de Madrid) se ejecuta una sola vez y queda en el registro; fuera de hora, no', async () => {
    const at = (h: string) => new Date(`2026-11-23T${h}:00+01:00`);
    expect(await maybeNightlyCleanup(at('12:00'))).toBeNull();
    const rep = await maybeNightlyCleanup(at('03:40'));
    expect(rep).not.toBeNull();
    expect(await maybeNightlyCleanup(at('04:10'))).toBeNull();
    const a = await one(pool(), `SELECT data, actor_id FROM admin_audit WHERE action = 'maintenance.cleanup'`);
    expect(a!.actor_id).toBeNull();
    expect(a!.data.trigger).toBe('noche');
    expect(Object.keys(a!.data)).toEqual(expect.arrayContaining(['expiredPhotos', 'freedBytes']));
  });
});

/* ---------- Superadmin: disco, copias, familias inactivas, limpieza ---------- */

async function enroll(c: Client) {
  const s = await c.post('/api/admin/2fa/setup', { password: 'contrasena-segura' });
  const e = await c.post('/api/admin/2fa/enable', { code: totp(s.body.secret) });
  expect(e.status).toBe(200);
}

describe('Administración: sistema (D57)', () => {
  const backups = path.resolve('./data/test-backups');
  beforeEach(() => { fs.rmSync(backups, { recursive: true, force: true }); fs.mkdirSync(backups, { recursive: true }); process.env.BACKUP_DIR = backups; });
  afterAll(() => { delete process.env.BACKUP_DIR; fs.rmSync(backups, { recursive: true, force: true }); });
  const put = (name: string, hoursAgo: number, bytes = 100) => { const f = path.join(backups, name); fs.writeFileSync(f, Buffer.alloc(bytes)); const t = new Date(Date.now() - hoursAgo * 3600_000); fs.utimesSync(f, t, t); };

  it('solo la administración verificada; el resto, no', async () => {
    for (const [m, u] of [['get', '/api/admin/storage'], ['post', '/api/admin/cleanup'], ['get', '/api/admin/inactive-families']] as const) {
      expect((await (F.mama as any)[m](u)).status, `${u} sin verificar`).toBe(403);
      expect((await (F.papaC as any)[m](u)).status).toBe(403);
      expect((await (F.luciaC as any)[m](u)).status).toBe(403);
    }
  });

  it('disco, fotos, base y copias (locales y R2) con aviso si la última pasa de 26 h', async () => {
    await enroll(F.mama);
    // La carpeta de fotos es compartida con otras pruebas: se cuenta la diferencia, no el total.
    const before = (await F.mama.get('/api/admin/storage')).body.storage.photos.count;
    const id = await photoTask('Para contar');
    await upload(id, await bigPhoto(500, 400));
    put('mesada-20261122-030000.dump', 2, 5000);
    put('fotos-20261122-030000.tar.gz', 2, 800);
    let r = (await F.mama.get('/api/admin/storage')).body;
    expect(r.storage.photos.count).toBe(before + 1);
    expect(r.storage.photos.bytes).toBeGreaterThan(0);
    expect(r.storage.dbBytes).toBeGreaterThan(0);
    expect(r.storage.disk.freeBytes).toBeGreaterThan(0);
    expect(r.storage.disk.totalBytes).toBeGreaterThanOrEqual(r.storage.disk.usedBytes);
    expect(r.backups.local.map((f: any) => f.name)).toEqual(expect.arrayContaining(['mesada-20261122-030000.dump', 'fotos-20261122-030000.tar.gz']));
    expect(r.backups).toMatchObject({ localStale: false, r2Stale: false, r2: { configured: false } });
    // R2 configurada: la lista y la marca de la última subida las deja el servicio de copias.
    fs.writeFileSync(path.join(backups, '.r2-list.txt'), '4096;2026-11-22T03:00:10Z;mesada-20261122-030000.dump.gpg\n');
    put('.r2-ok', 30);
    r = (await F.mama.get('/api/admin/storage')).body;
    expect(r.backups.r2).toMatchObject({ configured: true });
    expect(r.backups.r2.files[0]).toMatchObject({ name: 'mesada-20261122-030000.dump.gpg', bytes: 4096 });
    expect(r.backups.r2Stale).toBe(true);
    // Copia local vieja: aviso.
    for (const f of fs.readdirSync(backups).filter((x) => x.startsWith('mesada-'))) fs.rmSync(path.join(backups, f));
    put('mesada-20261120-030000.dump', 27);
    r = (await F.mama.get('/api/admin/storage')).body;
    expect(r.backups.localStale).toBe(true);
    expect(backupsInfo()!.staleHours).toBe(26);
  });

  it('«Limpiar basura» borra, informa y queda en el registro de auditoría', async () => {
    await enroll(F.mama);
    await pool().query(`INSERT INTO sessions(user_id, token_hash, expires_at) VALUES ($1,'vieja', now() - interval '1 day')`, [F.ids.papa]);
    const r = await F.mama.post('/api/admin/cleanup');
    expect(r.status).toBe(200);
    expect(r.body.report.sessions).toBe(1);
    const a = await one(pool(), `SELECT data, actor_id FROM admin_audit WHERE action = 'maintenance.cleanup'`);
    expect(a!.actor_id).toBe(F.ids.mama);
    expect(a!.data.trigger).toBe('manual');
    expect((await F.mama.get('/api/admin/storage')).body.lastCleanup).toMatchObject({ trigger: 'manual', sessions: 1 });
    expect((await F.mama.get('/api/admin/audit')).body.entries.some((e: any) => e.action === 'maintenance.cleanup')).toBe(true);
  });

  describe('familias inactivas', () => {
    async function second() {
      await setSetting('registration_open', true, F.ids.mama);
      const G = await createFamily(app, 'g');
      return G;
    }
    const age = async (familyId: string, months: number) => {
      await pool().query(`UPDATE families SET created_at = now() - make_interval(months => $2) WHERE id = $1`, [familyId, months]);
      await pool().query(`UPDATE users SET last_login_at = now() - make_interval(months => $2) WHERE family_id = $1`, [familyId, months]);
      await pool().query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE family_id = $1)`, [familyId]);
      await pool().query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_guard`);
      await pool().query(`UPDATE audit_log SET created_at = now() - make_interval(months => $2) WHERE family_id = $1`, [familyId, months]);
      await pool().query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_guard`);
    };

    it('lista las que llevan 6 meses sin sesión ni actividad, solo con nombre, nº de personas y fechas; no la del superadmin ni las activas', async () => {
      await enroll(F.mama);
      const G = await second();
      expect((await F.mama.get('/api/admin/inactive-families')).body.families).toEqual([]);
      await age(G.ids.family, 7);
      const r = (await F.mama.get('/api/admin/inactive-families')).body;
      expect(r.months).toBe(6);
      expect(r.families).toHaveLength(1);
      expect(Object.keys(r.families[0]).sort()).toEqual(['created_at', 'id', 'last_use', 'members', 'name']);
      expect(r.families[0]).toMatchObject({ name: 'Familia g', members: 4 });
      expect(JSON.stringify(r)).not.toMatch(/Lucía|Hugo|gmama|example\.com/);
      // Con 5 meses todavía no.
      await age(G.ids.family, 5);
      expect((await inactiveFamilies()).map((f) => f.id)).not.toContain(G.ids.family);
      // Un inicio de sesión reciente la saca de la lista.
      await age(G.ids.family, 8);
      expect((await inactiveFamilies()).map((f) => f.id)).toContain(G.ids.family);
      await pool().query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [G.ids.mama]);
      expect((await inactiveFamilies()).map((f) => f.id)).not.toContain(G.ids.family);
    });

    it('borrarla pide nombre exacto y frase, solo si está inactiva, reutiliza el borrado completo y deja auditoría sin datos', async () => {
      await enroll(F.mama);
      const G = await second();
      const photo = await addPhotoFor(G.ids.family);
      const url = `/api/admin/inactive-families/${G.ids.family}/erase`;
      const body = { confirmName: 'Familia g', phrase: 'BORRAR FAMILIA INACTIVA' };
      expect((await F.mama.post(url, body)).body.error).toBe('not_inactive'); // activa
      await age(G.ids.family, 8);
      expect((await F.mama.post(url, { ...body, confirmName: 'familia G' })).body.error).toBe('name_mismatch');
      expect((await F.mama.post(url, { ...body, phrase: 'borrar' })).body.error).toBe('phrase_mismatch');
      expect((await F.papaC.post(url, body)).status).toBe(403);
      expect((await one(pool(), 'SELECT 1 FROM families WHERE id = $1', [G.ids.family]))).toBeTruthy();
      expect((await F.mama.post(url, { ...body, phrase: ' borrar  familia inactiva ' })).status).toBe(200);
      expect(await one(pool(), 'SELECT 1 FROM families WHERE id = $1', [G.ids.family])).toBeUndefined();
      expect((await one(pool(), 'SELECT count(*)::int AS n FROM users WHERE family_id = $1', [G.ids.family]))!.n).toBe(0);
      expect(fs.existsSync(photo)).toBe(false);
      const a = await one(pool(), `SELECT data, actor_id, family_id FROM admin_audit WHERE action = 'family.erase_inactive'`);
      expect(a).toMatchObject({ actor_id: F.ids.mama, family_id: null });
      expect(a!.data.members).toBe(4);
      expect(JSON.stringify(a!.data)).not.toMatch(/Familia g/);
      // La del superadmin nunca aparece como borrable.
      expect((await F.mama.post(`/api/admin/inactive-families/${F.ids.family}/erase`, { confirmName: 'Familia f', phrase: 'BORRAR FAMILIA INACTIVA' })).body.error).toBe('not_inactive');
    });

    async function addPhotoFor(familyId: string) {
      const taskId = (await one(pool(), `INSERT INTO tasks(family_id, title, points, recurrence, start_date) VALUES ($1,'t',1,'once',$2) RETURNING id`, [familyId, today()]))!.id;
      const rel = path.join(familyId, 'x.jpg');
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), Buffer.from([0xff, 0xd8, 0xff]));
      await pool().query(`INSERT INTO task_instances(task_id, family_id, due_date, status, points, photo_path) VALUES ($1,$2,$3,'pending',1,$4)`, [taskId, familyId, today(), rel]);
      return abs(rel);
    }
  });
});

