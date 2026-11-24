import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one } from '../src/lib/db.js';
import { config } from '../src/lib/config.js';
import { addDays, startOfWeek, todayIn } from '../src/lib/dates.js';
import { fmtMoney } from '../src/lib/currency.js';
import { kinshipText, whoText } from '../src/lib/kinship.js';
import { runCleanup } from '../src/lib/cleanup.js';
import { RELATIVE_ALLOWED, PUBLIC_ROUTES } from '../src/lib/relative-gate.js';
import { exportEntries } from '../src/lib/privacy.js';
import { MockProvider, setProviders } from '../src/lib/notify/providers.js';
import { processOutbox } from '../src/lib/notify/worker.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { Client, consent, createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
let email: MockProvider;
const pool = () => getPool();
const L = () => F.ids.lucia;
const today = () => todayIn('Europe/Madrid');

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
  email = new MockProvider('email');
  setProviders({ email, whatsapp: new MockProvider('whatsapp') });
  await resetDb();
  F = await createFamily(app);
});

const notes = (u: string, kind?: string) => many(pool(), `SELECT * FROM notifications WHERE user_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at, id`, [u, kind ?? null]);
const giveMoney = (u: string, c: number) => F.mama.post('/api/adjustments/money', { userId: u, deltaCents: c, note: 'Base' });
const goalsOf = async (c: Client = F.luciaC) => (await c.get(`/api/goals/${L()}`)).body.goals as any[];
const tokenFrom = (link?: string | null) => new URL(link!, 'http://x').searchParams.get('token')!;

/** Meta ya aprobada y activa. */
async function activeGoal(target = 5000, title = 'Vinilo') {
  const g = (await F.luciaC.post('/api/goals', { userId: L(), title, targetCents: target })).body.goal;
  expect((await F.mama.post(`/api/goals/${g.id}/proposal/approve`, {})).status).toBe(200);
  return g as { id: string };
}

/** Invita, acepta y devuelve el cliente de un pariente (o de otro adulto). */
async function invite(rel: string, name: string, user: string, extra: Record<string, unknown> = {}) {
  const r = await F.mama.post('/api/invitations', { email: `${user}@example.com`, displayName: name, relationship: rel, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  await processOutbox();
  const token = tokenFrom(email.sent.at(-1)!.link);
  const c = new Client(app);
  const acc = await c.post('/api/invitations/accept', { token, username: user, password: 'contrasena-larga', ...consent });
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  return { c, id: acc.body.user.id as string };
}

describe('moneda (I20): un solo formato para toda la aplicación', () => {
  it('EUR «6,00 €» y USD «$6.00», con signo delante y sin convertir', () => {
    expect(fmtMoney(600, 'EUR')).toBe('6,00 €');
    expect(fmtMoney(600, 'USD')).toBe('$6.00');
    expect(fmtMoney(-250, 'EUR')).toBe('-2,50 €');
    expect(fmtMoney(-250, 'USD')).toBe('-$2.50');
    expect(fmtMoney(5)).toBe('0,05 €');
  });

  it('se elige al crear la familia y se cambia en Ajustes; no se acepta otra moneda', async () => {
    const c = new Client(app);
    const base = { familyName: 'Dólares', displayName: 'Pat', username: 'pat123', password: 'contrasena-larga', email: 'pat@example.com', ...consent };
    expect((await c.post('/api/setup', { ...base, currency: 'GBP' })).status).toBe(400);
    config.allowRegistration = true;
    try {
      expect((await c.post('/api/setup', { ...base, currency: 'USD' })).status).toBe(200);
    } finally {
      config.allowRegistration = false;
    }
    expect((await c.get('/api/me')).body.family.currency).toBe('USD');
    expect((await c.patch('/api/family', { currency: 'EUR' })).body.family.currency).toBe('EUR');
    expect((await c.patch('/api/family', { currency: 'JPY' })).status).toBe(400);
    expect((await F.mama.get('/api/me')).body.family.currency).toBe('EUR'); // por defecto
  });

  it('avisos, correos y la descarga de datos usan la moneda de la familia, sin convertir importes', async () => {
    await F.mama.patch('/api/family', { currency: 'USD' });
    await giveMoney(L(), 1000);
    expect((await F.mama.post('/api/payments', { userId: L(), amountCents: 600, method: 'cash' })).status).toBe(200);
    const n = (await notes(L(), 'payment'))[0];
    expect(n.title).toContain('$6.00');
    expect(n.title).not.toContain('€');
    expect(n.body).toContain('$4.00'); // 10,00 − 6,00: el importe es el mismo, solo cambia el formato
    // La meta y su aviso también.
    const g = await activeGoal(2000);
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 400 })).status).toBe(200);
    expect((await F.mama.post(`/api/goals/${g.id}/gift`, { cents: 150, message: 'Premio' })).status).toBe(200);
    expect((await notes(L(), 'goal_gift'))[0].title).toContain('$1.50');
    // ZIP de datos: el LEEME da el ejemplo en la moneda de la familia.
    const entries: Record<string, string> = {};
    for await (const e of exportEntries(F.ids.family)) if (e.name === 'LEEME.txt') entries[e.name] = (e.data as Buffer).toString('utf8');
    expect(entries['LEEME.txt']).toContain('500 = $5.00');
    await F.mama.patch('/api/family', { currency: 'EUR' });
    for await (const e of exportEntries(F.ids.family)) if (e.name === 'LEEME.txt') entries[e.name] = (e.data as Buffer).toString('utf8');
    expect(entries['LEEME.txt']).toContain('500 = 5,00 €');
    // La insignia de ahorro habla en la moneda vigente.
    const badges = (await F.luciaC.get(`/api/progress/${L()}`)).body.badges as any[];
    expect(badges.find((b) => b.key === 'saver').description).toContain('10,00 €');
  });
});

