import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { closePool, getPool, one } from '../src/lib/db.js';
import { addDays, todayIn } from '../src/lib/dates.js';
import { ensureInstances } from '../src/lib/instances.js';
import { computeStreak } from '../src/lib/gamification.js';
import { setSetting } from '../src/lib/settings.js';
import { resetLoginFailures } from '../src/routes/auth.js';
import { createFamily, resetDb } from './helpers.js';

let app: FastifyInstance;
let F: Awaited<ReturnType<typeof createFamily>>;
const today = () => todayIn('Europe/Madrid');
const pool = () => getPool();

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

const bal = async (u: string) => (await one(pool(), 'SELECT COALESCE(SUM(delta),0)::int AS b FROM points_ledger WHERE user_id=$1', [u]))!.b as number;

describe('Cuando haga falta (I10)', () => {
  async function mk(over: Record<string, unknown> = {}) {
    const r = await F.mama.post('/api/tasks', { title: 'Sacar la basura', points: 10, recurrence: 'as_needed', startDate: today(), assignees: [F.ids.lucia, F.ids.hugo], ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.task;
  }
  const todays = async (c: any) => (await c.get(`/api/instances?from=${today()}&to=${today()}`)).body.instances as any[];

  it('crea una sola ocurrencia compartida hoy; la tarea queda compartida y sin hora límite', async () => {
    const t = await mk({ assignmentMode: 'individual', dueTime: '09:00', latePercent: 50 });
    expect(t.assignment_mode).toBe('shared');
    expect(t.due_time).toBeNull();
    const l = await todays(F.luciaC);
    const h = await todays(F.hugoC);
    expect(l).toHaveLength(1);
    expect(h).toHaveLength(1);
    expect(l[0].id).toBe(h[0].id);
    expect(l[0].assignee_id).toBeNull();
    const n = (await pool().query('SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1', [t.id])).rows[0].n;
    expect(n).toBe(1); // no se materializan días futuros ni pasados
  });

  it('una vez al día: gana el primer hijo y los demás la ven hecha por él', async () => {
    const t = await mk();
    const inst = (await todays(F.luciaC))[0];
    expect((await F.luciaC.post(`/api/instances/${inst.id}/complete`)).status).toBe(200);
    const again = await F.hugoC.post(`/api/instances/${inst.id}/complete`);
    expect(again.status).toBe(409);
    const seen = (await todays(F.hugoC))[0];
    expect(seen.status).toBe('submitted');
    expect(seen.completed_by_name).toBe('Lucía');
    await F.mama.post(`/api/instances/${inst.id}/review`, { approve: true });
    expect(await bal(F.ids.lucia)).toBe(10);
    expect(await bal(F.ids.hugo)).toBe(0);
    // Aunque se apruebe, hoy no sale otra ocurrencia.
    await ensureInstances(pool(), F.ids.family);
    expect((await pool().query('SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1', [t.id])).rows[0].n).toBe(1);
    // Mañana vuelve a estar disponible.
    await pool().query('UPDATE task_instances SET due_date = $2 WHERE id = $1', [inst.id, addDays(today(), -1)]);
    await ensureInstances(pool(), F.ids.family);
    const fresh = await todays(F.hugoC);
    expect(fresh).toHaveLength(1);
    expect(fresh[0].status).toBe('pending');
  });

  it('si nadie la hace no vence ni cuenta como fallo, ni en el % ni en la racha', async () => {
    const t = await mk();
    const inst = (await todays(F.luciaC))[0];
    // Ayer sin hacer: se retira en silencio, no se marca como vencida.
    await pool().query('UPDATE task_instances SET due_date = $2 WHERE id = $1', [inst.id, addDays(today(), -1)]);
    await ensureInstances(pool(), F.ids.family);
    expect((await pool().query(`SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1 AND status = 'expired'`, [t.id])).rows[0].n).toBe(0);
    expect((await pool().query('SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1 AND due_date < $2', [t.id, today()])).rows[0].n).toBe(0);
    const p = (await F.luciaC.get(`/api/progress/${F.ids.lucia}`)).body;
    expect(p.period.missedPoints).toBe(0);
    expect(p.period.maxPoints).toBe(0); // ni siquiera la de hoy suma al total posible

    // Racha: hechas ayer, anteayer y hace 4 días; hace 3 días solo había una «cuando haga falta» sin hacer.
    const d = (await F.mama.post('/api/tasks', { title: 'Cama', points: 5, recurrence: 'daily', startDate: addDays(today(), -10), assignees: [F.ids.lucia] })).body.task;
    for (const [k, st] of [[1, 'approved'], [2, 'approved'], [3, 'expired'], [4, 'approved']] as const) {
      await pool().query(`INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points, status, completed_by) VALUES ($1,$2,$3,$4,5,$5,$3)`, [d.id, F.ids.family, F.ids.lucia, addDays(today(), -k), st]);
    }
    // Con el día -3 realmente fallado la racha es 2; lo comprobamos para tener la referencia.
    expect(await computeStreak(pool(), F.ids.lucia, today())).toBe(2);
    // Sin tarea diaria ese día, solo la opcional: el día es neutro y la racha llega a 3.
    await pool().query(`DELETE FROM task_instances WHERE task_id=$1 AND due_date=$2`, [d.id, addDays(today(), -3)]);
    await pool().query(`INSERT INTO task_instances(task_id, family_id, assignee_id, due_date, points) VALUES ($1,$2,NULL,$3,10)`, [t.id, F.ids.family, addDays(today(), -3)]);
    expect(await computeStreak(pool(), F.ids.lucia, today())).toBe(3);
  });
});

describe('Trabajos extra (I11)', () => {
  async function mkExtra(over: Record<string, unknown> = {}) {
    const r = await F.mama.post('/api/extras', { title: 'Quitar hierbajos', points: 30, bonus: { kind: 'points', points: 5 }, ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  }
  const board = async (c: any) => (await c.get('/api/extras')).body.board as any[];

  it('solo los adultos gestionan el catálogo; los hijos solo ven el tablón', async () => {
    await mkExtra();
    expect((await F.luciaC.post('/api/extras', { title: 'x', points: 1 })).status).toBe(403);
    const c = (await F.luciaC.get('/api/extras')).body;
    expect(c.catalog).toBeUndefined();
    expect(c.board).toEqual([]);
    const cat = (await F.mama.get('/api/extras')).body.catalog;
    expect(cat).toHaveLength(1);
    expect(cat[0].bonus.label).toBe('+5 puntos extra');
    // No aparece entre las tareas normales ni en la lista del día.
    expect((await F.mama.get('/api/tasks')).body.tasks).toHaveLength(0);
  });

  it('activar, reservar (gana el primero), completar, validar y volver al catálogo', async () => {
    const id = await mkExtra();
    const dl = addDays(today(), 3);
    const act = await F.mama.post(`/api/extras/${id}/activate`, { deadline: dl });
    expect(act.status).toBe(200);
    expect((await F.mama.post(`/api/extras/${id}/activate`, {})).status).toBe(409); // ya está en el tablón
    expect((await F.luciaC.post(`/api/extras/${id}/activate`, {})).status).toBe(403);
    const b = await board(F.hugoC);
    expect(b).toHaveLength(1);
    expect(b[0].extra_deadline).toBe(dl);
    const iid = act.body.id;
    // No se puede completar sin reservar.
    expect((await F.luciaC.post(`/api/instances/${iid}/complete`)).status).toBe(403);
    expect((await F.mama.post(`/api/extra-instances/${iid}/claim`)).status).toBe(403);
    expect((await F.luciaC.post(`/api/extra-instances/${iid}/claim`)).status).toBe(200);
    const late = await F.hugoC.post(`/api/extra-instances/${iid}/claim`);
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('taken');
    expect(late.body.message).toContain('Lucía');
    expect((await board(F.hugoC))[0].holder_name).toBe('Lucía');
    expect((await F.hugoC.post(`/api/instances/${iid}/complete`)).status).toBe(403);
    // Lucía la hace y pasa por Validar.
    expect((await F.luciaC.post(`/api/instances/${iid}/complete`)).status).toBe(200);
    expect((await F.mama.get('/api/dashboard')).body.pendingApprovals.some((a: any) => a.id === iid)).toBe(true);
    expect((await F.mama.post(`/api/instances/${iid}/review`, { approve: true })).body.status).toBe('approved');
    expect(await bal(F.ids.lucia)).toBe(35); // 30 + bono de 5
    expect(await bal(F.ids.hugo)).toBe(0);
    // Sale del tablón y vuelve al catálogo, listo para activarse otra vez.
    expect(await board(F.mama)).toHaveLength(0);
    const cat = (await F.mama.get('/api/extras')).body.catalog;
    expect(cat[0].open_instance_id).toBeNull();
    expect((await F.mama.post(`/api/extras/${id}/activate`, {})).status).toBe(200);
    // El segundo canje del mismo día con el mismo hijo tampoco choca.
    const again = (await board(F.luciaC))[0];
    expect((await F.luciaC.post(`/api/extra-instances/${again.id}/claim`)).status).toBe(200);
  });

  it('el adulto puede liberarla y otro hijo se la pide', async () => {
    const id = await mkExtra();
    const iid = (await F.mama.post(`/api/extras/${id}/activate`, {})).body.id;
    await F.luciaC.post(`/api/extra-instances/${iid}/claim`);
    expect((await F.luciaC.post(`/api/extra-instances/${iid}/release`)).status).toBe(403);
    expect((await F.mama.post(`/api/extra-instances/${iid}/release`)).status).toBe(200);
    expect((await F.hugoC.post(`/api/extra-instances/${iid}/claim`)).status).toBe(200);
    expect((await board(F.luciaC))[0].holder_name).toBe('Hugo');
  });

  it('plazo vencido sin hacer: sale del tablón en silencio y no cuenta como fallo', async () => {
    const id = await mkExtra();
    const iid = (await F.mama.post(`/api/extras/${id}/activate`, { deadline: today() })).body.id;
    expect((await F.mama.post(`/api/extras/${id}/activate`, { deadline: addDays(today(), -1) })).status).toBe(400);
    await F.luciaC.post(`/api/extra-instances/${iid}/claim`);
    await pool().query('UPDATE task_instances SET extra_deadline = $2 WHERE id = $1', [iid, addDays(today(), -1)]);
    expect((await F.luciaC.post(`/api/instances/${iid}/complete`)).body.error).toBe('expired');
    expect(await board(F.luciaC)).toHaveLength(0);
    const n = (await pool().query('SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1', [id])).rows[0].n;
    expect(n).toBe(0);
    const p = (await F.luciaC.get(`/api/progress/${F.ids.lucia}`)).body;
    expect(p.period.missedPoints).toBe(0);
    expect((await F.mama.get('/api/extras')).body.catalog).toHaveLength(1);
  });

  it('otra familia no ve ni toca los extras', async () => {
    const id = await mkExtra();
    await setSetting('registration_open', true);
    const G = await createFamily(app, 'g');
    expect((await G.mama.post(`/api/extras/${id}/activate`, {})).status).toBe(404);
    expect((await G.mama.put(`/api/extras/${id}`, { title: 'x', points: 1 })).status).toBe(404);
    expect((await G.mama.get('/api/extras')).body.catalog).toEqual([]);
  });
});

describe('Repetir en el día (I13)', () => {
  const todays = async (c: any) => (await c.get(`/api/instances?from=${today()}&to=${today()}`)).body.instances as any[];
  const open = async (c: any, taskId: string) => (await todays(c)).filter((i) => i.task_id === taskId && ['pending', 'rejected'].includes(i.status));
  async function mk(over: Record<string, unknown> = {}) {
    const r = await F.mama.post('/api/tasks', { title: 'Pasear al perro', points: 10, recurrence: 'daily', startDate: today(), assignees: [F.ids.lucia], requiresApproval: false, ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.task;
  }

  it('por defecto solo una vez al día', async () => {
    const t = await mk();
    expect(t.repeatable).toBe(false);
    const [i] = await open(F.luciaC, t.id);
    expect((await F.luciaC.post(`/api/instances/${i.id}/complete`)).status).toBe(200);
    expect(await open(F.luciaC, t.id)).toHaveLength(0);
    expect(await bal(F.ids.lucia)).toBe(10);
  });

  it('con tope por hijo: cada vez da los puntos completos y para en el máximo', async () => {
    const t = await mk({ repeatable: true, maxPerDay: 2, assignees: [F.ids.lucia, F.ids.hugo] });
    expect(t.max_per_day).toBe(2);
    for (let k = 0; k < 2; k++) {
      const [i] = await open(F.luciaC, t.id);
      expect(i, `repetición ${k + 1}`).toBeTruthy();
      expect((await F.luciaC.post(`/api/instances/${i.id}/complete`)).status).toBe(200);
    }
    expect(await bal(F.ids.lucia)).toBe(20);
    expect(await open(F.luciaC, t.id)).toHaveLength(0);
    const l = (await todays(F.luciaC)).filter((i) => i.task_id === t.id);
    expect(l.every((i) => i.done_count === 2 && i.max_per_day === 2)).toBe(true);
    // El tope es por hijo: Hugo aún tiene las suyas.
    expect(await open(F.hugoC, t.id)).toHaveLength(1);
  });

  it('compartida: el máximo se reparte entre todos (3: Lucía 2 y Hugo 1)', async () => {
    const t = await mk({ repeatable: true, maxPerDay: 3, assignmentMode: 'shared', assignees: [F.ids.lucia, F.ids.hugo] });
    const go = async (c: any) => {
      const [i] = await open(c, t.id);
      return i ? c.post(`/api/instances/${i.id}/complete`) : { status: 404 };
    };
    expect((await go(F.luciaC)).status).toBe(200);
    expect((await go(F.hugoC)).status).toBe(200);
    expect((await go(F.luciaC)).status).toBe(200);
    expect(await open(F.hugoC, t.id)).toHaveLength(0);
    expect(await open(F.luciaC, t.id)).toHaveLength(0);
    expect(await bal(F.ids.lucia)).toBe(20);
    expect(await bal(F.ids.hugo)).toBe(10);
    const rows = (await pool().query(`SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1 AND due_date = $2`, [t.id, today()])).rows[0].n;
    expect(rows).toBe(3);
  });

  it('sin límite: siempre queda otra disponible', async () => {
    const t = await mk({ repeatable: true, maxPerDay: null });
    for (let k = 0; k < 4; k++) {
      const [i] = await open(F.luciaC, t.id);
      expect((await F.luciaC.post(`/api/instances/${i.id}/complete`)).status).toBe(200);
    }
    expect(await open(F.luciaC, t.id)).toHaveLength(1);
    expect(await bal(F.ids.lucia)).toBe(40);
  });

  it('«cuando haga falta» también admite repeticiones', async () => {
    const t = await mk({ recurrence: 'as_needed', repeatable: true, maxPerDay: 2, assignees: [F.ids.lucia, F.ids.hugo] });
    const [a] = await open(F.luciaC, t.id);
    await F.luciaC.post(`/api/instances/${a.id}/complete`);
    const [b] = await open(F.hugoC, t.id);
    expect(b.repeat_no).toBe(2);
    expect((await F.hugoC.post(`/api/instances/${b.id}/complete`)).status).toBe(200);
    expect(await open(F.hugoC, t.id)).toHaveLength(0);
  });

  it('el día cuenta una sola vez para el % y la racha; las repeticiones sin hacer no son fallo', async () => {
    const t = await mk({ repeatable: true, maxPerDay: 3 });
    const [i] = await open(F.luciaC, t.id);
    await F.luciaC.post(`/api/instances/${i.id}/complete`);
    const p = (await F.luciaC.get(`/api/progress/${F.ids.lucia}`)).body;
    expect(p.period.maxPoints).toBe(10); // no se infla con las repeticiones
    expect(p.streak).toBe(1);
    // Ayer: una hecha y la siguiente pendiente sin hacer; no vence ni cuenta como fallo.
    await pool().query(`DELETE FROM task_instances WHERE task_id = $1 AND due_date <> $2`, [t.id, today()]);
    await pool().query(`UPDATE task_instances SET due_date = due_date - 1 WHERE task_id = $1`, [t.id]);
    await ensureInstances(pool(), F.ids.family);
    expect((await pool().query(`SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1 AND status = 'expired'`, [t.id])).rows[0].n).toBe(0);
    const p2 = (await F.luciaC.get(`/api/progress/${F.ids.lucia}`)).body;
    expect(p2.period.missedPoints).toBe(0);
    expect(p2.streak).toBe(1);
  });

  it('el tope también rige si se rechaza y se rehace; y una repetición no se puede forzar', async () => {
    const t = await mk({ repeatable: true, maxPerDay: 2, requiresApproval: true });
    const [i] = await open(F.luciaC, t.id);
    await F.luciaC.post(`/api/instances/${i.id}/complete`);
    const [j] = await open(F.luciaC, t.id);
    await F.luciaC.post(`/api/instances/${j.id}/complete`);
    expect(await open(F.luciaC, t.id)).toHaveLength(0);
    expect((await F.luciaC.post(`/api/instances/${j.id}/complete`)).status).toBe(409);
  });
});

describe('Espera tras hacerla (I14)', () => {
  const todays = async (c: any) => (await c.get(`/api/instances?from=${today()}&to=${today()}`)).body.instances as any[];
  async function mk(over: Record<string, unknown> = {}) {
    const r = await F.mama.post('/api/tasks', { title: 'Sacar la basura', points: 10, recurrence: 'as_needed', startDate: today(), assignees: [F.ids.lucia, F.ids.hugo], cooldownDays: 2, ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.task;
  }
  /** Mueve lo hecho `days` días al pasado, como si hubiera ocurrido entonces. */
  async function ago(taskId: string, days: number) {
    await pool().query(`UPDATE task_instances SET due_date = due_date - $2::int, completed_at = completed_at - ($2::int * interval '1 day') WHERE task_id = $1`, [taskId, days]);
    await ensureInstances(pool(), F.ids.family);
  }

  it('solo aplica a «Cuando haga falta»', async () => {
    expect((await mk()).cooldown_days).toBe(2);
    const d = await mk({ recurrence: 'daily', title: 'Cama' });
    expect(d.cooldown_days).toBeNull();
  });

  it('tras hacerla queda en espera N días: sale en gris con la fecha y no se puede marcar', async () => {
    const t = await mk();
    const [i] = await todays(F.luciaC);
    expect(i.blocked_until).toBeNull();
    expect((await F.luciaC.post(`/api/instances/${i.id}/complete`)).status).toBe(200);
    await ago(t.id, 1);
    const [n] = await todays(F.hugoC);
    expect(n.status).toBe('pending');
    expect(n.blocked_until).toBe(addDays(today(), 1)); // hecha ayer + 2 días = mañana
    const r = await F.hugoC.post(`/api/instances/${n.id}/complete`);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cooldown');
    // Pasado el plazo vuelve a estar disponible.
    await pool().query(`UPDATE task_instances SET due_date = due_date - 1, completed_at = completed_at - interval '1 day' WHERE task_id = $1 AND status = 'submitted'`, [t.id]);
    const [m] = await todays(F.hugoC);
    expect(m.blocked_until).toBeNull();
    expect((await F.hugoC.post(`/api/instances/${m.id}/complete`)).status).toBe(200);
  });

  it('cuenta al pulsar «Hecha» y, si la rechazan, se levanta la espera', async () => {
    const t = await mk({ cooldownDays: 3 });
    const [i] = await todays(F.luciaC);
    await F.luciaC.post(`/api/instances/${i.id}/complete`); // aún sin validar
    await ago(t.id, 1);
    expect((await todays(F.hugoC))[0].blocked_until).toBe(addDays(today(), 2));
    expect((await F.mama.post(`/api/instances/${i.id}/review`, { approve: false, note: 'repasa' })).body.status).toBe('rejected');
    expect((await todays(F.hugoC))[0].blocked_until).toBeNull();
  });

  it('si nadie la hace al volver, no pasa nada; y la espera manda sobre las repeticiones del día', async () => {
    const t = await mk({ cooldownDays: 1, repeatable: true, maxPerDay: 3 });
    const [i] = await todays(F.luciaC);
    await F.luciaC.post(`/api/instances/${i.id}/complete`);
    expect(await todays(F.luciaC)).toHaveLength(1); // sin segunda vuelta hoy
    await ago(t.id, 2);
    await ensureInstances(pool(), F.ids.family);
    expect((await pool().query(`SELECT count(*)::int AS n FROM task_instances WHERE task_id = $1 AND status = 'expired'`, [t.id])).rows[0].n).toBe(0);
    expect((await F.luciaC.get(`/api/progress/${F.ids.lucia}`)).body.period.missedPoints).toBe(0);
  });
});
