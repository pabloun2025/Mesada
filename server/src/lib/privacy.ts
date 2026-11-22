import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { LEGAL_VERSION } from './legal.js';
import { getPool, many, one, tx, type Db } from './db.js';
import { fmtMoney } from './currency.js';
import type { ZipEntry } from './zip.js';

/* ---------- Descarga de todos los datos de la familia ---------- */

/** Columnas que nunca salen en la descarga: secretos y claves técnicas. */
const OMIT: Record<string, string[]> = {
  users: ['password_hash', 'totp_secret', 'totp_pending', 'totp_last_counter'],
  invitations: ['token_hash'],
};

type Spec = { key: string; table: string; where: string };
const BY_FAMILY = (table: string, key = table): Spec => ({ key, table, where: 't.family_id = $1' });
const BY_USER = (table: string, key = table): Spec => ({ key, table, where: 't.user_id IN (SELECT id FROM users WHERE family_id = $1)' });

/** Qué fichero JSON lleva qué tablas. Nombres en español: es lo que verá la persona al abrir el ZIP. */
const FILES: { file: string; about: string; specs: Spec[] }[] = [
  { file: 'familia.json', about: 'Ajustes de la familia', specs: [{ key: 'familia', table: 'families', where: 't.id = $1' }, BY_FAMILY('family_holidays', 'festivos')] },
  { file: 'miembros.json', about: 'Adultos e hijos (sin contraseñas ni claves)', specs: [{ key: 'miembros', table: 'users', where: 't.family_id = $1' }, BY_USER('user_badges', 'insignias')] },
  { file: 'tareas.json', about: 'Tareas y a quién se asignan', specs: [BY_FAMILY('tasks', 'tareas'), { key: 'asignaciones', table: 'task_assignees', where: 't.task_id IN (SELECT id FROM tasks WHERE family_id = $1)' }] },
  { file: 'tareas-hechas.json', about: 'Cada vez que se hizo una tarea, con notas, estado y la foto de evidencia (carpeta fotos/)', specs: [BY_FAMILY('task_instances', 'tareas_hechas')] },
  { file: 'puntos.json', about: 'Libro de puntos', specs: [BY_FAMILY('points_ledger', 'movimientos_de_puntos')] },
  { file: 'dinero.json', about: 'Libro de dinero, cierres semanales y pagos', specs: [BY_FAMILY('money_ledger', 'movimientos_de_dinero'), BY_FAMILY('settlements', 'cierres'), BY_FAMILY('payments', 'pagos'), BY_FAMILY('payout_requests', 'peticiones_de_pago')] },
  { file: 'banco.json', about: 'Metas de ahorro (con su foto, en la carpeta fotos/), préstamos y topes', specs: [BY_FAMILY('savings_goals', 'metas'), BY_FAMILY('goal_requests', 'peticiones_de_meta'), BY_FAMILY('loans', 'prestamos'), BY_FAMILY('loan_charges', 'cuotas'), BY_FAMILY('cap_uses', 'usos_del_tope')] },
  { file: 'recompensas.json', about: 'Recompensas, canjes y premios por bono', specs: [BY_FAMILY('rewards', 'recompensas'), BY_FAMILY('redemptions', 'canjes'), BY_FAMILY('bonus_grants', 'bonos'), BY_USER('bonus_claims', 'sorpresas_reclamadas')] },
  { file: 'pantalla.json', about: 'Minutos de pantalla, planes, ajustes y usos', specs: [BY_FAMILY('screen_ledger', 'movimientos'), BY_FAMILY('screen_lots', 'lotes'), BY_FAMILY('screen_plans', 'planes'), BY_FAMILY('screen_adjust_reasons', 'motivos_de_ajuste'), BY_FAMILY('screen_adjustments', 'ajustes'), BY_FAMILY('screen_usage_logs', 'usos'), BY_FAMILY('honesty_days', 'dias_de_honestidad'), BY_FAMILY('screen_sessions', 'sesiones'), BY_FAMILY('screen_debts', 'excesos'), BY_FAMILY('screen_blocks', 'bloqueos')] },
  { file: 'avisos.json', about: 'Avisos dentro de la app, envíos por correo o WhatsApp y preferencias', specs: [BY_USER('notifications', 'avisos'), BY_FAMILY('notification_outbox', 'envios'), BY_USER('notification_prefs', 'preferencias'), BY_FAMILY('cheers', 'felicitaciones')] },
  { file: 'invitaciones.json', about: 'Invitaciones a otros adultos y parientes (con su correo, teléfono y parentesco)', specs: [BY_FAMILY('invitations', 'invitaciones')] },
  { file: 'historial.json', about: 'Historial de todo lo que se ha hecho', specs: [BY_FAMILY('audit_log', 'historial')] },
];