describe('I19 · meta de ahorro: propuesta y aprobación', () => {
  it('el hijo propone, el adulto recibe aviso, ajusta nombre y precio, y el hijo recibe otro aviso', async () => {
    const g = (await F.luciaC.post('/api/goals', { userId: L(), title: 'Patinete', targetCents: 9000, emoji: '🛴' })).body.goal;
    expect(g).toMatchObject({ status: 'proposed', emoji: '🛴' });
    expect((await notes(F.ids.mama, 'goal_proposed'))[0].title).toContain('Patinete');
    // Hasta que se apruebe no se puede ahorrar en ella.
    await giveMoney(L(), 1000);
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 100 })).status).toBe(409);
    const pend = (await F.mama.get('/api/goal-proposals')).body;
    expect(pend.proposals).toHaveLength(1);
    expect((await F.mama.get('/api/dashboard')).body.pendingBank).toBe(1);
    // El hijo no se aprueba a sí mismo.
    expect((await F.luciaC.post(`/api/goals/${g.id}/proposal/approve`, {})).status).toBe(403);
    expect((await F.mama.post(`/api/goals/${g.id}/proposal/approve`, { title: 'Patinete eléctrico', targetCents: 12000, note: 'Con casco' })).body.goal).toMatchObject({ status: 'active', title: 'Patinete eléctrico', target_cents: 12000 });
    expect((await F.mama.post(`/api/goals/${g.id}/proposal/approve`, {})).body.duplicate).toBe(true);
    const aviso = (await notes(L(), 'goal_decided')).at(-1)!;
    expect(aviso.title).toContain('ha aprobado');
    expect(aviso.body).toContain('120,00 €');
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 100 })).status).toBe(200);
    expect((await F.mama.get('/api/dashboard')).body.pendingBank).toBe(0);
  });

  it('rechazar exige un motivo, que el hijo ve; un adulto crea metas ya activas', async () => {
    const g = (await F.luciaC.post('/api/goals', { userId: L(), title: 'Consola', targetCents: 30000 })).body.goal;
    expect((await F.mama.post(`/api/goals/${g.id}/proposal/reject`, {})).body.error).toBe('reason_required');
    expect((await F.mama.post(`/api/goals/${g.id}/proposal/reject`, { note: 'Es muy cara; probemos con algo menor' })).body.goal).toMatchObject({ status: 'rejected' });
    expect((await notes(L(), 'goal_decided')).at(-1)!.body).toContain('muy cara');
    const mine = (await goalsOf()).find((x) => x.id === g.id);
    expect(mine).toMatchObject({ status: 'rejected', decision_note: expect.stringContaining('muy cara') });
    expect((await F.mama.post(`/api/goals/${g.id}/proposal/approve`, {})).status).toBe(409); // ya resuelta
    const own = (await F.mama.post('/api/goals', { userId: L(), title: 'Bici', targetCents: 20000 })).body.goal;
    expect(own.status).toBe('active');
    // Un hijo no propone por su hermano.
    expect((await F.luciaC.post('/api/goals', { userId: F.ids.hugo, title: 'X', targetCents: 100 })).status).toBe(403);
  });

  it('«Te faltan X semanas» sale de la media de las últimas 4 semanas cerradas y no se enseña sin datos', async () => {
    const g = await activeGoal(10000); // 100 €
    expect((await goalsOf()).find((x) => x.id === g.id)).toMatchObject({ weekly_cents: null, weeks_left: null }); // sin datos
    // El niño existe desde hace 6 semanas y ganó 100 pts (5 €) en cada una de las cuatro últimas: media 5 € por semana.
    const thisWeek = startOfWeek(today());
    await pool().query(`UPDATE users SET created_at = $2::date - 42 WHERE id = $1`, [L(), thisWeek]);
    for (let k = 1; k <= 4; k++) {
      await pool().query(`INSERT INTO points_ledger(family_id, user_id, delta, kind, created_at) VALUES ($1,$2,100,'task', $3::date + 2 + time '12:00')`, [F.ids.family, L(), addDays(thisWeek, -7 * k)]);
    }
    // Esta semana (no cerrada) no cuenta.
    await pool().query(`INSERT INTO points_ledger(family_id, user_id, delta, kind) VALUES ($1,$2,900,'task')`, [F.ids.family, L()]);
    const a = (await goalsOf()).find((x) => x.id === g.id);
    expect(a).toMatchObject({ weekly_cents: 500, weeks_left: 20 }); // 100 € / 5 € por semana
    expect((await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 0 })).status).toBe(400);
    await giveMoney(L(), 2500);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 2500 });
    expect((await goalsOf()).find((x) => x.id === g.id)).toMatchObject({ weeks_left: 15 });
  });
});

