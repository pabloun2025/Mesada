import { config } from './config.js';
import { getPool, one, type Db } from './db.js';

/** Ajustes de la instalación que cambia la administración sin redesplegar. La variable de entorno es el valor inicial. */
export const SETTINGS = {
  registration_open: () => config.allowRegistration,
  notify_paused: () => false,
} as const;
export type SettingKey = keyof typeof SETTINGS;

export async function getSetting(key: SettingKey, db: Db = getPool()): Promise<boolean> {
  const r = await one<{ value: unknown }>(db, 'SELECT value FROM install_settings WHERE key = $1', [key]);
  return r ? r.value === true : SETTINGS[key]();
}

export async function setSetting(key: SettingKey, value: boolean, by: string, db: Db = getPool()) {
  await db.query(
    `INSERT INTO install_settings(key, value, updated_by) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [key, JSON.stringify(value), by],
  );
}
