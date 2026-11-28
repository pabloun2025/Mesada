import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, many, one, tx } from '../src/lib/db.js';
import { addDays, isoWeekday, startOfWeek, todayIn } from '../src/lib/dates.js';
import { addScreen, screenBalance } from '../src/lib/screen.js';
import { addMoney, addPoints, moneyBalance, pointsBalance } from '../src/lib/ledger.js';
import { zonedToUtc } from '../src/lib/notify/time.js';
import { approveSession, closeDueSessions, createBlock, runScreenDebts, runScreenSessions, screenState, startSession, stopSession, warnExpiringLots } from '../src/lib/screen-sessions.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { setSetting } from '../src/lib/settings.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const TZ = 'Europe/Madrid';
const pool = () => getPool();
const today = () => todayIn(TZ);

beforeAll(async () => { app = await buildApp({ logger: false }); });
afterAll(async () => { await app.close(); await closePool(); });
beforeEach(async () => { resetLoginFailures(); await resetDb(); F = await createFamily(app); });

const L = () => F.ids.lucia;
const adultUser = () => ({ id: F.ids.mama, familyId: F.ids.family, role: 'adult' as const, displayName: 'Mamá', username: 'fmama' });
const kidUser = () => ({ id: L(), familyId: F.ids.family, role: 'child' as const, displayName: 'Lucía', username: 'flucia' });
const give = (minutes: number, userId = L()) => tx((db) => addScreen(db, { familyId: F.ids.family, userId, delta: minutes, kind: 'bonus', note: 'test' }));
const notes = (u: string, kind?: string) => many(pool(), `SELECT * FROM notifications WHERE user_id=$1 AND ($2::text IS NULL OR kind=$2) ORDER BY created_at, id`, [u, kind ?? null]);
/** Hace como si la sesión llevara `min` minutos en marcha (sin esperar). */
const age = (id: string, min: number) => pool().query(`UPDATE screen_sessions SET started_at = started_at - make_interval(mins => $2), planned_end_at = planned_end_at - make_interval(mins => $2) WHERE id = $1`, [id, min]);
const start = async (c = F.luciaC, body: any = { minutes: 30 }) => c.post('/api/screen/sessions', body);
const state = async (c = F.luciaC, id = L()) => (await c.get(`/api/screen/${id}/state`)).body;
const at = (time: string) => zonedToUtc(today(), time, TZ);