describe('I19 · ahorro automático', () => {
  it('el hijo lo pide, el adulto lo aprueba y cada cierre manda el % a la meta, una sola vez', async () => {
    const g = await activeGoal(10000);
    expect((await F.luciaC.put(`/api/goals/${g.id}/auto`, { percent: 40 })).body).toMatchObject({ auto_percent: 0, auto_pending_percent: 40 });
    expect((await notes(F.ids.mama, 'goal_proposed')).some((n) => n.title.includes('40 %'))).toBe(true);
    expect((await F.mama.get('/api/dashboard')).body.pendingBank).toBe(1);
    // Mientras espera, un cierre no ahorra nada.
    expect((await F.luciaC.post(`/api/goals/${g.id}/auto/approve`, {})).status).toBe(403);
    expect((await F.mama.post(`/api/goals/${g.id}/auto/approve`, {})).body.auto_percent).toBe(40);
    await F.mama.post('/api/adjustments/points', { userId: L(), delta: 200, note: 'Base' }); // 200 pts = 10 €
    const s = await F.mama.post('/api/allowance/settle', { userId: L(), date: today() });
    expect(s.body.results[0].settlement.cents).toBe(1000);
    const a = (await goalsOf()).find((x) => x.id === g.id);
    expect(a.balance_cents).toBe(400); // 40 % de 10 €
    expect((await F.luciaC.get(`/api/bank/${L()}`)).body.bank.money_cents).toBe(600);
    expect((await notes(L(), 'goal_auto'))[0].title).toContain('4,00 €');
    // Libro con asientos propios: salida de la cuenta y entrada en la meta.
    const kinds = await many(pool(), `SELECT kind, account, delta_cents FROM money_ledger WHERE user_id = $1 AND kind IN ('goal_auto','transfer') ORDER BY seq`, [L()]);
    expect(kinds).toEqual([{ kind: 'goal_auto', account: 'available', delta_cents: -400 }, { kind: 'transfer', account: 'savings', delta_cents: 400 }]);
    expect((await F.mama.post('/api/allowance/settle', { userId: L(), date: today() })).status).toBe(409); // ya cerrado: nada se repite
    expect((await goalsOf()).find((x) => x.id === g.id).balance_cents).toBe(400);
  });

  it('entre todas las metas no se pasa del 100 %; rechazar deja el % anterior; el hijo puede quitarlo al momento', async () => {
    const a = await activeGoal(10000, 'A');
    const b = await activeGoal(10000, 'B');
    expect((await F.mama.put(`/api/goals/${a.id}/auto`, { percent: 70 })).body.auto_percent).toBe(70);
    expect((await F.mama.put(`/api/goals/${b.id}/auto`, { percent: 40 })).body.error).toBe('auto_over_100');
    expect((await F.luciaC.put(`/api/goals/${b.id}/auto`, { percent: 30 })).body.auto_pending_percent).toBe(30);
    expect((await F.mama.post(`/api/goals/${b.id}/auto/reject`, {})).status).toBe(200);
    expect((await goalsOf()).find((x) => x.id === b.id)).toMatchObject({ auto_percent: 0, auto_pending_percent: null });
    expect((await F.mama.post(`/api/goals/${b.id}/auto/reject`, {})).status).toBe(409);
    expect((await F.luciaC.put(`/api/goals/${a.id}/auto`, { percent: 0 })).body.auto_percent).toBe(0);
    expect((await F.luciaC.put(`/api/goals/${a.id}/auto`, { percent: 101 })).status).toBe(400);
  });
});

describe('I19 · aporte de los padres y aportes puntuales', () => {
  it('regla «1 por cada 4 ahorrados» con tope: se suma al ahorrar y no pasa del tope', async () => {
    const g = await activeGoal(10000);
    await giveMoney(L(), 5000);
    expect((await F.luciaC.put(`/api/goals/${g.id}/match`, { perCents: 400, givesCents: 100, capCents: 300 })).status).toBe(403);
    expect((await F.mama.put(`/api/goals/${g.id}/match`, { perCents: 100, givesCents: 400, capCents: 300 })).status).toBe(400); // más que lo ahorrado
    expect((await F.mama.put(`/api/goals/${g.id}/match`, { perCents: 400, givesCents: 100, capCents: 300 })).status).toBe(200);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 800 }, { 'idempotency-key': 'dep-12345678' });
    let a = (await goalsOf()).find((x) => x.id === g.id);
    expect(a).toMatchObject({ balance_cents: 1000, matched_cents: 200, contributions_cents: 200, principal_cents: 800 });
    expect((await notes(L(), 'goal_match')).at(-1)!.title).toContain('2,00 €');
    // Un reintento con la misma clave no duplica el aporte.
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 800 }, { 'idempotency-key': 'dep-12345678' });
    expect((await goalsOf()).find((x) => x.id === g.id).balance_cents).toBe(1000);
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 2000 }); // pediría 5 €, pero solo quedan 1 € de tope
    a = (await goalsOf()).find((x) => x.id === g.id);
    expect(a.matched_cents).toBe(300);
    expect(a.balance_cents).toBe(3100); // 8 + 2 de aporte + 20 + 1 (lo que quedaba de tope)
    // Quitar la regla no toca lo ya aportado.
    expect((await F.mama.put(`/api/goals/${g.id}/match`, null)).status).toBe(200);
    expect((await goalsOf()).find((x) => x.id === g.id)).toMatchObject({ match_per_cents: null, matched_cents: 300 });
  });

  it('si saca el ahorro antes de llegar, el aporte de los padres se pierde como el interés', async () => {
    const g = await activeGoal(10000);
    await giveMoney(L(), 400);
    await F.mama.put(`/api/goals/${g.id}/match`, { perCents: 400, givesCents: 100, capCents: 1000 });
    await F.luciaC.post(`/api/goals/${g.id}/deposit`, { cents: 400 });
    const w = await F.luciaC.post(`/api/goals/${g.id}/withdraw`);
    expect(w.body).toMatchObject({ principal_cents: 400, forfeited_cents: 100 });
    expect((await F.luciaC.get(`/api/bank/${L()}`)).body.bank.money_cents).toBe(400);
  });

  it('aporte puntual de un adulto: queda en el libro con su autor y se anula con un asiento contrario', async () => {
    const g = await activeGoal(5000);
    const r = await F.papaC.post(`/api/goals/${g.id}/gift`, { cents: 500, message: 'Por el boletín' }, { 'idempotency-key': 'gift-12345678' });
    expect(r.status).toBe(200);
    expect((await F.papaC.post(`/api/goals/${g.id}/gift`, { cents: 500, message: 'Por el boletín' }, { 'idempotency-key': 'gift-12345678' })).body.duplicate).toBe(true);
    const aviso = (await notes(L(), 'goal_gift'))[0];
    expect(aviso.title).toContain('Papá (Pareja)');
    expect(aviso.body).toBe('Por el boletín');
    const entry = await one(pool(), `SELECT * FROM money_ledger WHERE kind = 'goal_gift'`);
    expect(entry).toMatchObject({ delta_cents: 500, account: 'savings', created_by: F.ids.papa });
    expect((await F.luciaC.post(`/api/goals/${g.id}/gift`, { cents: 500 })).status).toBe(403); // el hijo no se aporta a sí mismo
    // Anular: el original no se toca; se añade el contrario.
    expect((await F.luciaC.post(`/api/goals/${g.id}/contributions/${entry.id}/reverse`)).status).toBe(403);
    expect((await F.mama.post(`/api/goals/${g.id}/contributions/${entry.id}/reverse`)).status).toBe(200);
    expect((await F.mama.post(`/api/goals/${g.id}/contributions/${entry.id}/reverse`)).body.duplicate).toBe(true);
    const rows = await many(pool(), `SELECT kind, delta_cents FROM money_ledger WHERE goal_id = $1 ORDER BY seq`, [g.id]);
    expect(rows).toEqual([{ kind: 'goal_gift', delta_cents: 500 }, { kind: 'goal_reversal', delta_cents: -500 }]);
    expect((await goalsOf()).find((x) => x.id === g.id).balance_cents).toBe(0);
    await expect(pool().query(`UPDATE money_ledger SET delta_cents = 1 WHERE id = $1`, [entry.id])).rejects.toThrow(/no se pueden modificar/);
  });
});

