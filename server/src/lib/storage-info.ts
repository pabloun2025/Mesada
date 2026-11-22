import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { getPool, many, one } from './db.js';
import { photoFilesOnDisk } from './cleanup.js';

export const BACKUP_STALE_HOURS = 26;

/** Espacio del volumen de datos, fotos y base. Solo cifras. */
export async function storageInfo() {
  let disk: { totalBytes: number; freeBytes: number; usedBytes: number } | null = null;
  try {
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const s = fs.statfsSync(config.uploadDir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    disk = { totalBytes: total, freeBytes: free, usedBytes: total - free };
  } catch { /* sin información del volumen */ }
  const files = photoFilesOnDisk();
  const db = await one<{ bytes: string }>(getPool(), 'SELECT pg_database_size(current_database())::text AS bytes');
  return { disk, photos: { count: files.length, bytes: files.reduce((a, f) => a + f.bytes, 0) }, dbBytes: Number(db?.bytes ?? 0) };
}

interface BackupFile { name: string; bytes: number; at: string }

/**
 * Copias locales (carpeta de copias, montada en solo lectura) y, si la copia externa está activa, las de R2: el servicio
 * `backup` escribe `.r2-list.txt` tras cada pasada («tamaño;fecha;nombre» por línea) y `.r2-ok` con la fecha de la última subida buena.
 * La app no tiene las claves de R2.
 */
export function backupsInfo(now = new Date()) {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return null;
  let local: BackupFile[] = [];
  try {
    local = fs.readdirSync(dir)
      .filter((f) => /^(mesada-.*\.dump|fotos-.*\.tar\.gz)$/.test(f))
      .map((name) => { const st = fs.statSync(path.join(dir, name)); return { name, bytes: st.size, at: st.mtime.toISOString() }; })
      .sort((a, b) => b.at.localeCompare(a.at));
  } catch { return null; }
  let r2: { configured: boolean; files: BackupFile[]; lastOkAt: string | null } = { configured: false, files: [], lastOkAt: null };
  try {
    const list = path.join(dir, '.r2-list.txt');
    if (fs.existsSync(list)) {
      r2.configured = true;
      r2.files = fs.readFileSync(list, 'utf8').split('\n').filter(Boolean).map((l) => {
        const [bytes, at, ...name] = l.split(';');
        return { name: name.join(';'), bytes: Number(bytes), at: new Date(at).toISOString() };
      }).filter((f) => f.name && !Number.isNaN(Date.parse(f.at))).sort((a, b) => b.at.localeCompare(a.at));
    }
    const ok = path.join(dir, '.r2-ok');
    if (fs.existsSync(ok)) { r2.configured = true; r2.lastOkAt = fs.statSync(ok).mtime.toISOString(); }
  } catch { /* sin lista */ }
  const newestLocal = local.find((f) => f.name.startsWith('mesada-'))?.at ?? null;
  const ageH = (iso: string | null) => (iso ? (now.getTime() - new Date(iso).getTime()) / 3_600_000 : Infinity);
  return {
    local: local.slice(0, 30), r2, newestLocalAt: newestLocal,
    localStale: ageH(newestLocal) > BACKUP_STALE_HOURS,
    r2Stale: r2.configured ? ageH(r2.lastOkAt) > BACKUP_STALE_HOURS : false,
    staleHours: BACKUP_STALE_HOURS,
  };
}

export interface InactiveFamily { id: string; name: string; members: number; created_at: string; last_use: string }

/** Familias sin sesión ni actividad en N meses. Solo nombre, nº de miembros y fechas; nunca datos de los menores. */
export async function inactiveFamilies(months = config.retention.inactiveFamilyMonths, onlyId?: string): Promise<InactiveFamily[]> {
  return many<InactiveFamily>(
    getPool(),
    `SELECT * FROM (
       SELECT f.id, f.name, f.created_at,
              (SELECT count(*)::int FROM users u WHERE u.family_id = f.id) AS members,
              GREATEST(f.created_at,
                (SELECT max(last_login_at) FROM users WHERE family_id = f.id),
                (SELECT max(s.created_at) FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.family_id = f.id),
                (SELECT max(created_at) FROM audit_log WHERE family_id = f.id)) AS last_use
         FROM families f
        WHERE NOT EXISTS (SELECT 1 FROM users WHERE family_id = f.id AND is_superadmin)
          AND ($2::uuid IS NULL OR f.id = $2)
     ) x WHERE last_use < now() - make_interval(months => $1) ORDER BY last_use`,
    [months, onlyId ?? null],
  );
}