describe('Sesiones de pantalla (I21)', () => {
  it('el hijo empieza, el servidor guarda inicio y fin previsto, y al parar se descuenta lo usado de verdad', async () => {
    await give(60);
    const r = await start(F.luciaC, { minutes: 30, category: 'videojuegos' });
    expect(r.status).toBe(200);
    const s = r.body.session;
    expect(s).toMatchObject({ status: 'running', requested_minutes: 30, started_by: L(), category: 'videojuegos' });
    expect(Date.parse(s.planned_end_at) - Date.parse(s.started_at)).toBe(30 * 60_000);
    // Se puede recargar o abrir desde otro móvil: el estado sale del servidor.
    const st = await state(F.luciaC);
    expect(st.session.id).toBe(s.id);
    expect(st.can_start).toBe(false);
    expect(st.balance).toBe(60); // aún no se ha descontado
    // Otra sesión a la vez no vale.
    expect((await start(F.luciaC, { minutes: 5 })).body.error).toBe('open');
    await age(s.id, 12);
    const stop = await F.luciaC.post(`/api/screen/sessions/${s.id}/stop`);
    expect(stop.status).toBe(200);
    expect(stop.body.session).toMatchObject({ status: 'finished', used_minutes: 12, charged_minutes: 12, end_reason: 'stopped', stopped_by: L() });
    expect(await screenBalance(pool(), L())).toBe(48);
    expect(await one(pool(), `SELECT kind, delta FROM screen_ledger WHERE user_id = $1 AND kind = 'session'`, [L()])).toEqual({ kind: 'session', delta: -12 });
    // Parar dos veces no cobra dos veces.
    expect((await F.luciaC.post(`/api/screen/sessions/${s.id}/stop`)).body.duplicate).toBe(true);
    expect(await screenBalance(pool(), L())).toBe(48);
    // El padre se entera cuando el hijo empieza y cuando para.
    expect((await notes(F.ids.mama, 'screen_started'))).toHaveLength(1);
    expect((await notes(F.ids.mama, 'screen_stopped'))[0].title).toContain('Lucía ha parado');
  });

  it('se gasta primero lo que caduca antes (el plan de la semana antes que lo ganado)', async () => {
    await F.mama.put(`/api/screen/plans/${L()}`, { minutesPerWeek: 20, enabled: true });
    await give(30);
    const s = (await start(F.luciaC, { minutes: 25 })).body.session;
    await age(s.id, 25);
    await F.luciaC.post(`/api/screen/sessions/${s.id}/stop`);
    const lots = await many(pool(), `SELECT source, remaining FROM screen_lots WHERE user_id = $1 ORDER BY source`, [L()]);
    expect(lots).toEqual([{ source: 'earned', remaining: 25 }, { source: 'plan', remaining: 0 }]);
  });

  it('no deja empezar con más minutos de los que hay ni sin saldo, y explica por qué', async () => {
    expect((await start()).body).toMatchObject({ error: 'no_balance' });
    await give(20);
    const r = await start(F.luciaC, { minutes: 30 });
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('too_long');
    expect(r.body.message ?? r.body.error).toBeTruthy();
    expect((await start(F.luciaC, { minutes: 20 })).status).toBe(200);
  });

  it('un adulto pone en marcha y para el temporizador del hijo, y el hijo recibe aviso', async () => {
    await give(40);
    const r = await F.papaC.post('/api/screen/sessions', { userId: L(), minutes: 15, note: 'TikTok' });
    expect(r.status).toBe(200);
    expect(r.body.session).toMatchObject({ status: 'running', started_by: F.ids.papa, extra: true });
    expect((await notes(L(), 'screen_parent_started'))[0].title).toContain('Papá ha puesto en marcha tu pantalla');
    // Otro hijo no puede pararla.
    expect((await F.hugoC.post(`/api/screen/sessions/${r.body.session.id}/stop`)).status).toBe(403);
    const ext = await F.mama.post(`/api/screen/sessions/${r.body.session.id}/extend`, { minutes: 10 });
    expect(ext.body.session.extended_minutes).toBe(10);
    expect((await F.luciaC.post(`/api/screen/sessions/${r.body.session.id}/extend`, { minutes: 10 })).status).toBe(403);
    await age(r.body.session.id, 5);
    const stop = await F.mama.post(`/api/screen/sessions/${r.body.session.id}/stop`);
    expect(stop.body.session).toMatchObject({ used_minutes: 5, stopped_by: F.ids.mama });
    expect((await notes(L(), 'screen_stopped'))[0].title).toContain('Mamá ha parado tu pantalla');
  });

  it('la familia puede exigir aprobación: la sesión espera a un adulto y solo entonces arranca', async () => {
    await give(30);
    expect((await F.mama.put(`/api/screen/rules/${L()}`, { allowedDays: [1, 2, 3, 4, 5, 6, 7], dayMax: {}, requireApproval: true })).status).toBe(200);
    const r = await start(F.luciaC, { minutes: 20 });
    expect(r.body.session).toMatchObject({ status: 'pending', started_at: null });
    expect(await notes(F.ids.mama, 'screen_request')).toHaveLength(1);
    expect((await F.luciaC.post(`/api/screen/sessions/${r.body.session.id}/approve`)).status).toBe(403);
    expect((await F.hugoC.post(`/api/screen/sessions/${r.body.session.id}/cancel`)).status).toBe(403);
    const pend = (await F.mama.get('/api/screen/sessions/pending')).body;
    expect(pend.sessions).toHaveLength(1);
    const ok = await F.mama.post(`/api/screen/sessions/${r.body.session.id}/approve`);
    expect(ok.body.session).toMatchObject({ status: 'running', decided_by: F.ids.mama });
    expect((await notes(L(), 'screen_decided'))[0].title).toContain('ha aprobado');
    // Rechazar y cancelar.
    await F.luciaC.post(`/api/screen/sessions/${r.body.session.id}/stop`);
    const r2 = await start(F.luciaC, { minutes: 5 });
    expect((await F.mama.post(`/api/screen/sessions/${r2.body.session.id}/reject`, { note: 'Ahora no' })).body.session.status).toBe('rejected');
    const r3 = await start(F.luciaC, { minutes: 5 });
    expect((await F.luciaC.post(`/api/screen/sessions/${r3.body.session.id}/cancel`)).body.session.status).toBe('cancelled');
  });
});