describe('I19 · foto de la meta', () => {
  const upload = async (c: Client, goalId: string) => {
    const png = await sharp({ create: { width: 60, height: 40, channels: 3, background: '#e44' } }).png().toBuffer();
    const b = 'XBOUNDARYX';
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="m.png"\r\nContent-Type: image/png\r\n\r\n`),
      png,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    return c.req('POST', `/api/goals/${goalId}/photo`, body, { 'content-type': `multipart/form-data; boundary=${b}` });
  };

  it('se procesa como las demás, la ve su dueño y los adultos, y no caduca a los 7 días mientras la meta esté activa', async () => {
    const g = await activeGoal(5000);
    expect((await upload(F.luciaC, g.id)).status).toBe(200);
    const row = await one(pool(), 'SELECT photo_path FROM savings_goals WHERE id = $1', [g.id]);
    const abs = path.resolve(config.uploadDir, row.photo_path);
    expect(fs.existsSync(abs)).toBe(true);
    expect((await goalsOf()).find((x) => x.id === g.id).has_photo).toBe(true);
    expect((await goalsOf()).find((x) => x.id === g.id).photo_path).toBeUndefined(); // la ruta no sale de la API
    expect((await F.mama.get(`/api/goals/${g.id}/photo`)).status).toBe(200);
    expect((await F.hugoC.get(`/api/goals/${g.id}/photo`)).status).toBe(403); // un hermano no
    // 30 días después: sigue (las fotos de tareas validadas caducan a los 7).
    const later = new Date(Date.now() + 30 * 86400_000);
    await runCleanup(later);
    expect(fs.existsSync(abs)).toBe(true);
    expect((await one(pool(), 'SELECT photo_path FROM savings_goals WHERE id = $1', [g.id])).photo_path).toBeTruthy();
    // Sustituir la foto borra la anterior.
    const mama = new Client(app); // la limpieza de +30 días también cerró las sesiones caducadas
    await mama.post('/api/auth/login', { username: 'fmama', password: 'contrasena-segura' });
    expect((await upload(mama, g.id)).status).toBe(200);
    expect(fs.existsSync(abs)).toBe(false);
    const row2 = await one(pool(), 'SELECT photo_path FROM savings_goals WHERE id = $1', [g.id]);
    // Cerrada la meta, sí caduca (pasados los días).
    await pool().query(`UPDATE savings_goals SET status = 'bought', closed_at = now() WHERE id = $1`, [g.id]);
    await runCleanup(new Date(Date.now() + 3 * 86400_000));
    expect(fs.existsSync(path.resolve(config.uploadDir, row2.photo_path))).toBe(true);
    await runCleanup(new Date(Date.now() + 9 * 86400_000));
    expect(fs.existsSync(path.resolve(config.uploadDir, row2.photo_path))).toBe(false);
    expect((await one(pool(), 'SELECT photo_path FROM savings_goals WHERE id = $1', [g.id])).photo_path).toBeNull();
  });

  it('un archivo que no es una imagen se rechaza', async () => {
    const g = await activeGoal(5000);
    const b = 'XB';
    const body = Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="photo"; filename="m.png"\r\nContent-Type: image/png\r\n\r\nno soy una foto, solo texto largo\r\n--${b}--\r\n`);
    expect((await F.luciaC.req('POST', `/api/goals/${g.id}/photo`, body, { 'content-type': `multipart/form-data; boundary=${b}` })).status).toBe(400);
  });
});