/** Tablas que se descargan y tablas que se dejan fuera a propósito (secretos, sesiones y registros de administración). */
export const EXPORTED_TABLES = FILES.flatMap((f) => f.specs.map((x) => x.table));
export const NOT_EXPORTED_TABLES = ['sessions', 'password_resets', 'admin_audit', 'admin_recovery_codes', 'admin_trusted_devices', 'install_settings', 'notification_usage', 'schema_migrations', 'server_errors'];

function omit(table: string, rows: Record<string, unknown>[]) {
  const drop = OMIT[table];
  if (!drop) return rows;
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))));
}

/** Ruta de la foto dentro del ZIP (el nombre original lleva un UUID, no datos personales). */
const zipPhoto = (rel: string) => `fotos/${path.basename(rel)}`;

const README = (famName: string, currency: string) => `DiploP · descarga de los datos de la familia «${famName}»
Generada el ${new Date().toISOString().slice(0, 10)}.

Qué hay aquí
- Un fichero .json por tema (miembros, tareas, puntos, dinero, pantalla, avisos, historial…).
  Se abren con cualquier editor de texto o con un navegador. Las fechas van en formato internacional (UTC).
- La carpeta fotos/ con las fotos de evidencia que subieron los hijos y las de sus metas de ahorro. En tareas-hechas.json
  y banco.json, el campo photo_path indica qué foto es cada una.
- No incluye contraseñas, PIN ni claves: no se guardan en claro y no se pueden descargar.

Importes: el dinero va en céntimos de la moneda de la familia (500 = ${fmtMoney(500, currency)}); los puntos y los minutos, en enteros.
Esta descarga es tu derecho de acceso y de portabilidad (RGPD, arts. 15 y 20).
Dudas: privacidad@veryfacil.org
`;

/** Genera los ficheros del ZIP, uno a uno. */
export async function* exportEntries(familyId: string, db: Db = getPool()): AsyncGenerator<ZipEntry> {
  const fam = await one<{ name: string; currency: string }>(db, 'SELECT name, currency FROM families WHERE id = $1', [familyId]);
  yield { name: 'LEEME.txt', data: Buffer.from(README(fam?.name ?? '', fam?.currency ?? 'EUR'), 'utf8'), deflate: true };

  // Fotos que existen de verdad en disco (la fila puede apuntar a una ya borrada).
  const photoRows = await many<{ photo_path: string }>(db, 'SELECT photo_path FROM task_instances WHERE family_id = $1 AND photo_path IS NOT NULL UNION ALL SELECT photo_path FROM savings_goals WHERE family_id = $1 AND photo_path IS NOT NULL UNION ALL SELECT challenge_photo_path FROM screen_blocks WHERE family_id = $1 AND challenge_photo_path IS NOT NULL', [familyId]);
  const photos = photoRows.map((r) => r.photo_path).filter((rel) => safePhotoPath(rel) && fs.existsSync(safePhotoPath(rel)!));
  const have = new Set(photos);

  for (const f of FILES) {
    const out: Record<string, unknown> = {};
    for (const s of f.specs) {
      const rows = await many(db, `SELECT t.* FROM ${s.table} t WHERE ${s.where}`, [familyId]);
      out[s.key] = omit(s.table, rows).map((r) => ((s.table === 'task_instances' || s.table === 'savings_goals') && r.photo_path ? { ...r, photo_path: have.has(String(r.photo_path)) ? zipPhoto(String(r.photo_path)) : null } : s.table === 'screen_blocks' && r.challenge_photo_path ? { ...r, challenge_photo_path: have.has(String(r.challenge_photo_path)) ? zipPhoto(String(r.challenge_photo_path)) : null } : r));
    }
    yield { name: f.file, data: Buffer.from(JSON.stringify({ descripcion: f.about, ...out }, null, 2), 'utf8'), deflate: true };
  }
  for (const rel of photos) {
    yield { name: zipPhoto(rel), data: async () => fs.promises.readFile(safePhotoPath(rel)!) };
  }
}

