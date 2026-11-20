/**
 * Datos de demostración: npm run seed  (solo si la base de datos está vacía, o con --force para reiniciarla).
 * Usuarios: ana / demo-mesada (adulta), carlos / demo-mesada (adulto), lucia / 1414, hugo / 1111
 */
import { closePool, getPool, migrate, one } from './lib/db.js';
import { hashPassword, type AuthUser } from './lib/auth.js';
import { addDays, todayIn } from './lib/dates.js';
import { ensureInstances } from './lib/instances.js';
import { completeInstance, reviewInstance } from './lib/task-actions.js';
import { requestRedemption, settlePeriod } from './lib/money.js';
import { previousPeriod } from './lib/dates.js';

const pool = getPool();
const force = process.argv.includes('--force');
if (force) await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
await migrate();
const existing = (await one(pool, 'SELECT count(*)::int AS n FROM families')).n;
if (existing > 0) {
  console.log('La base de datos ya tiene datos. Usa --force para reiniciarla (¡borra todo!).');
  await closePool();
  process.exit(0);
}

const today = todayIn('Europe/Madrid');
const fam = await one(pool, `INSERT INTO families(name, rate_points, rate_cents, cap_cents) VALUES ('Familia García', 100, 500, 1500) RETURNING id`);
const mk = async (role: string, name: string, username: string, pw: string, avatar: string, color: string, birth: number | null, goal = 0) =>
  (await one(
    pool,
    `INSERT INTO users(family_id, role, display_name, username, password_hash, avatar, color, birth_year, weekly_goal_points)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [fam.id, role, name, username, await hashPassword(pw), avatar, color, birth, goal],
  )).id as string;

const ana = await mk('adult', 'Ana', 'ana', 'demo-mesada', 'owl', 'indigo', null);
const carlos = await mk('adult', 'Carlos', 'carlos', 'demo-mesada', 'bear', 'sky', null);
const lucia = await mk('child', 'Lucía', 'lucia', '1414', 'fox', 'tangerine', 2012, 180);
const hugo = await mk('child', 'Hugo', 'hugo', '1111', 'cat', 'leaf', 2015, 140);

const start = addDays(today, -20);
type T = [string, string, string, number, string, number[], string, string[], boolean, boolean, number | null];
const tasks: T[] = [
  ['Hacer la cama', '🛏️', 'easy', 5, 'daily', [], 'individual', [lucia, hugo], false, false, null],
  ['Poner y quitar la mesa', '🍽️', 'easy', 10, 'daily', [], 'rotation', [lucia, hugo], true, false, null],
  ['Sacar la basura', '🗑️', 'medium', 15, 'weekly', [1, 3, 5], 'rotation', [hugo, lucia], true, false, null],
  ['Ordenar la habitación', '🧹', 'medium', 20, 'weekly', [6], 'individual', [lucia, hugo], true, true, null],
  ['Dar de comer al gato', '🐈', 'easy', 5, 'daily', [], 'shared', [lucia, hugo], false, false, null],
  ['Limpiar el baño', '🛁', 'hard', 40, 'weekly', [7], 'rotation', [lucia, hugo], true, true, null],
  ['Ayudar con la compra', '🛒', 'medium', 25, 'weekly', [6], 'shared', [lucia, hugo], true, false, null],
  ['Regar las plantas', '🪴', 'easy', 10, 'monthly', [], 'individual', [hugo], true, false, 1],
];
for (const [title, icon, diff, pts, rec, wd, mode, who, appr, photo, md] of tasks) {
  const t = await one(
    pool,
    `INSERT INTO tasks(family_id, title, icon, difficulty, points, recurrence, weekdays, month_day, start_date, assignment_mode, requires_approval, requires_photo, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [fam.id, title, icon, diff, pts, rec, wd, md, start, mode, appr, photo, ana],
  );
  for (const [i, u] of who.entries()) await pool.query('INSERT INTO task_assignees VALUES ($1,$2,$3)', [t.id, u, i]);
}
await one(pool, `INSERT INTO tasks(family_id, title, icon, difficulty, points, recurrence, start_date, assignment_mode, requires_approval, created_by, description)
  VALUES ($1,'Preparar la mochila del viaje','🎒','medium',30,'once',$2,'individual',true,$3,'Para el sábado: ropa para 3 días y el cargador.') RETURNING id`, [fam.id, addDays(today, 2), ana])
  .then((t) => pool.query('INSERT INTO task_assignees VALUES ($1,$2,0)', [t.id, lucia]));

for (const [title, icon, cost, desc] of [
  ['Elegir la peli del viernes', '🎬', 60, ''],
  ['Una hora extra de consola', '🎮', 80, 'Fin de semana'],
  ['Acostarse 30 min más tarde', '🌙', 50, 'Viernes o sábado'],
  ['Cena a elegir', '🍕', 150, ''],
  ['Excursión al parque de aventuras', '🧗', 600, 'Plan familiar'],
] as const) {
  await pool.query('INSERT INTO rewards(family_id, title, icon, cost_points, description) VALUES ($1,$2,$3,$4,$5)', [fam.id, title, icon, cost, desc]);
}

// Historial simulado: materializa desde el inicio y completa ~80 % de lo pasado.
await ensureInstances(pool, fam.id, { from: start, to: addDays(today, 14) });
await pool.query(`UPDATE task_instances SET status = 'pending' WHERE family_id = $1 AND status = 'expired'`, [fam.id]);
const adultA: AuthUser = { id: ana, familyId: fam.id, role: 'adult', displayName: 'Ana', username: 'ana' };
const users: Record<string, AuthUser> = {
  [lucia]: { id: lucia, familyId: fam.id, role: 'child', displayName: 'Lucía', username: 'lucia' },
  [hugo]: { id: hugo, familyId: fam.id, role: 'child', displayName: 'Hugo', username: 'hugo' },
};
const past = (
  await pool.query(
    `SELECT i.id, i.assignee_id, i.due_date, t.requires_photo
       FROM task_instances i JOIN tasks t ON t.id = i.task_id
      WHERE i.family_id = $1 AND i.due_date <= $2 ORDER BY i.due_date`,
    [fam.id, today],
  )
).rows;
let n = 0;
for (const r of past) {
  n++;
  const isToday = r.due_date === today;
  const skip = isToday ? n % 2 === 0 : n % 5 === 0;
  if (skip) continue;
  const who = users[r.assignee_id ?? (n % 2 ? lucia : hugo)];
  try {
    if (r.requires_photo) await pool.query(`UPDATE tasks SET requires_photo = false WHERE id = (SELECT task_id FROM task_instances WHERE id = $1)`, [r.id]);
    const res = await completeInstance(who, r.id, { note: undefined });
    if (res.status === 'submitted' && !(isToday && n % 3 === 0)) await reviewInstance(adultA, r.id, { approve: true });
  } catch {
    /* p. ej. ya hecha por un hermano */
  }
  // Simular que se marcó en su día (para rachas y estadísticas).
  const ts = `${r.due_date} 19:00:00 Europe/Madrid`;
  await pool.query(`UPDATE task_instances SET completed_at = $2::timestamptz, reviewed_at = $2::timestamptz + interval '1 hour' WHERE id = $1 AND completed_at IS NOT NULL`, [r.id, ts]);
  await pool.query(`UPDATE points_ledger SET created_at = $2::timestamptz + interval '1 hour' WHERE ref_id = $1`, [r.id, ts]);
}
await pool.query(`UPDATE tasks SET requires_photo = true WHERE family_id = $1 AND title IN ('Ordenar la habitación','Limpiar el baño')`, [fam.id]);
await ensureInstances(pool, fam.id);

// Cierre de la semana pasada, un pago y una petición de recompensa.
const prev = previousPeriod('week', today);
for (const c of [lucia, hugo]) {
  await settlePeriod(adultA, c, prev.start);
  await pool.query(`UPDATE settlements SET created_at = $2::timestamptz WHERE user_id = $1`, [c, `${addDays(prev.end, 1)} 10:00 Europe/Madrid`]);
}
const lw = (await one(pool, `SELECT COALESCE(SUM(delta_cents),0)::int AS c FROM money_ledger WHERE user_id = $1`, [lucia])).c;
if (lw > 300) {
  const pay = await one(pool, `INSERT INTO payments(family_id, user_id, amount_cents, method, note, paid_by) VALUES ($1,$2,500,'bizum','Paga del lunes',$3) RETURNING id`, [fam.id, lucia, carlos]);
  await pool.query(`INSERT INTO money_ledger(family_id, user_id, delta_cents, kind, ref_id, note, created_by) VALUES ($1,$2,-500,'payment',$3,'Paga del lunes',$4)`, [fam.id, lucia, pay.id, carlos]);
}
const reward = await one(pool, `SELECT id FROM rewards WHERE family_id = $1 ORDER BY cost_points LIMIT 1`, [fam.id]);
try {
  await requestRedemption(users[hugo], reward.id);
} catch {
  /* sin puntos suficientes */
}
await pool.query(`INSERT INTO savings_goals(family_id, user_id, title, target_cents) VALUES ($1,$2,'Auriculares inalámbricos',4000)`, [fam.id, lucia]);

console.log('Datos de demostración creados.');
console.log('  Adultos: ana / demo-mesada · carlos / demo-mesada');
console.log('  Hijos:   lucia / 1414 · hugo / 1111');
await closePool();