describe('Días de uso y topes (I21)', () => {
  const rules = (allowedDays: number[], dayMax: Record<string, number> = {}, requireApproval = false) => F.mama.put(`/api/screen/rules/${L()}`, { allowedDays, dayMax, requireApproval });

  it('fuera de los días permitidos el botón no arranca y dice por qué; un adulto sí puede', async () => {
    await give(60);
    const dow = isoWeekday(today());
    expect((await rules([1, 2, 3, 4, 5, 6, 7].filter((d) => d !== dow))).status).toBe(200);
    const st = await state();
    expect(st).toMatchObject({ can_start: false, reason_code: 'day', today: { allowed: false } });
    expect(st.reason).toMatch(/Hoy no toca pantalla/);
    const r = await start();
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('day');
    expect(r.body.message).toMatch(/Tus días/);
    // El adulto decide: no aplica la regla de los días.
    expect((await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 10 })).status).toBe(200);
  });

  it('el tope por día limita cada sesión y, agotado, ya no deja empezar; el tiempo extra no cuenta', async () => {
    await give(120);
    const dow = isoWeekday(today());
    await rules([1, 2, 3, 4, 5, 6, 7], { [dow]: 30 });
    expect((await state()).max_minutes).toBe(30);
    const tooLong = await start(F.luciaC, { minutes: 45 });
    expect(tooLong.body.error).toBe('too_long');
    expect(tooLong.body.message).toMatch(/solo te quedan 30 min/);
    const s = (await start(F.luciaC, { minutes: 30 })).body.session;
    await age(s.id, 20);
    await F.luciaC.post(`/api/screen/sessions/${s.id}/stop`);
    const st = await state();
    expect(st.today).toMatchObject({ cap: 30, used: 20, cap_left: 10 });
    expect(st.max_minutes).toBe(10);
    const s2 = (await start(F.luciaC, { minutes: 10 })).body.session;
    await age(s2.id, 10);
    await F.luciaC.post(`/api/screen/sessions/${s2.id}/stop`);
    const done = await start(F.luciaC, { minutes: 5 });
    expect(done.body.error).toBe('cap');
    expect(done.body.message).toMatch(/ya has usado tus 30 min/);
    // Un adulto sí puede dar tiempo aparte.
    expect((await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 10 })).status).toBe(200);
  });

  it('distingue el uso total registrado del uso del plan sin contar dos veces el exceso', async () => {
    await give(90);
    const dow = isoWeekday(today());
    await rules([1, 2, 3, 4, 5, 6, 7], { [dow]: 20 });
    const timer = (await start(F.luciaC, { minutes: 10 })).body.session;
    await age(timer.id, 10);
    await F.luciaC.post(`/api/screen/sessions/${timer.id}/stop`);
    await F.luciaC.post(`/api/screen/sessions/${timer.id}/overrun`, { minutes: 2 });
    const charge = { userId: L(), mode: 'charge', category: 'tablet' };
    const recorded = await start(F.mama, { ...charge, minutes: 12, extra: false });
    expect(recorded.status).toBe(200);
    expect(recorded.body.session).toMatchObject({ used_minutes: 12, charged_minutes: 12, extra: false, category: 'tablet' });
    expect((await start(F.mama, { ...charge, minutes: 3 })).body.session.extra).toBe(true);
    expect((await start(F.mama, { ...charge, minutes: 4, extra: true })).body.session.extra).toBe(true);
    const log = (await F.luciaC.post('/api/screen-logs', { minutes: 5, category: 'tele' })).body.log;
    await F.mama.post(`/api/screen-logs/${log.id}/confirm`);
    await F.luciaC.post('/api/screen-logs', { minutes: 6, category: 'tele' });
    const voided = (await F.luciaC.post('/api/screen-logs', { minutes: 8, category: 'movil' })).body.log;
    await F.mama.post(`/api/screen-logs/${voided.id}/void`);
    expect((await F.mama.post('/api/screen/spend', { userId: L(), minutes: 9, category: 'videojuegos' })).status).toBe(200);
    const pendingExtra = await start(F.luciaC, { minutes: 7, extra: true });
    expect(pendingExtra.body.session.status).toBe('pending');
    const expected = { cap: 20, used: 22, cap_left: 0, total_used_minutes: 45, pending_legacy_minutes: 6 };
    expect((await state()).today).toMatchObject(expected);
    expect((await state(F.mama)).today).toMatchObject(expected);
    expect((await state(F.mama, F.ids.hugo)).today).toMatchObject({ used: 0, total_used_minutes: 0 });
    expect((await start(F.luciaC, { ...charge, minutes: 5, extra: false })).status).toBe(403);
    expect((await start(F.luciaC, { minutes: 5 })).body.error).toBe('cap');
  });

  it('cuenta el temporizador aprobado después de medianoche en el día en que empezó', async () => {
    await give(60);
    await rules([1, 2, 3, 4, 5, 6, 7], {}, true);
    const yesterday = addDays(today(), -1);
    const submitted = await startSession(kidUser(), { minutes: 20 }, { now: zonedToUtc(yesterday, '23:58', TZ) });
    expect(submitted.session).toMatchObject({ status: 'pending', day: yesterday });
    const approved = await approveSession(adultUser(), submitted.session.id, { now: at('00:02') });
    expect(approved.session).toMatchObject({ status: 'running', day: today() });
    await stopSession(kidUser(), submitted.session.id, { now: at('00:07') });
    expect((await screenState(kidUser(), L(), { now: at('00:08') })).today).toMatchObject({ used: 5, total_used_minutes: 5 });
  });

  it('volver a comprobar el tope al aprobar evita un temporizador fuera del plan', async () => {
    await give(90);
    const dow = isoWeekday(today());
    await rules([1, 2, 3, 4, 5, 6, 7], { [dow]: 20 }, true);
    const pending = (await start(F.luciaC, { minutes: 10 })).body.session;
    expect(pending.status).toBe('pending');
    expect((await start(F.mama, { userId: L(), mode: 'charge', minutes: 20, extra: false })).status).toBe(200);
    const denied = await F.mama.post(`/api/screen/sessions/${pending.id}/approve`);
    expect(denied).toMatchObject({ status: 409, body: { error: 'cap' } });
    expect((await state()).session).toMatchObject({ id: pending.id, status: 'pending' });
    const extra = (await start(F.luciaC, { minutes: 10, extra: true })).body.session;
    expect((await F.mama.post(`/api/screen/sessions/${extra.id}/approve`)).status).toBe(200);
  });

  it('valida los días y los topes, y un hijo no cambia sus reglas', async () => {
    expect((await rules([])).status).toBe(400);
    expect((await F.mama.put(`/api/screen/rules/${L()}`, { allowedDays: [8], dayMax: {}, requireApproval: false })).status).toBe(400);
    expect((await F.luciaC.put(`/api/screen/rules/${L()}`, { allowedDays: [1], dayMax: {}, requireApproval: false })).status).toBe(403);
    const ok = await rules([6, 7, 6], { '1': 30, '6': 120 });
    expect(ok.body).toEqual({ allowedDays: [6, 7], dayMax: { '6': 120 }, requireApproval: false }); // el tope de un día no permitido se descarta
    const plans = (await F.mama.get('/api/screen/plans')).body.plans.find((p: any) => p.user_id === L());
    expect(plans).toMatchObject({ allowed_days: [6, 7], require_approval: false });
  });
});

