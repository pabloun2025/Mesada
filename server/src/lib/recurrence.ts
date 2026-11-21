import { addDays, dayOfMonth, daysInMonth, diffDays, isoWeekday } from './dates.js';

export interface TaskSchedule {
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'as_needed';
  weekdays: number[];
  month_day: number | null;
  start_date: string;
  end_date: string | null;
}

/** ¿La tarea tiene una ocurrencia en la fecha dada? */
export function occursOn(t: TaskSchedule, d: string): boolean {
  if (d < t.start_date) return false;
  if (t.end_date && d > t.end_date) return false;
  switch (t.recurrence) {
    case 'once':
      return d === t.start_date;
    case 'as_needed':
      return true; // siempre disponible; la ocurrencia del día se crea al consultar
    case 'daily':
      return t.weekdays.length === 0 || t.weekdays.includes(isoWeekday(d));
    case 'weekly': {
      const days = t.weekdays.length ? t.weekdays : [isoWeekday(t.start_date)];
      return days.includes(isoWeekday(d));
    }
    case 'monthly': {
      const target = t.month_day ?? dayOfMonth(t.start_date);
      return dayOfMonth(d) === Math.min(target, daysInMonth(d));
    }
  }
}

/** Número de ocurrencias anteriores a `d` (para la rotación entre asignados). */
export function occurrenceIndex(t: TaskSchedule, d: string): number {
  if (t.recurrence === 'daily' && t.weekdays.length === 0) return Math.max(0, diffDays(d, t.start_date));
  let n = 0;
  // Iteración acotada: hasta ~5 años de historia.
  const span = Math.min(diffDays(d, t.start_date), 366 * 5);
  for (let i = 0; i < span; i++) {
    if (occursOn(t, addDays(t.start_date, i))) n++;
  }
  return n;
}

/** Fechas de ocurrencia en [from, to]. */
export function occurrencesBetween(t: TaskSchedule, from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (occursOn(t, d)) out.push(d);
  return out;
}