describe('I20 · parentesco, cuenta principal e invitaciones', () => {
  it('quien crea la familia es la cuenta principal; madre, padre, pareja y tutor son adultos completos', async () => {
    const me = (await F.mama.get('/api/me')).body.user;
    expect(me).toMatchObject({ is_principal: true, is_relative: false });
    expect((await F.papaC.get('/api/me')).body.user).toMatchObject({ is_principal: false, is_relative: false });
    const tutor = await invite('guardian', 'Tutor', 'tutor1');
    expect((await tutor.c.get('/api/me')).body.user).toMatchObject({ role: 'adult', relationship: 'guardian', is_relative: false, is_principal: false });
    // Un tutor/a legal puede validar, ajustar y tocar la configuración exactamente como un padre.
    expect((await tutor.c.get('/api/dashboard')).status).toBe(200);
    expect((await tutor.c.post('/api/adjustments/points', { userId: L(), delta: 10, note: 'Premio' })).status).toBe(200);
    expect((await tutor.c.patch('/api/family', { name: 'Familia Nueva' })).status).toBe(200);
    expect((await tutor.c.get('/api/privacy/export')).status).toBe(200);
    // ...y solo la cuenta principal reparte invitaciones y quita adultos.
    for (const c of [F.papaC, tutor.c]) {
      expect((await c.post('/api/invitations', { email: 'x@example.com', displayName: 'X', relationship: 'mother' })).status).toBe(403);
      expect((await c.get('/api/invitations')).status).toBe(403);
      expect((await c.post('/api/members', { role: 'adult', displayName: 'Z', username: 'zzz123', password: 'contrasena-larga' })).status).toBe(403);
      expect((await c.patch(`/api/members/${F.ids.mama}`, { active: false })).status).toBe(403);
      expect((await c.patch(`/api/members/${F.ids.mama}`, { relationship: 'father' })).status).toBe(403);
    }
    // Los hijos los puede añadir y editar cualquier adulto completo.
    expect((await F.papaC.post('/api/members', { role: 'child', displayName: 'Nico', username: 'nico123', password: '9999' })).status).toBe(200);
  });

  it('la invitación lleva nombre, parentesco, correo y teléfono, se envía por correo y crea la cuenta con esos datos', async () => {
    expect((await F.mama.post('/api/invitations', { email: 'abu@example.com', displayName: 'Rosa', relationship: 'other' })).status).toBe(400); // «Otro» pide texto
    expect((await F.mama.post('/api/invitations', { email: 'abu@example.com', displayName: 'Rosa', relationship: 'primo' })).status).toBe(400);
    expect((await F.mama.post('/api/invitations', { email: 'abu@example.com', displayName: 'Rosa', relationship: 'grandparent', phone: '123' })).status).toBe(400);
    const r = await F.mama.post('/api/invitations', { email: 'Rosa@Example.com', displayName: 'Rosa', relationship: 'grandparent', phone: '612 34 56 78' });
    expect(r.status).toBe(200);
    await processOutbox();
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('rosa@example.com');
    expect(email.sent[0].subject).toContain('Mamá');
    expect(email.sent[0].body).toMatch(/ver cómo van las tareas.*animar/);
    const token = tokenFrom(email.sent[0].link);
    const anon = new Client(app);
    expect((await anon.post('/api/invitations/lookup', { token })).body.invitation).toMatchObject({ display_name: 'Rosa', relationship: 'grandparent' });
    expect((await anon.post('/api/invitations/accept', { token, username: 'rosa', password: 'contrasena-larga', acceptTerms: true, termsVersion: 'vieja' })).body.error).toBe('terms_outdated');
    const acc = await anon.post('/api/invitations/accept', { token, username: 'rosa', password: 'contrasena-larga', ...consent });
    expect(acc.body.user).toMatchObject({ relationship: 'grandparent', is_relative: true, is_principal: false, phone: '+34612345678', email: 'rosa@example.com' });
    // En Familia se ve el parentesco; la principal ve la lista de invitaciones con su estado.
    const fam = (await F.mama.get('/api/family')).body.members.find((m: any) => m.id === acc.body.user.id);
    expect(fam).toMatchObject({ relationship: 'grandparent', is_relative: true });
    expect((await F.mama.get('/api/invitations')).body.invitations[0]).toMatchObject({ relationship: 'grandparent' });
    // «Otro» con texto libre.
    const vecina = await invite('other', 'Marta', 'marta', { relationshipLabel: 'Vecina' });
    expect((await vecina.c.get('/api/me')).body.user).toMatchObject({ relationship: 'other', relationship_label: 'Vecina', is_relative: true });
    expect(kinshipText('other', 'Vecina')).toBe('Vecina');
    expect(whoText('Marta', 'other', 'Vecina')).toBe('Marta (Vecina)');
    expect(kinshipText('guardian')).toBe('Tutor/a legal');
  });

  it('una invitación sin usar se puede anular y entonces ya no sirve', async () => {
    await F.mama.post('/api/invitations', { email: 'tio@example.com', displayName: 'Tío', relationship: 'aunt_uncle' });
    await processOutbox();
    const token = tokenFrom(email.sent[0].link);
    const id = (await F.mama.get('/api/invitations')).body.invitations[0].id;
    expect((await F.papaC.post(`/api/invitations/${id}/cancel`)).status).toBe(403);
    expect((await F.mama.post(`/api/invitations/${id}/cancel`)).status).toBe(200);
    expect((await new Client(app).post('/api/invitations/lookup', { token })).status).toBe(404);
  });

  it('Mi perfil: el invitado cambia nombre, teléfono y correo; los hijos no cambian los suyos', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa', { phone: '612345678' });
    const r = await abu.c.patch('/api/me', { displayName: 'Rosa María', phone: '+34 699 11 22 33' });
    expect(r.body.user).toMatchObject({ display_name: 'Rosa María', phone: '+34699112233' });
    expect((await abu.c.put('/api/me/email', { email: 'nuevo@example.com' })).body.user.email).toBe('nuevo@example.com');
    expect((await abu.c.patch('/api/me', { phone: '' })).body.user.phone).toBeNull();
    expect((await abu.c.patch('/api/me', { phone: 'abc' })).status).toBe(400);
    expect((await F.luciaC.patch('/api/me', { displayName: 'Otra' })).status).toBe(403);
    expect((await F.papaC.patch('/api/me', { displayName: 'Papá Pablo' })).body.user.display_name).toBe('Papá Pablo');
  });

  it('la principal cede el papel a otro adulto completo (con su contraseña), nunca a un pariente', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    expect((await F.papaC.post('/api/family/principal', { userId: F.ids.papa, password: 'otra-contrasena' })).status).toBe(403);
    expect((await F.mama.post('/api/family/principal', { userId: abu.id, password: 'contrasena-segura' })).body.error).toBe('not_full_adult');
    expect((await F.mama.post('/api/family/principal', { userId: F.ids.papa, password: 'mala' })).status).toBe(400);
    expect((await F.mama.post('/api/family/principal', { userId: F.ids.lucia, password: 'contrasena-segura' })).status).toBe(400);
    expect((await F.mama.patch(`/api/members/${F.ids.mama}`, { active: false })).status).toBe(400);
    expect((await F.mama.post('/api/family/principal', { userId: F.ids.papa, password: 'contrasena-segura' })).status).toBe(200);
    expect((await F.mama.get('/api/me')).body.user.is_principal).toBe(false);
    expect((await F.papaC.get('/api/me')).body.user.is_principal).toBe(true);
    expect((await notes(F.ids.papa, 'family_change'))[0].title).toContain('cuenta principal');
    // Ahora Mamá ya no puede invitar y Papá sí.
    expect((await F.mama.post('/api/invitations', { email: 'a@example.com', displayName: 'A', relationship: 'mother' })).status).toBe(403);
    expect((await F.papaC.post('/api/invitations', { email: 'a@example.com', displayName: 'A', relationship: 'mother' })).status).toBe(200);
    // Y puede quitar a la antigua principal, que ya es un adulto más.
    expect((await F.papaC.patch(`/api/members/${F.ids.mama}`, { active: false })).status).toBe(200);
    expect(await one(pool(), `SELECT count(*)::int AS n FROM users WHERE family_id = $1 AND is_principal`, [F.ids.family])).toEqual({ n: 1 });
  });

  it('la migración marca como principal al primer adulto de cada familia ya existente', async () => {
    await pool().query('UPDATE users SET is_principal = false');
    const sql = fs.readFileSync(path.resolve(__dirname, '../migrations/015_goals_relatives_currency.sql'), 'utf8');
    await pool().query(sql); // idempotente: se puede volver a aplicar
    const p = await many(pool(), `SELECT username FROM users WHERE is_principal`);
    expect(p).toEqual([{ username: 'fmama' }]);
  });

  it('los avisos de gestión llegan a los adultos completos y no a los parientes', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    await F.luciaC.post('/api/goals', { userId: L(), title: 'Bici', targetCents: 1000 });
    expect(await notes(F.ids.mama, 'goal_proposed')).toHaveLength(1);
    expect(await notes(F.ids.papa, 'goal_proposed')).toHaveLength(1);
    expect(await notes(abu.id, 'goal_proposed')).toHaveLength(0);
  });
});