describe('Fin del tiempo y cierre automático (I21)', () => {
  it('cierra la sesión vencida sin que nadie tenga la app abierta, cobra lo previsto y avisa al hijo y a los padres', async () => {
    await give(60);
    const s = (await start(F.luciaC, { minutes: 30 })).body.session;
    await age(s.id, 31);
    expect(await screenBalance(pool(), L())).toBe(60);
    const r = await runScreenSessions(pool());
    expect(r.closed).toBe(1);
    const row = await one(pool(), 'SELECT * FROM screen_sessions WHERE id = $1', [s.id]);
    expect(row).toMatchObject({ status: 'finished', end_reason: 'expired', used_minutes: 30 });
    expect(await screenBalance(pool(), L())).toBe(30);
    expect((await notes(L(), 'screen_ended'))[0].title).toContain('Se acabó el tiempo de pantalla');
    expect((await notes(F.ids.mama, 'screen_ended'))[0].title).toContain('Lucía');
    expect((await notes(F.ids.papa, 'screen_ended'))).toHaveLength(1);
    // Repetirlo no duplica ni cobra otra vez.
    expect((await runScreenSessions(pool())).closed).toBe(0);
    expect(await screenBalance(pool(), L())).toBe(30);
    expect(await notes(L(), 'screen_ended')).toHaveLength(1);
  });

  it('también se cierra al leer el estado, y parar tarde cuenta como acabada', async () => {
    await give(60);
    const s = (await start(F.luciaC, { minutes: 10 })).body.session;
    await age(s.id, 11);
    const st = await state();
    expect(st.session).toBeNull();
    expect(st.last_session).toMatchObject({ id: s.id, status: 'finished', end_reason: 'expired' });
    const s2 = (await start(F.luciaC, { minutes: 10 })).body.session;
    await age(s2.id, 12);
    const late = await F.luciaC.post(`/api/screen/sessions/${s2.id}/stop`);
    expect(late.body.session).toMatchObject({ end_reason: 'expired', used_minutes: 10 });
  });

  it('avisa a los 5 minutos, una sola vez, y no en sesiones cortas', async () => {
    await give(120);
    const s = (await start(F.luciaC, { minutes: 30 })).body.session;
    await age(s.id, 24); // quedan 6
    expect((await runScreenSessions(pool())).warned).toBe(0);
    await age(s.id, 2); // quedan 4
    expect((await runScreenSessions(pool())).warned).toBe(1);
    await runScreenSessions(pool());
    expect(await notes(L(), 'screen_warning')).toHaveLength(1);
    await F.luciaC.post(`/api/screen/sessions/${s.id}/stop`);
    const short = (await start(F.luciaC, { minutes: 5 })).body.session;
    expect((await runScreenSessions(pool())).warned).toBe(0);
    await F.luciaC.post(`/api/screen/sessions/${short.id}/stop`);
  });

  it('el exceso (me pasé) va a deuda y se descuenta de la semana siguiente, no antes', async () => {
    await give(40);
    const s = (await start(F.luciaC, { minutes: 10 })).body.session;
    await age(s.id, 11);
    await closeDueSessions(pool());
    expect((await F.luciaC.post(`/api/screen/sessions/${s.id}/overrun`, { minutes: 0 })).status).toBe(400);
    const o = await F.luciaC.post(`/api/screen/sessions/${s.id}/overrun`, { minutes: 8 });
    expect(o.body.session.overrun_minutes).toBe(8);
    expect(await screenBalance(pool(), L())).toBe(30); // esta semana no se toca
    expect((await notes(F.ids.mama, 'screen_overrun'))[0].title).toContain('se pasó 8 min');
    expect(await runScreenDebts(pool(), F.ids.family)).toBe(0); // aún es la misma semana
    // El lunes siguiente se descuenta, una sola vez.
    const nextMonday = zonedToUtc(addDays(startOfWeek(today()), 7), '00:05', TZ);
    expect(await runScreenDebts(pool(), F.ids.family, nextMonday)).toBe(8);
    expect(await screenBalance(pool(), L())).toBe(22);
    expect(await runScreenDebts(pool(), F.ids.family, nextMonday)).toBe(0);
    expect((await notes(L(), 'screen_overrun'))[0].title).toContain('Se descuentan 8 min');
    // Un padre también puede anotarlo; otro hijo no; y hay tope.
    expect((await F.hugoC.post(`/api/screen/sessions/${s.id}/overrun`, { minutes: 5 })).status).toBe(403);
    expect((await F.mama.post(`/api/screen/sessions/${s.id}/overrun`, { minutes: 5 })).status).toBe(200);
    expect((await F.mama.post(`/api/screen/sessions/${s.id}/overrun`, { minutes: 240 })).body.error).toBe('too_many');
  });

  it('si al cerrar no llegan los minutos, la diferencia queda como deuda de la semana siguiente', async () => {
    await give(10);
    const s = (await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 25 })).body.session;
    await age(s.id, 26);
    await closeDueSessions(pool());
    expect(await one(pool(), 'SELECT used_minutes, charged_minutes, shortfall_minutes FROM screen_sessions WHERE id = $1', [s.id])).toEqual({ used_minutes: 25, charged_minutes: 10, shortfall_minutes: 15 });
    expect(await one(pool(), 'SELECT minutes, remaining FROM screen_debts WHERE user_id = $1', [L()])).toEqual({ minutes: 15, remaining: 15 });
    expect((await state()).debt_minutes).toBe(15);
  });

  it('avisa 3 días antes de que caduquen minutos ganados, una vez', async () => {
    await give(20);
    const lot = (await one(pool(), `SELECT expires_at FROM screen_lots WHERE user_id = $1`, [L()]))!;
    const now = new Date(lot.expires_at.getTime() - 2 * 86400000);
    expect(await warnExpiringLots(pool(), new Date(lot.expires_at.getTime() - 5 * 86400000))).toBe(0);
    expect(await warnExpiringLots(pool(), now)).toBe(1);
    await warnExpiringLots(pool(), now);
    const n = await notes(L(), 'screen_expiring');
    expect(n).toHaveLength(1);
    expect(n[0].title).toMatch(/caducan 20 min: úsalos/);
    expect((await state()).expiring).toBeNull(); // hoy aún faltan más de 3 días
  });
});

