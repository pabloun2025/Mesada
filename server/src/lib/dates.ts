/** Utilidades de fechas sobre cadenas ISO 'YYYY-MM-DD' (fechas civiles, sin hora). */

export function todayIn(timeZone: string, now = new Date()): string {
  // en-CA formatea como YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function toUTC(d: string): Date {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, day));
}

function fromUTC(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  const x = toUTC(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fromUTC(x);
}

export function diffDays(a: string, b: string): number {
  return Math.round((toUTC(a).getTime() - toUTC(b).getTime()) / 86400000);
}

/** Día ISO de la semana: 1 = lunes ... 7 = domingo */
export function isoWeekday(d: string): number {
  const w = toUTC(d).getUTCDay();
  return w === 0 ? 7 : w;
}

export function daysInMonth(d: string): number {
  const x = toUTC(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
}

export function dayOfMonth(d: string): number {
  return toUTC(d).getUTCDate();
}

export function startOfWeek(d: string): string {
  return addDays(d, 1 - isoWeekday(d));
}

export function startOfMonth(d: string): string {
  return d.slice(0, 8) + '01';
}

export function endOfMonth(d: string): string {
  return d.slice(0, 8) + String(daysInMonth(d)).padStart(2, '0');
}

export function periodBounds(period: 'week' | 'month', d: string): { start: string; end: string } {
  if (period === 'week') {
    const start = startOfWeek(d);
    return { start, end: addDays(start, 6) };
  }
  return { start: startOfMonth(d), end: endOfMonth(d) };
}

export function previousPeriod(period: 'week' | 'month', d: string) {
  const cur = periodBounds(period, d);
  return periodBounds(period, addDays(cur.start, -1));
}

export function isValidDate(d: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(d) && fromUTC(toUTC(d)) === d;
}

/** Primer día del mes desplazado n meses. */
export function addMonthsStart(d: string, n: number): string {
  const [y, m] = d.split('-').map(Number);
  const x = new Date(Date.UTC(y, m - 1 + n, 1));
  return x.toISOString().slice(0, 10);
}
