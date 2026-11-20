import { one, type Db } from './db.js';
import { todayIn } from './dates.js';
import { notFound } from './errors.js';

export interface Family {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  rate_points: number;
  rate_cents: number;
  settlement_period: 'week' | 'month';
  cap_cents: number | null;
  leaderboard_enabled: boolean;
  celebrations_enabled: boolean;
}

export async function getFamily(db: Db, id: string): Promise<Family> {
  const f = await one<Family>(db, 'SELECT * FROM families WHERE id = $1', [id]);
  if (!f) throw notFound('Familia no encontrada');
  return f;
}

export function familyToday(f: Pick<Family, 'timezone'>, now = new Date()) {
  return todayIn(f.timezone, now);
}

/** Céntimos equivalentes a unos puntos según la tasa de la familia (redondeo hacia abajo). */
export function pointsToCents(f: Pick<Family, 'rate_points' | 'rate_cents'>, points: number) {
  return Math.floor((points * f.rate_cents) / f.rate_points);
}

export function centsToPoints(f: Pick<Family, 'rate_points' | 'rate_cents'>, cents: number) {
  if (f.rate_cents === 0) return 0;
  return Math.ceil((cents * f.rate_points) / f.rate_cents);
}
