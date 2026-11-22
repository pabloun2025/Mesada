// Utilidades comunes de los scripts de medios (capturas del manual y vídeos).
// Arrancan una API propia con una base de datos vacía (mesada_media) y la web compilada (web/dist).
// Todo son datos inventados. No se tocan las bases de desarrollo ni de pruebas.
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { chromium, devices } from 'playwright';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = Number(process.env.MEDIA_PORT || 3200);
export const BASE = `http://localhost:${PORT}`;
const PG = process.env.MEDIA_PG || 'postgres://postgres:postgres@127.0.0.1:5432';
const DBNAME = process.env.MEDIA_DB || 'mesada_media';
export const DB_URL = `${PG}/${DBNAME}`;

export const ADULT = { name: 'Marta', user: 'marta', pass: 'contrasena-marta' };
export const ADULT2 = { name: 'Javier', user: 'javier', pass: 'contrasena-javier' };
export const KID = { name: 'Nora', user: 'nora', pin: '2468' };
export const KID2 = { name: 'Leo', user: 'leo', pin: '1357' };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startServer() {
  execFileSync('psql', [`${PG}/postgres`, '-qc', `DROP DATABASE IF EXISTS ${DBNAME} WITH (FORCE)`, '-c', `CREATE DATABASE ${DBNAME}`]);
  const uploads = `/tmp/${DBNAME}-uploads`;
  fs.rmSync(uploads, { recursive: true, force: true });
  const child = spawn(path.join(ROOT, 'server/node_modules/.bin/tsx'), ['src/index.ts'], {
    detached: true,
    cwd: path.join(ROOT, 'server'),
    env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), STATIC_DIR: '../web/dist', UPLOAD_DIR: uploads, AUTH_RATE_LIMIT: '1000', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return child; } catch { /* aún no */ }
    await sleep(500);
  }
  stopServer(child);
  throw new Error('La API no arranca');
}

export function stopServer(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* ya parado */ }
}

export function sql(q) {
  execFileSync('psql', [DB_URL, '-qc', q]);
}

export async function launch() {
  return chromium.launch({ args: ['--no-sandbox', '--lang=es-ES'] });
}

export const phone = { ...devices['iPhone 13'], locale: 'es-ES', timezoneId: 'Europe/Madrid' };
export const today = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });

/** Llamada a la API con la sesión de la página (lleva la cabecera anti-CSRF). */
export async function api(page, method, p, data, headers = {}) {
  const res = await page.request[method](`${BASE}/api${p}`, { data, headers: { 'X-Mesada': '1', ...headers } });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

export async function login(page, user, pass, child = false) {
  await page.goto(`${BASE}/entrar`);
  if (child) await page.getByRole('radio', { name: 'Soy hijo/a' }).click();
  await page.getByLabel('Usuario').fill(user);
  await page.getByLabel(child ? 'PIN' : 'Contraseña').fill(pass);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/entrar'));
}

/** Crea la familia por la interfaz (primer arranque) y devuelve la página del adulto. */
export async function createFamily(page, { family = 'Familia Soler', email = 'marta@example.com' } = {}) {
  await page.goto(BASE + '/');
  await page.waitForURL(/configurar/);
  await page.getByLabel('Nombre de la familia').fill(family);
  await page.getByLabel('Tu nombre').fill(ADULT.name);
  await page.getByLabel('Usuario').fill(ADULT.user);
  await page.getByLabel('Correo').fill(email);
  await page.getByLabel('Contraseña').fill(ADULT.pass);
  await page.getByRole('button', { name: 'Crear familia' }).click();
  await page.getByRole('heading', { name: 'Familia', exact: true }).waitFor();
}

export async function addMember(page, role, name, user, secret) {
  await page.getByRole('button', { name: 'Añadir' }).first().click();
  const d = page.getByRole('dialog');
  if (role === 'adult') await d.getByRole('radio', { name: 'Adulto' }).click();
  await d.getByLabel('Nombre', { exact: true }).fill(name);
  await d.getByLabel('Usuario para entrar').fill(user);
  await d.getByLabel(role === 'child' ? 'PIN' : 'Contraseña').fill(secret);
  await d.getByRole('button', { name: 'Añadir' }).click();
  await page.getByText(`${name} se ha unido a la familia`).waitFor();
}
