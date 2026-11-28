import { one, type Db } from './db.js';
import { addDays, periodBounds, startOfWeek } from './dates.js';
import type { Family } from './family.js';

/**
 * Tope semanal de euros. Es el tope por periodo de la familia (`cap_cents`); si el cierre es mensual se
 * prorratea a una semana media (12 meses / 52 semanas). Es la única función que lo calcula.
 * null = la familia no ha puesto tope: el canje no tiene límite y el adelanto y el préstamo no están disponibles.
 */
export function weeklyCapCents(f: Pick<Family, 'cap_cents' | 'settlement_period'>): number | null {
  if (f.cap_cents == null) return null;
  return f.settlement_period === 'week' ? f.cap_cents : Math.floor((f.cap_cents * 12) / 52);
}

/** Euros gastados del tope semanal, incluidos los adelantos imputados a esa semana. */
async function capUsedBetween(db: Db, userId: string, from: string, to: string): Promise<number> {
  const r = await one<{ n: number }>(db, 'SELECT COALESCE(SUM(cents),0)::int AS n FROM cap_uses WHERE user_id = $1 AND cap_week BETWEEN $2 AND $3', [userId, from, to]);
  return r!.n;
}

/** En un mes, el canje cuenta el día en que ocurrió y el adelanto en su semana de destino. */
export async function capUsedInPeriod(db: Db, fam: Family, userId: string, from: string, to: string): Promise<number> {
  if (fam.settlement_period === 'week') return capUsedBetween(db, userId, from, to);
  const r = await one<{ n: number }>(db,
    `SELECT COALESCE(SUM(cents),0)::int AS n FROM cap_uses WHERE user_id = $1
      AND CASE WHEN kind = 'exchange' THEN (created_at AT TIME ZONE $4)::date ELSE cap_week END BETWEEN $2 AND $3`,
    [userId, from, to, fam.timezone]);
  return r!.n;
}

export interface CapStatus {
  weekStart: string;
  weekEnd: string;
  weeklyCap: number | null;
  usedWeek: number;
  /** Lo que aún se puede canjear esta semana; null = sin tope. */
  remaining: number | null;
}

/**
 * Cuánto tope queda ahora mismo. Se respetan dos límites: el semanal y el del periodo de cierre
 * (que incluye lo que ya convirtió un cierre de este mismo periodo).
 */
export async function capStatus(db: Db, fam: Family, userId: string, today: string): Promise<CapStatus> {
  const weekStart = startOfWeek(today);
  const weekEnd = addDays(weekStart, 6);
  const weeklyCap = weeklyCapCents(fam);
  const usedWeek = await capUsedBetween(db, userId, weekStart, weekEnd);
  if (weeklyCap == null || fam.cap_cents == null) return { weekStart, weekEnd, weeklyCap, usedWeek, remaining: null };
  const p = periodBounds(fam.settlement_period, today);
  const usedPeriod = await capUsedInPeriod(db, fam, userId, p.start, p.end);
  const settled = (await one<{ n: number }>(db, 'SELECT COALESCE(SUM(cents),0)::int AS n FROM settlements WHERE user_id = $1 AND period_start = $2', [userId, p.start]))!.n;
  const week = weeklyCap - usedWeek - (fam.settlement_period === 'week' ? settled : 0);
  const period = fam.cap_cents - usedPeriod - settled;
  return { weekStart, weekEnd, weeklyCap, usedWeek, remaining: Math.max(0, Math.min(week, period)) };
}
