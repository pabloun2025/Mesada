import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getPool, many, one } from './db.js';
import { removePhotoFile } from './photos.js';

export interface CleanupReport {
  at: string;
  expiredPhotos: number;
  orphanFiles: number;
  missingFileRows: number;
  sessions: number;
  trustedDevices: number;
  notifications: number;
  outbox: number;
  resets: number;
  invitations: number;
  serverErrors: number;
  freedBytes: number;
}

const size = (abs: string) => {
  try { return fs.statSync(abs).size; } catch { return 0; }
};

/** Archivos de fotos que hay en disco: ruta relativa → tamaño y fecha. */
export function photoFilesOnDisk(): { rel: string; bytes: number; mtimeMs: number }[] {
  const root = path.resolve(config.uploadDir);
  const out: { rel: string; bytes: number; mtimeMs: number }[] = [];
  if (!fs.existsSync(root)) return out;
  for (const fam of fs.readdirSync(root, { withFileTypes: true })) {
    if (!fam.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(root, fam.name), { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const st = fs.statSync(path.join(root, fam.name, f.name));
      out.push({ rel: path.join(fam.name, f.name), bytes: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

/**
 * Limpieza (cada noche y desde Administración). Borra: fotos de tareas validadas hace más de PHOTO_RETENTION_DAYS (7),
 * archivos sin fila y filas sin archivo, sesiones y dispositivos de confianza caducados, avisos y envíos antiguos,
 * enlaces de recuperación e invitaciones caducados y errores de más de 30 días. Es idempotente y no toca datos vivos:
 * ni tareas sin validar, ni avisos sin enviar. Devuelve qué borró y cuánto espacio liberó (solo cifras, sin datos personales).
 */
export async function runCleanup(now = new Date()): Promise<CleanupReport> {
  const db = getPool();
  const r = config.retention;
  let freed = 0;

  // 1) Fotos caducadas: tarea aceptada, parcial o rechazada hace más de N días.
  const expired = await many<{ id: string; photo_path: string }>(
    db,
    `SELECT id, photo_path FROM task_instances
      WHERE photo_path IS NOT NULL AND status IN ('approved','declined') AND reviewed_at IS NOT NULL AND reviewed_at < $1::timestamptz - make_interval(days => $2)`,
    [now, r.photoDays],
  );
  for (const e of expired) {
    const abs = path.resolve(config.uploadDir, e.photo_path);
    freed += size(abs);
    removePhotoFile(e.photo_path);
    await db.query('UPDATE task_instances SET photo_path = NULL, photo_deleted_at = $2 WHERE id = $1', [e.id, now]);
  }

  // 2) Archivos sin fila (más de una hora, para no pisar una subida en curso) y filas sin archivo.
  const referenced = new Set((await many<{ photo_path: string }>(db, 'SELECT photo_path FROM task_instances WHERE photo_path IS NOT NULL')).map((x) => path.normalize(x.photo_path)));
  let orphanFiles = 0;
  for (const f of photoFilesOnDisk()) {
    if (referenced.has(path.normalize(f.rel)) || now.getTime() - f.mtimeMs < 3_600_000) continue;
    freed += f.bytes;
    removePhotoFile(f.rel);
    orphanFiles++;
  }
  let missing = 0;
  for (const row of await many<{ id: string; photo_path: string }>(db, 'SELECT id, photo_path FROM task_instances WHERE photo_path IS NOT NULL')) {
    if (!fs.existsSync(path.resolve(config.uploadDir, row.photo_path))) {
      await db.query('UPDATE task_instances SET photo_path = NULL, photo_deleted_at = $2 WHERE id = $1', [row.id, now]);
      missing++;
    }
  }

  // 3) Sesiones, avisos, envíos, enlaces e invitaciones.
  const n = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rowCount ?? 0;
  const sessions = await n('DELETE FROM sessions WHERE expires_at < $1', [now]);
  const trustedDevices = await n('DELETE FROM admin_trusted_devices WHERE expires_at < $1', [now]);
  const notifications = await n(`DELETE FROM notifications WHERE created_at < $1::timestamptz - make_interval(days => $2)`, [now, r.notificationDays]);
  // Solo lo ya resuelto: lo pendiente se queda hasta que salga o falle.
  const outbox = await n(`DELETE FROM notification_outbox WHERE status <> 'pending' AND created_at < $1::timestamptz - make_interval(days => $2)`, [now, r.outboxDays]);
  const resets = await n(`DELETE FROM password_resets WHERE expires_at < $1 OR used_at IS NOT NULL`, [now]);
  const invitations = await n(`DELETE FROM invitations WHERE accepted_at IS NULL AND expires_at < $1`, [now]);
  const serverErrors = await n(`DELETE FROM server_errors WHERE created_at < $1::timestamptz - interval '30 days'`, [now]);

  return {
    at: now.toISOString(), expiredPhotos: expired.length, orphanFiles, missingFileRows: missing, sessions, trustedDevices, notifications,
    outbox, resets, invitations, serverErrors, freedBytes: freed,
  };
}

/** Deja constancia en el registro de administración (solo cifras) y guarda cuándo fue la última. */
export async function recordCleanup(rep: CleanupReport, actorId: string | null, trigger: 'noche' | 'manual') {
  await getPool().query(`INSERT INTO admin_audit(actor_id, action, data) VALUES ($1, 'maintenance.cleanup', $2)`, [actorId, JSON.stringify({ ...rep, trigger })]);
  await getPool().query(
    `INSERT INTO install_settings(key, value, updated_by) VALUES ('cleanup_last', $1::jsonb, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [JSON.stringify({ ...rep, trigger }), actorId],
  );
}

export async function lastCleanup(): Promise<(CleanupReport & { trigger: string }) | null> {
  const r = await one<{ value: any }>(getPool(), `SELECT value FROM install_settings WHERE key = 'cleanup_last'`);
  return r?.value ?? null;
}

/** Cada noche (03:30 hora de Madrid, con margen de una hora por si el servidor estaba parado). */
export async function maybeNightlyCleanup(now = new Date()): Promise<CleanupReport | null> {
  const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Madrid' }).format(now));
  if (h < 3 || h >= 5) return null;
  const last = await lastCleanup();
  if (last && now.getTime() - new Date(last.at).getTime() < 20 * 3_600_000) return null;
  const rep = await runCleanup(now);
  await recordCleanup(rep, null, 'noche');
  return rep;
}