describe('I20 · pariente: ver y animar, y nada más (cada ruta en el servidor)', () => {
  it('cada ruta no permitida responde 403 a un pariente, aunque el cuerpo y los datos sean válidos', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    const tio = await invite('aunt_uncle', 'Tito', 'tito');
    const uuid = '00000000-0000-4000-8000-000000000001';
    const allowed = new Set([...RELATIVE_ALLOWED, ...PUBLIC_ROUTES]);
    const routes = app.routeList.filter((r) => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(r.method) && r.url.startsWith('/api/'));
    expect(routes.length).toBeGreaterThan(100);
    const forbiddenRoutes: string[] = [];
    for (const r of routes) {
      if (allowed.has(`${r.method} ${r.url}`)) continue;
      const url = r.url.replace(/:\w+/g, uuid);
      const res = await (r.method === 'GET' || r.method === 'DELETE' ? abu.c.req(r.method, url) : abu.c.req(r.method, url, {}));
      expect(res.status, `${r.method} ${r.url} → ${res.status} ${JSON.stringify(res.body)}`).toBe(403);
      forbiddenRoutes.push(`${r.method} ${r.url}`);
    }
    expect(forbiddenRoutes.length).toBeGreaterThan(90);
    // Las acciones más delicadas, con datos reales, tampoco (hay un niño, una meta y una tarea de verdad).
    const g = await activeGoal(5000);
    const bodies: [string, string, unknown][] = [
      ['POST', `/api/goals/${g.id}/proposal/approve`, {}],
      ['PUT', `/api/goals/${g.id}/auto`, { percent: 10 }],
      ['PUT', `/api/goals/${g.id}/match`, { perCents: 400, givesCents: 100, capCents: 500 }],
      ['POST', `/api/goals/${g.id}/deposit`, { cents: 100 }],
      ['POST', `/api/goals/${g.id}/redeem`, {}],
      ['DELETE', `/api/goals/${g.id}`, undefined],
      ['POST', '/api/goals', { userId: L(), title: 'X', targetCents: 100 }],
      ['POST', '/api/payments', { userId: L(), amountCents: 100, method: 'cash' }],
      ['POST', '/api/adjustments/points', { userId: L(), delta: 10, note: 'x' }],
      ['POST', '/api/allowance/settle', { userId: L() }],
      ['PATCH', '/api/family', { name: 'Hackeada' }],
      ['POST', '/api/members', { role: 'child', displayName: 'N', username: 'nnnn', password: '1234' }],
      ['PATCH', `/api/members/${L()}`, { active: false }],
      ['POST', `/api/members/${L()}/delete`, { password: 'contrasena-larga' }],
      ['POST', '/api/invitations', { email: 'q@example.com', displayName: 'Q', relationship: 'mother' }],
      ['GET', '/api/privacy/export', undefined],
      ['POST', '/api/privacy/delete-family', { password: 'contrasena-larga', phrase: 'BORRAR MI FAMILIA' }],
      ['POST', '/api/tasks', { title: 'T' }],
      ['GET', '/api/tasks', undefined],
      ['GET', '/api/dashboard', undefined],
      ['GET', '/api/activity', undefined],
      ['GET', `/api/bank/${L()}`, undefined],
      ['GET', `/api/wallet/${L()}`, undefined],
      ['GET', '/api/notify/settings', undefined],
      ['PUT', `/api/notify/contact/${F.ids.mama}`, { phone: '+34600000000', whatsappConsent: true }],
      ['POST', '/api/family/principal', { userId: tio.id, password: 'contrasena-larga' }],
    ];
    for (const [m, u, b] of bodies) {
      const res = await abu.c.req(m, u, b);
      expect(res.status, `${m} ${u}`).toBe(403);
    }
    // Nada cambió.
    expect((await F.mama.get('/api/me')).body.family.name).toBe('Familia f');
    expect(await one(pool(), `SELECT count(*)::int AS n FROM payments`)).toEqual({ n: 0 });
    expect((await goalsOf()).find((x) => x.id === g.id)).toMatchObject({ balance_cents: 0, auto_percent: 0, status: 'active' });
    // Cada ruta permitida existe de verdad (la lista no apunta a rutas que ya no están).
    for (const k of RELATIVE_ALLOWED) expect(routes.some((r) => `${r.method} ${r.url}` === k), k).toBe(true);
    // Un hijo y un adulto completo nunca quedan afectados por esta puerta.
    expect((await F.papaC.get('/api/dashboard')).status).toBe(200);
    expect((await F.luciaC.get(`/api/progress/${L()}`)).status).toBe(200);
  });

  it('puede ver el progreso de los niños y las metas, pero no usuarios, teléfonos ni gestión', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    const g = await activeGoal(5000);
    const ov = (await abu.c.get('/api/relative/overview')).body.children as any[];
    expect(ov.map((c) => c.display_name).sort()).toEqual(['Hugo', 'Lucía']);
    const lucia = ov.find((c) => c.id === L());
    expect(lucia.goals).toEqual([expect.objectContaining({ id: g.id, title: 'Vinilo', target_cents: 5000, balance_cents: 0 })]);
    expect(lucia).toHaveProperty('week.points');
    expect((await abu.c.get(`/api/progress/${L()}`)).status).toBe(200);
    expect((await abu.c.get(`/api/goals/${L()}`)).status).toBe(200);
    const fam = (await abu.c.get('/api/family')).body.members as any[];
    expect(fam.length).toBe(5);
    for (const m of fam.filter((x) => x.display_name !== 'Rosa')) {
      expect(m).not.toHaveProperty('username');
      expect(m).not.toHaveProperty('phone');
    }
    expect(fam.find((m) => m.display_name === 'Rosa')).toMatchObject({ relationship: 'grandparent' });
  });

  it('felicita con un mensaje corto que le llega al niño, con un límite por hora', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    expect((await abu.c.post('/api/cheers', { toUserId: L(), message: '' })).status).toBe(400);
    expect((await abu.c.post('/api/cheers', { toUserId: L(), message: 'x'.repeat(141) })).status).toBe(400);
    expect((await abu.c.post('/api/cheers', { toUserId: F.ids.papa, message: 'Hola' })).status).toBe(404); // solo a hijos
    expect((await abu.c.post('/api/cheers', { toUserId: L(), message: '¡Qué orgullo, Lucía!' })).status).toBe(200);
    const n = (await notes(L(), 'cheer'))[0];
    expect(n).toMatchObject({ title: expect.stringContaining('Rosa (Abuelo/a) te felicita'), body: '¡Qué orgullo, Lucía!' });
    expect((await notes(F.ids.mama, 'relative_activity'))[0].title).toContain('Rosa (Abuelo/a) ha felicitado a Lucía');
    for (let i = 0; i < 9; i++) await abu.c.post('/api/cheers', { toUserId: L(), message: `Otra ${i}` });
    expect((await abu.c.post('/api/cheers', { toUserId: L(), message: 'Una más' })).body.error).toBe('cheer_limit');
    // Los adultos completos también pueden felicitar.
    expect((await F.papaC.post('/api/cheers', { toUserId: L(), message: 'Bien hecho' })).status).toBe(200);
    // Un hijo no felicita.
    expect((await F.hugoC.post('/api/cheers', { toUserId: L(), message: 'Jo' })).status).toBe(403);
  });

  it('da un aporte a una meta, con topes, y avisa al niño y a los padres; no a metas por aprobar', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    const g = await activeGoal(10000);
    const prop = (await F.luciaC.post('/api/goals', { userId: L(), title: 'Otra', targetCents: 1000 })).body.goal;
    expect((await abu.c.post(`/api/goals/${prop.id}/gift`, { cents: 100 })).status).toBe(409);
    expect((await abu.c.post(`/api/goals/${g.id}/gift`, { cents: 50001 })).body.error).toBe('gift_too_big');
    expect((await abu.c.post(`/api/goals/${g.id}/gift`, { cents: 0 })).status).toBe(400);
    const ok = await abu.c.post(`/api/goals/${g.id}/gift`, { cents: 2000, message: 'Para tu cumple' });
    expect(ok.status).toBe(200);
    expect((await goalsOf()).find((x) => x.id === g.id)).toMatchObject({ balance_cents: 2000, contributions_cents: 2000 });
    expect((await notes(L(), 'goal_gift'))[0].title).toContain('Rosa (Abuelo/a) ha puesto 20,00 €');
    expect((await notes(F.ids.papa, 'relative_activity'))[0].title).toContain('Rosa (Abuelo/a) ha aportado 20,00 €');
    // Tope diario por pariente.
    await abu.c.post(`/api/goals/${g.id}/gift`, { cents: 50000 });
    expect((await abu.c.post(`/api/goals/${g.id}/gift`, { cents: 50000 })).body.error).toBe('gift_day_limit');
    // El libro dice quién lo puso.
    expect(await one(pool(), `SELECT note, created_by FROM money_ledger WHERE kind = 'goal_gift' ORDER BY seq LIMIT 1`)).toMatchObject({ note: 'Aporte de Rosa (Abuelo/a): Para tu cumple', created_by: abu.id });
  });

  it('quitar a un pariente cierra su acceso al instante', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    expect((await abu.c.get('/api/me')).status).toBe(200);
    expect((await F.mama.patch(`/api/members/${abu.id}`, { active: false })).status).toBe(200);
    expect((await abu.c.get('/api/me')).status).toBe(401);
    expect((await new Client(app).post('/api/auth/login', { username: 'rosa', password: 'contrasena-larga' })).status).toBe(401);
    // Se puede reactivar y cambiarle el parentesco (solo la principal).
    expect((await F.mama.patch(`/api/members/${abu.id}`, { active: true, relationship: 'mother' })).status).toBe(200);
    expect((await new Client(app).post('/api/auth/login', { username: 'rosa', password: 'contrasena-larga' })).body.user).toMatchObject({ relationship: 'mother', is_relative: false });
  });
});

