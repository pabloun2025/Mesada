export type Currency = 'EUR' | 'USD';

/**
 * Moneda de la familia (D61): solo cambia el símbolo y el formato; nunca convierte importes.
 * EUR → «6,00 €»; USD → «$6.00». `euros` es el ÚNICO formato de dinero de la interfaz; la sesión fija la moneda al cargar
 * la familia (`setCurrency`) y la aplicación se vuelve a pintar entera si cambia.
 */
let currency: Currency = 'EUR';
const formatters: Record<Currency, Intl.NumberFormat> = {
  EUR: new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' }),
  USD: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }),
};
const int = new Intl.NumberFormat('es-ES');

export const setCurrency = (c: string | undefined) => { currency = c === 'USD' ? 'USD' : 'EUR'; };
export const getCurrency = () => currency;
export const currencySymbol = () => (currency === 'USD' ? '$' : '€');
/** Separador decimal que se escribe y se lee: coma en euros, punto en dólares. */
export const decimalSep = () => (currency === 'USD' ? '.' : ',');
export const euros = (cents: number) => formatters[currency].format(cents / 100);
export const pts = (n: number) => `${int.format(n)} pts`;
export const num = (n: number) => int.format(n);

function parseDate(d: string) {
  return d.length === 10 ? new Date(`${d}T12:00:00`) : new Date(d);
}

export const fmtDate = (d: string, opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'short' }) =>
  new Intl.DateTimeFormat('es-ES', opts).format(parseDate(d));

export const fmtDateTime = (d: string) =>
  new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(d));

export const weekdayLong = (d: string) => new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(parseDate(d));

export function relative(d: string) {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
  if (diff < 60) return 'ahora';
  if (diff < 3600) return rtf.format(-Math.round(diff / 60), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  return rtf.format(-Math.round(diff / 86400), 'day');
}

export function addDays(d: string, n: number) {
  const x = new Date(`${d}T12:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

/** Convierte "5,50" o "5.5" a céntimos (con o sin símbolo de moneda). Devuelve null si no es válido. */
export function parseEuros(s: string): number | null {
  const clean = s.trim().replace(/\s|€|\$/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(clean)) return null;
  return Math.round(parseFloat(clean) * 100);
}

export const WEEKDAYS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
export const WEEKDAYS_LONG = ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'];

/** Referencia corta para recibos: prefijo y las 5 últimas letras o cifras del identificador («RT-4F7K2»). */
export function refCode(prefix: string, id: string) {
  return `${prefix}-${id.replace(/[^0-9a-z]/gi, '').slice(-5).toUpperCase()}`;
}

/** Día («2026-11-21») de un instante en la zona horaria de la familia. */
export function dayKey(iso: string, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

export const fmtTime = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('es-ES', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** «lunes 23 nov» a partir de «2026-11-23». */
export const fmtWeekdayShort = (d: string) => fmtDate(d, { weekday: 'long', day: 'numeric', month: 'short' }).replace(',', '');

/** «Vuelve mañana» / «Vuelve el jueves» (hasta 6 días) / «Vuelve el 3 dic.» desde `today` hasta `until`. */
export function backLabel(until: string, today: string) {
  const n = Math.round((parseDate(until).getTime() - parseDate(today).getTime()) / 86400000);
  if (n <= 1) return 'Vuelve mañana';
  if (n <= 6) return `Vuelve el ${WEEKDAYS_LONG[(parseDate(until).getDay() + 6) % 7]}`;
  return `Vuelve el ${fmtDate(until)}`;
}
