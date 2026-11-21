/** Horas locales de la familia. */

function parts(date: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const g = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour'), min: g('minute'), s: g('second') };
}

/** Minutos desde medianoche en la zona horaria dada. */
export function localMinutes(date: Date, timeZone: string) {
  const p = parts(date, timeZone);
  return p.h * 60 + p.min;
}

export function hhmmToMinutes(t: string) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Convierte una fecha y hora civiles de la zona dada a un instante UTC. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  // Dos pasadas bastan para los cambios de hora.
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const p = parts(new Date(t), timeZone);
    const shown = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    t += guess - shown;
  }
  return new Date(t);
}

export function inQuietHours(nowMin: number, startMin: number, endMin: number) {
  if (startMin === endMin) return false;
  return startMin < endMin ? nowMin >= startMin && nowMin < endMin : nowMin >= startMin || nowMin < endMin;
}

/**
 * Primer instante permitido para enviar: ahora, o el final del horario de silencio.
 */
export function nextAllowedTime(now: Date, timeZone: string, quietStart: string, quietEnd: string): Date {
  const nowMin = localMinutes(now, timeZone);
  const s = hhmmToMinutes(quietStart);
  const e = hhmmToMinutes(quietEnd);
  if (!inQuietHours(nowMin, s, e)) return now;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  let candidate = zonedToUtc(today, quietEnd, timeZone);
  if (candidate <= now) {
    const next = new Date(`${today}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    candidate = zonedToUtc(next.toISOString().slice(0, 10), quietEnd, timeZone);
  }
  return candidate;
}