/** Ruta absoluta de una foto, o null si intenta salirse de la carpeta de subidas. */
export function safePhotoPath(rel: string): string | null {
  const root = path.resolve(config.uploadDir);
  const abs = path.resolve(root, rel);
  return abs.startsWith(root + path.sep) ? abs : null;
}

/* ---------- Borrado ---------- */

/** Dentro de la transacción: permite borrar libros e historial (ver migración 013). Solo se activa aquí. */
async function allowErasure(db: Db) {
  await db.query(`SELECT set_config('mesada.erasure', 'on', true)`);
}

export interface FamilyErasure { users: number; photos: number }

/** Borra la familia entera: filas (en cascada), sesiones, fotos y el rastro en la administración. */
export async function eraseFamily(familyId: string): Promise<FamilyErasure> {
  const res = await tx(async (db) => {
    await allowErasure(db);
    const users = (await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM users WHERE family_id = $1', [familyId]))!.n;
    // El registro de administración apunta a la familia con SET NULL: se borra para que no quede rastro.
    await db.query('DELETE FROM admin_audit WHERE family_id = $1 OR user_id IN (SELECT id FROM users WHERE family_id = $1)', [familyId]);
    await db.query('DELETE FROM families WHERE id = $1', [familyId]);
    // Constancia sin datos personales de que se ejecutó el borrado.
    await db.query(`INSERT INTO admin_audit(actor_id, action, data) VALUES (NULL, 'family.erased', $1)`, [JSON.stringify({ users })]);
    return { users };
  });
  const photos = removePhotoDir(familyId);
  return { ...res, photos };
}

function removePhotoDir(familyId: string): number {
  const dir = safePhotoPath(familyId);
  if (!dir || !fs.existsSync(dir)) return 0;
  const n = fs.readdirSync(dir).length;
  fs.rmSync(dir, { recursive: true, force: true });
  return n;
}

/** Borra un hijo: su cuenta, movimientos, avisos, fotos y su rastro en el historial. */
export async function eraseChild(familyId: string, userId: string): Promise<{ photos: number }> {
  const photos = await tx(async (db) => {
    await allowErasure(db);
    // Fotos y notas de lo que marcó él, también en tareas compartidas que siguen existiendo.
    const rows = await many<{ photo_path: string | null }>(
      db,
      `SELECT photo_path FROM task_instances WHERE family_id = $1 AND photo_path IS NOT NULL AND (completed_by = $2 OR assignee_id = $2)`,
      [familyId, userId],
    );
    await db.query(`UPDATE task_instances SET photo_path = NULL, child_note = NULL WHERE family_id = $1 AND completed_by = $2`, [familyId, userId]);
    // Las fotos de sus metas de ahorro también (las filas de las metas se van con su cuenta).
    for (const g of await many<{ photo_path: string }>(db, 'SELECT photo_path FROM savings_goals WHERE user_id = $1 AND photo_path IS NOT NULL', [userId])) rows.push({ photo_path: g.photo_path });
    // Y las de los retos de pantalla.
    for (const g of await many<{ challenge_photo_path: string }>(db, 'SELECT challenge_photo_path FROM screen_blocks WHERE user_id = $1 AND challenge_photo_path IS NOT NULL', [userId])) rows.push({ photo_path: g.challenge_photo_path });
    await db.query(
      `DELETE FROM audit_log WHERE family_id = $1 AND (actor_id = $2 OR (entity = 'user' AND entity_id = $2) OR data->>'for' = $2::text OR data->>'userId' = $2::text)`,
      [familyId, userId],
    );
    await db.query('DELETE FROM admin_audit WHERE user_id = $1', [userId]);
    await db.query('DELETE FROM users WHERE id = $1 AND family_id = $2 AND role = \'child\'', [userId, familyId]);
    return rows.map((r) => r.photo_path!).filter(Boolean);
  });
  let n = 0;
  for (const rel of photos) {
    const abs = safePhotoPath(rel);
    if (abs && fs.existsSync(abs)) { fs.rmSync(abs, { force: true }); n++; }
  }
  return { photos: n };
}

export { LEGAL_VERSION };
