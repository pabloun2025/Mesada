import { many, one, type Db } from './db.js';
import { addDays, isoWeekday } from './dates.js';
import { zonedToUtc } from './notify/time.js';

export interface DeadlineTask {
  due_time: string | null;
  due_time_weekend: string | null;
}

/** Los festivos de la familia usan la hora del fin de semana. */
export async function holidaysBetween(db: Db, familyId: string, from: string, to: string): Promise<Set<string>> {
  const rows = await many<{ day: string }>(db, 'SELECT day FROM family_holidays WHERE family_id = $1 AND day BETWEEN $2 AND $3', [familyId, from, to]);
  return new Set(rows.map((r) => r.day));
}

export async function isHoliday(db: Db, familyId: string, day: string) {
  return !!(await one(db, 'SELECT 1 FROM family_holidays WHERE family_id = $1 AND day = $2', [familyId, day]));
}

/** Hora límite «HH:MM» que rige ese día: L–V la normal; S–D y festivos la de fin de semana (o la normal si no hay). */
export function deadlineTime(t: DeadlineTask, day: string, holiday: boolean): string | null {
  const weekend = isoWeekday(day) >= 6 || holiday;
  const v = weekend ? (t.due_time_weekend ?? t.due_time) : t.due_time;
  return v ? v.slice(0, 5) : null;
}

/** Instante UTC de la hora límite (en la zona de la familia, también en cambios de hora). */
export function deadlineAt(t: DeadlineTask, day: string, holiday: boolean, tz: string): Date | null {
  const hhmm = deadlineTime(t, day, holiday);
  return hhmm ? zonedToUtc(day, hhmm, tz) : null;
}

/** Primer instante en que ya no se puede completar: las 00:00 del día siguiente (el plazo llega hasta las 23:59). */
export function dayEnd(day: string, tz: string): Date {
  return zonedToUtc(addDays(day, 1), '00:00', tz);
}

export function reducedPoints(points: number, latePercent: number) {
  return Math.round((points * latePercent) / 100);
}