describe('Tiempo extra y «Dar pantalla» (I21)', () => {
  it('«Dar minutos» descuenta al instante de las baterías, sin temporizador, y si no llegan el adulto elige puntos, dinero o deuda', async () => {
    await give(10);
    await tx(async (db) => {
      await addPoints(db, { familyId: F.ids.family, userId: L(), delta: 50, kind: 'adjustment', note: 'test' });
      await addMoney(db, { familyId: F.ids.family, userId: L(), deltaCents: 200, kind: 'adjustment', note: 'test' });
    });
    // Sin tasa propia: 15 min = 10 puntos o 0,25.
    expect((await F.mama.get('/api/screen/rates')).body).toEqual({ pointsPer15: 10, centsPer15: 25 });
    const a = await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 25, mode: 'charge', note: 'TikTok', payWith: 'points' });
    expect(a.status).toBe(200);
    expect(a.body.session).toMatchObject({ kind: 'charge', status: 'finished', used_minutes: 25, charged_minutes: 10, shortfall_minutes: 15, paid_points: 10, paid_cents: 0, note: 'TikTok' });
    expect(await screenBalance(pool(), L())).toBe(0);
    expect(await pointsBalance(pool(), L())).toBe(40);
    expect((await one(pool(), `SELECT note FROM points_ledger WHERE kind = 'adjustment' AND delta = -10`))!.note).toContain('Pantalla extra: 15 min (TikTok)');
    expect((await notes(L(), 'screen_parent_started'))[0].title).toContain('te ha dado 25 min');
    // Con dinero: 15 min = 0,25, así que 10 min son 17 céntimos (se redondea hacia arriba).
    const b = await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 10, mode: 'charge', payWith: 'money' });
    expect(b.body.session).toMatchObject({ paid_cents: 17, paid_points: 0, shortfall_minutes: 10 });
    expect(await moneyBalance(pool(), L())).toBe(183);
    // Como deuda, sin tocar puntos ni dinero.
    const c = await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 20, mode: 'charge' });
    expect(c.body.session).toMatchObject({ paid_cents: 0, paid_points: 0, shortfall_minutes: 20 });
    expect(await one(pool(), `SELECT sum(remaining)::int AS n FROM screen_debts WHERE user_id = $1`, [L()])).toEqual({ n: 20 });
    // Si no alcanza el dinero o los puntos, no deja elegirlo.
    const d = await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 100, mode: 'charge', payWith: 'points' });
    expect(d.status).toBe(409);
    expect(d.body.error).toBe('insufficient_funds');
    // Un hijo no puede descontarse a sí mismo ni a un hermano.
    expect((await F.luciaC.post('/api/screen/sessions', { minutes: 5, mode: 'charge' })).status).toBe(403);
  });

  it('la tasa por minuto se configura en Ajustes de pantalla (solo adultos)', async () => {
    expect((await F.mama.put('/api/screen/rates', { pointsPer15: 20, centsPer15: 50 })).status).toBe(200);
    expect((await F.luciaC.get('/api/screen/rates')).body).toEqual({ pointsPer15: 20, centsPer15: 50 });
    expect((await F.luciaC.put('/api/screen/rates', { pointsPer15: 1, centsPer15: 1 })).status).toBe(403);
    expect((await F.mama.put('/api/screen/rates', { pointsPer15: 0, centsPer15: 1 })).status).toBe(400);
  });

  it('«Encender temporizador» con pago: al parar se cobra lo usado, y lo que falta con puntos', async () => {
    await give(5);
    await tx((db) => addPoints(db, { familyId: F.ids.family, userId: L(), delta: 40, kind: 'adjustment', note: 'test' }));
    const r = await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 20, note: 'TikTok', payWith: 'points' });
    expect(r.status).toBe(200);
    await age(r.body.session.id, 12);
    const stop = await F.mama.post(`/api/screen/sessions/${r.body.session.id}/stop`);
    expect(stop.body.session).toMatchObject({ used_minutes: 12, charged_minutes: 5, paid_points: 5 });
    expect(await pointsBalance(pool(), L())).toBe(35);
  });

  it('«Pedir tiempo extra»: el hijo paga con puntos o dinero lo que le falta y un adulto lo aprueba', async () => {
    await give(10);
    await tx((db) => addPoints(db, { familyId: F.ids.family, userId: L(), delta: 30, kind: 'adjustment', note: 'test' }));
    // Falta pagar: tiene que elegir.
    expect((await F.luciaC.post('/api/screen/sessions', { minutes: 20, extra: true })).body.error).toBe('choose_payment');
    expect((await F.luciaC.post('/api/screen/sessions', { minutes: 60, extra: true, payWith: 'points' })).body.error).toBe('insufficient_funds');
    const r = await F.luciaC.post('/api/screen/sessions', { minutes: 20, extra: true, payWith: 'points', note: 'Un rato más' });
    expect(r.body.session).toMatchObject({ kind: 'charge', status: 'pending', extra: true, shortfall_mode: 'points', started_at: null });
    // Solo una petición esperando.
    expect((await F.luciaC.post('/api/screen/sessions', { minutes: 5, extra: true, payWith: 'points' })).body.error).toBe('already_pending');
    expect((await state()).pending_extra.id).toBe(r.body.session.id);
    expect(await pointsBalance(pool(), L())).toBe(30); // nada se descuenta hasta que lo aprueben
    const req = (await notes(F.ids.mama, 'screen_request'))[0];
    expect(req.title).toContain('Lucía pide 20 min de tiempo extra');
    expect(req.link).toBe('/validar');
    // Aprobar descuenta al momento: no hay temporizador.
    const ok = await F.mama.post(`/api/screen/sessions/${r.body.session.id}/approve`);
    expect(ok.body.session).toMatchObject({ kind: 'charge', status: 'finished', used_minutes: 20, charged_minutes: 10, paid_points: 7, end_reason: 'charge' });
    expect((await state()).session).toBeNull();
    expect(await screenBalance(pool(), L())).toBe(0);
    expect(await pointsBalance(pool(), L())).toBe(23);
    expect((await notes(L(), 'screen_decided'))[0].title).toContain('te ha dado 20 min');
    // Queda en el extracto de puntos y en el historial de sesiones.
    expect((await one(pool(), `SELECT note FROM points_ledger WHERE delta = -7`))!.note).toContain('Pantalla extra');
    const hist = (await F.luciaC.get(`/api/screen/${L()}/sessions`)).body.sessions;
    expect(hist[0]).toMatchObject({ kind: 'charge', extra: true, paid_points: 7, started_by_name: 'Lucía', decided_by: F.ids.mama });
  });

  it('pedir tiempo extra no tiene que esperar a que acabe un temporizador, y se puede cancelar o rechazar', async () => {
    await give(60);
    const t = (await start(F.luciaC, { minutes: 20 })).body.session;
    const r = await F.luciaC.post('/api/screen/sessions', { minutes: 10, extra: true });
    expect(r.body.session.status).toBe('pending');
    expect((await F.hugoC.post(`/api/screen/sessions/${r.body.session.id}/cancel`)).status).toBe(403);
    expect((await F.luciaC.post(`/api/screen/sessions/${r.body.session.id}/cancel`)).body.session.status).toBe('cancelled');
    const r2 = await F.luciaC.post('/api/screen/sessions', { minutes: 10, extra: true });
    expect((await F.mama.post(`/api/screen/sessions/${r2.body.session.id}/reject`, { note: 'Hoy no' })).body.session.status).toBe('rejected');
    expect(await screenBalance(pool(), L())).toBe(60);
    expect((await state()).session.id).toBe(t.id); // el temporizador sigue en marcha
  });

  it('el tiempo extra no cuenta para los días ni el tope, pero un bloqueo sí lo frena', async () => {
    await give(30);
    const dow = isoWeekday(today());
    await F.mama.put(`/api/screen/rules/${L()}`, { allowedDays: [1, 2, 3, 4, 5, 6, 7].filter((d) => d !== dow), dayMax: {}, requireApproval: false });
    const r = await F.luciaC.post('/api/screen/sessions', { minutes: 10, extra: true });
    expect(r.body.session.status).toBe('pending');
    await F.mama.post(`/api/screen/sessions/${r.body.session.id}/reject`);
    await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'Gritos', endsOn: today() });
    expect((await F.luciaC.post('/api/screen/sessions', { minutes: 10, extra: true })).body.error).toBe('blocked');
    expect((await F.mama.post('/api/screen/sessions', { userId: L(), minutes: 10 })).body.error).toBe('blocked');
  });
});