describe('I20 · correo y teléfono de otros miembros: la cuenta principal o la propia persona', () => {
  it('la principal los pone en adultos, parientes e hijos, con el mismo formato que Mi perfil, y queda en el registro', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    for (const id of [F.ids.papa, abu.id, L()]) {
      expect((await F.mama.put(`/api/notify/contact/${id}`, { email: 'no-es-correo', phone: '600112233', whatsappConsent: false })).status).toBe(400);
      expect((await F.mama.put(`/api/notify/contact/${id}`, { email: null, phone: '12', whatsappConsent: false })).status).toBe(400);
    }
    expect((await F.mama.put(`/api/notify/contact/${abu.id}`, { email: 'rosa.nueva@example.com', phone: '699 11 22 33', whatsappConsent: true })).status).toBe(200);
    expect((await F.mama.put(`/api/notify/contact/${F.ids.papa}`, { email: 'papa@example.com', phone: '+34 611 22 33 44', whatsappConsent: true })).status).toBe(200);
    expect((await F.mama.put(`/api/notify/contact/${L()}`, { email: 'lucia@example.com', phone: '622 33 44 55', whatsappConsent: true })).status).toBe(200);
    expect(await one(pool(), `SELECT email, phone, whatsapp_consent_at IS NOT NULL AS consent FROM users WHERE id = $1`, [abu.id])).toEqual({ email: 'rosa.nueva@example.com', phone: '+34699112233', consent: false }); // el permiso de WhatsApp lo da ella
    expect(await one(pool(), `SELECT email, phone, whatsapp_consent_at IS NOT NULL AS consent FROM users WHERE id = $1`, [L()])).toEqual({ email: 'lucia@example.com', phone: '+34622334455', consent: true }); // al niño lo autoriza un adulto
    // Un correo ya usado por otra cuenta no vale.
    expect((await F.mama.put(`/api/notify/contact/${abu.id}`, { email: 'papa@example.com', phone: null, whatsappConsent: false })).status).toBe(400);
    // Registro de actividad (sin guardar el dato en sí) y aviso en la app a la persona con cuenta.
    const log = await many(pool(), `SELECT data FROM audit_log WHERE action = 'notify.contact_update' AND entity_id = $1`, [abu.id]);
    expect(log[0].data).toMatchObject({ for: abu.id, email: 'cambiado', phone: 'cambiado' });
    expect(JSON.stringify(log)).not.toContain('rosa.nueva');
    expect((await notes(abu.id, 'family_change'))[0]).toMatchObject({ title: expect.stringContaining('Mamá ha cambiado tu correo y tu teléfono'), link: '/perfil' });
    expect(await notes(L(), 'family_change')).toHaveLength(0); // al niño no se le avisa de esto
    // Y el pariente lo puede cambiar él mismo en Mi perfil.
    expect((await abu.c.put('/api/me/email', { email: 'rosa.suya@example.com' })).status).toBe(200);
    expect((await abu.c.patch('/api/me', { phone: '655 44 33 22' })).body.user.phone).toBe('+34655443322');
  });

  it('el otro adulto y los parientes no pueden cambiar los datos de otra persona (403); cada uno sí los suyos', async () => {
    const abu = await invite('grandparent', 'Rosa', 'rosa');
    const body = { email: 'x@example.com', phone: '600 11 22 33', whatsappConsent: false };
    for (const id of [F.ids.mama, abu.id, L(), F.ids.hugo]) expect((await F.papaC.put(`/api/notify/contact/${id}`, body)).status).toBe(403);
    for (const id of [F.ids.mama, F.ids.papa, L()]) expect((await abu.c.put(`/api/notify/contact/${id}`, body)).status).toBe(403);
    expect((await F.luciaC.put(`/api/notify/contact/${L()}`, body)).status).toBe(403);
    expect(await one(pool(), `SELECT count(*)::int AS n FROM users WHERE email = 'x@example.com' OR phone = '+34600112233'`)).toEqual({ n: 0 });
    // Uno mismo, sí (el otro adulto cambia el suyo).
    expect((await F.papaC.put(`/api/notify/contact/${F.ids.papa}`, { email: 'papa.suyo@example.com', phone: '600 11 22 33', whatsappConsent: true })).status).toBe(200);
    expect((await F.papaC.get('/api/me')).body.user).toMatchObject({ email: 'papa.suyo@example.com', phone: '+34600112233' });
    // La principal no se avisa a sí misma.
    expect((await notes(F.ids.papa, 'family_change'))).toHaveLength(0);
  });

  it('los avisos ya encolados usan siempre el dato más reciente', async () => {
    await F.mama.put(`/api/notify/contact/${F.ids.papa}`, { email: 'papa.viejo@example.com', phone: null, whatsappConsent: false });
    await pool().query(`INSERT INTO notification_outbox(family_id, user_id, to_address, event, channel, subject, body, dedupe_key) VALUES ($1,$2,'papa.viejo@example.com','payment','email','Hola','x','k1')`, [F.ids.family, F.ids.papa]);
    await F.mama.put(`/api/notify/contact/${F.ids.papa}`, { email: 'papa.nuevo@example.com', phone: null, whatsappConsent: false });
    expect((await one(pool(), `SELECT to_address FROM notification_outbox WHERE dedupe_key = 'k1'`)).to_address).toBe('papa.nuevo@example.com');
    await F.mama.put(`/api/notify/contact/${F.ids.papa}`, { email: '', phone: null, whatsappConsent: false });
    expect((await one(pool(), `SELECT status FROM notification_outbox WHERE dedupe_key = 'k1'`)).status).toBe('skipped');
  });
});