describe('Castigos y retos (I21)', () => {
  it('bloquear días: no arranca, dice el motivo y cuándo termina, avisa al hijo y se puede levantar', async () => {
    await give(60);
    const end = addDays(today(), 2);
    const r = await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'Notas del cole', endsOn: end });
    expect(r.status).toBe(200);
    expect(r.body.label).toMatch(/^Sin pantalla hasta .* \(incluido\)$/);
    expect((await notes(L(), 'screen_block'))[0].body).toContain('Motivo: Notas del cole');
    const st = await state();
    expect(st).toMatchObject({ can_start: false, reason_code: 'blocked' });
    expect(st.reason).toContain('Notas del cole');
    expect(st.blocks[0]).toMatchObject({ kind: 'days', state: 'active', blocked_now: true });
    expect((await start()).body.error).toBe('blocked');
    // El otro hijo no está bloqueado.
    await give(30, F.ids.hugo);
    expect((await start(F.hugoC)).status).toBe(200);
    expect((await F.luciaC.post(`/api/screen/blocks/${r.body.id}/lift`)).status).toBe(403);
    expect((await F.mama.post(`/api/screen/blocks/${r.body.id}/lift`)).status).toBe(200);
    expect((await start()).status).toBe(200);
  });

  it('crear un bloqueo para ahora detiene la sesión en marcha y cobra lo usado', async () => {
    await give(60);
    const s = (await start(F.luciaC, { minutes: 30 })).body.session;
    await age(s.id, 7);
    await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'Castigo', endsOn: today() });
    expect(await one(pool(), 'SELECT status, end_reason, used_minutes FROM screen_sessions WHERE id = $1', [s.id])).toEqual({ status: 'finished', end_reason: 'blocked', used_minutes: 7 });
  });

  it('una franja horaria bloquea solo en esas horas y recorta la sesión que llegaría hasta ella', async () => {
    await give(120);
    await createBlock(adultUser(), { userId: L(), kind: 'window', reason: 'Hora de dormir', endsOn: today(), windowStart: '20:00', windowEnd: '22:00' }, { now: at('12:00') });
    const mk = (time: string) => startSession(kidUser(), { minutes: 30 }, { now: at(time) });
    await expect(mk('21:00')).rejects.toMatchObject({ status: 409, code: 'blocked' });
    await expect(mk('19:50')).rejects.toMatchObject({ code: 'too_long' }); // solo caben 10 min
    expect((await startSession(kidUser(), { minutes: 10 }, { now: at('19:50') })).session.planned_end_at.getTime()).toBe(at('20:00').getTime());
    await pool().query(`UPDATE screen_sessions SET status = 'cancelled'`);
    expect((await mk('22:00')).session.status).toBe('running'); // terminada la franja
    expect((await createBlock(adultUser(), { userId: L(), kind: 'window', reason: 'x', endsOn: today(), windowStart: '22:00', windowEnd: '21:00' }).catch((e) => e.status))).toBe(400);
  });

  it('el estado distingue un bloqueo ya terminado y un adulto no puede poner fechas pasadas', async () => {
    expect((await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'x', endsOn: addDays(today(), -1) })).status).toBe(400);
    expect((await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'x', endsOn: addDays(today(), 200) })).status).toBe(400);
    expect((await F.luciaC.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'x', endsOn: today() })).status).toBe(403);
  });

  it('reto: el hijo lo marca hecho y un adulto lo valida; el bloqueo se levanta', async () => {
    await give(60);
    const b = (await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'Habitación', endsOn: addDays(today(), 3), challenge: { text: 'Ordena tu cuarto', effect: 'lift' } })).body;
    expect((await state()).blocks[0].challenge).toMatchObject({ text: 'Ordena tu cuarto', status: 'open', effect: 'lift' });
    expect((await F.hugoC.post(`/api/screen/blocks/${b.id}/challenge/done`, { note: 'x' })).status).toBe(403); // no es su bloqueo
    const done = await F.luciaC.post(`/api/screen/blocks/${b.id}/challenge/done`, { note: 'Hecho' });
    expect(done.status).toBe(200);
    expect((await F.luciaC.post(`/api/screen/blocks/${b.id}/challenge/done`, {})).body.error).toBe('already_submitted');
    expect((await notes(F.ids.mama, 'screen_challenge'))[0].title).toContain('Lucía ha cumplido su reto');
    const pend = (await F.mama.get('/api/screen/sessions/pending')).body;
    expect(pend.challenges).toHaveLength(1);
    expect((await start()).body.error).toBe('blocked'); // sigue bloqueado hasta que lo validen
    expect((await F.luciaC.post(`/api/screen/blocks/${b.id}/challenge/review`, { approve: true })).status).toBe(403);
    const rev = await F.mama.post(`/api/screen/blocks/${b.id}/challenge/review`, { approve: true });
    expect(rev.body.result).toBe('lifted');
    expect((await notes(L(), 'screen_block')).pop()!.title).toContain('Reto cumplido');
    expect((await start()).status).toBe(200);
    expect(await one(pool(), 'SELECT status, challenge_status FROM screen_blocks WHERE id = $1', [b.id])).toEqual({ status: 'lifted', challenge_status: 'approved' });
  });

  it('reto que acorta: quita días; si hace falta repetirlo vuelve al hijo', async () => {
    const b = (await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'Pelea', endsOn: addDays(today(), 4), challenge: { text: 'Lee 20 min', effect: 'shorten', days: 2 } })).body;
    expect((await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'x', endsOn: today(), challenge: { text: 'x', effect: 'shorten' } })).status).toBe(400); // falta cuántos días
    await F.luciaC.post(`/api/screen/blocks/${b.id}/challenge/done`, {});
    const no = await F.mama.post(`/api/screen/blocks/${b.id}/challenge/review`, { approve: false, note: 'Faltó el libro' });
    expect(no.body.result).toBe('rejected');
    expect((await state()).blocks[0].challenge).toMatchObject({ status: 'rejected', note: 'Faltó el libro' });
    expect((await F.mama.post(`/api/screen/blocks/${b.id}/challenge/review`, { approve: true })).body.error).toBe('not_submitted');
    await F.luciaC.post(`/api/screen/blocks/${b.id}/challenge/done`, {});
    expect((await F.mama.post(`/api/screen/blocks/${b.id}/challenge/review`, { approve: true })).body.result).toBe('shortened');
    expect(await one(pool(), 'SELECT ends_on FROM screen_blocks WHERE id = $1', [b.id])).toEqual({ ends_on: addDays(today(), 2) });
    // Un reto que acorta más de lo que queda, levanta el bloqueo.
    const c = (await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'x', endsOn: addDays(today(), 1), challenge: { text: 'Barre', effect: 'shorten', days: 5 } })).body;
    await F.luciaC.post(`/api/screen/blocks/${c.id}/challenge/done`, {});
    expect((await F.mama.post(`/api/screen/blocks/${c.id}/challenge/review`, { approve: true })).body.result).toBe('lifted');
  });

  it('si el adulto pide foto, sin ella no se puede enviar; con ella la ve el adulto y no el hermano', async () => {
    const b = (await F.mama.post('/api/screen/blocks', { userId: L(), kind: 'days', reason: 'x', endsOn: addDays(today(), 1), challenge: { text: 'Recoge la mesa', effect: 'lift', photo: true } })).body;
    const no = await F.luciaC.post(`/api/screen/blocks/${b.id}/challenge/done`, { note: 'listo' });
    expect(no.status).toBe(400);
    expect(no.body.error).toBe('photo_required');
    expect((await F.luciaC.get(`/api/screen/blocks/${b.id}/photo`)).status).toBe(404);
    // Foto de verdad (PNG mínimo de 1 px, vía multipart).
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const boundary = '----t';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nlisto\r\n--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`),
      png, Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const res = await app.inject({ method: 'POST', url: `/api/screen/blocks/${b.id}/challenge/done`, payload: body, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'x-mesada': '1', cookie: F.luciaC.cookie } });
    expect(res.statusCode).toBe(200);
    expect((await F.luciaC.get(`/api/screen/blocks/${b.id}/photo`)).status).toBe(200);
    expect((await F.mama.get(`/api/screen/blocks/${b.id}/photo`)).status).toBe(200);
    expect((await F.hugoC.get(`/api/screen/blocks/${b.id}/photo`)).status).toBe(403);
    expect((await F.mama.get('/api/screen/sessions/pending')).body.challenges[0]).toMatchObject({ has_photo: true, challenge_photo: true });
  });
});

describe('Permisos (I21)', () => {
  it('un pariente no toca nada de esto, ni siquiera para leer; un hijo solo lo suyo', async () => {
    await pool().query(`UPDATE users SET relationship = 'grandparent' WHERE id = $1`, [F.ids.papa]);
    const c = F.papaC;
    const sid = '00000000-0000-4000-8000-000000000001';
    const calls: [string, string, unknown][] = [
      ['GET', `/api/screen/${L()}/state`, undefined], ['GET', `/api/screen/${L()}/sessions`, undefined], ['POST', '/api/screen/sessions', { userId: L(), minutes: 10 }],
      ['GET', '/api/screen/sessions/pending', undefined], ['POST', `/api/screen/sessions/${sid}/stop`, {}], ['POST', `/api/screen/sessions/${sid}/extend`, { minutes: 5 }],
      ['POST', `/api/screen/sessions/${sid}/approve`, {}], ['POST', `/api/screen/sessions/${sid}/reject`, {}], ['POST', `/api/screen/sessions/${sid}/overrun`, { minutes: 5 }],
      ['PUT', `/api/screen/rules/${L()}`, { allowedDays: [1], dayMax: {}, requireApproval: false }], ['GET', '/api/screen/rates', undefined], ['PUT', '/api/screen/rates', { pointsPer15: 10, centsPer15: 25 }],
      ['POST', '/api/screen/blocks', { userId: L(), kind: 'days', reason: 'x', endsOn: today() }], ['POST', `/api/screen/blocks/${sid}/lift`, {}],
      ['POST', `/api/screen/blocks/${sid}/challenge/review`, { approve: true }], ['GET', `/api/screen/blocks/${sid}/photo`, undefined],
    ];
    for (const [m, u, b] of calls) expect((await c.req(m, u, b)).status, `${m} ${u}`).toBe(403);
  });

  it('un hijo no ve la pantalla de su hermano ni usa rutas de adultos', async () => {
    expect((await F.hugoC.get(`/api/screen/${L()}/state`)).status).toBe(403);
    expect((await F.hugoC.get(`/api/screen/${L()}/sessions`)).status).toBe(403);
    expect((await F.hugoC.post('/api/screen/sessions', { userId: L(), minutes: 5 })).body.error).toBe('no_balance'); // userId se ignora: solo habla de su propio saldo
    expect((await F.hugoC.get('/api/screen/sessions/pending')).status).toBe(403);
    expect((await F.hugoC.post(`/api/screen/sessions/00000000-0000-4000-8000-000000000001/extend`, { minutes: 5 })).status).toBe(403);
  });

  it('otra familia no ve ni toca las sesiones', async () => {
    await setSetting('registration_open', true);
    const G = await createFamily(app, 'g');
    await give(30);
    const s = (await start(F.luciaC, { minutes: 10 })).body.session;
    expect((await G.mama.get(`/api/screen/${L()}/state`)).status).toBe(404);
    expect((await G.mama.post(`/api/screen/sessions/${s.id}/stop`)).status).toBe(404);
    expect((await G.mama.post('/api/screen/sessions', { userId: L(), minutes: 5 })).status).toBe(404);
  });

  it('la sesión tiene clave de idempotencia: reintentar no abre otra', async () => {
    await give(30);
    const a = await F.luciaC.post('/api/screen/sessions', { minutes: 10 }, { 'idempotency-key': 'abcdefgh-1' });
    const b = await F.luciaC.post('/api/screen/sessions', { minutes: 10 }, { 'idempotency-key': 'abcdefgh-1' });
    expect(b.body.duplicate).toBe(true);
    expect(b.body.session.id).toBe(a.body.session.id);
  });
});
