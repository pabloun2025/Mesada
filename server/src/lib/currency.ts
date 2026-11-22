/** Moneda de la familia (D61): solo cambia el símbolo y el formato; los importes nunca se convierten. */
export const CURRENCIES = ['EUR', 'USD'] as const;
export type Currency = (typeof CURRENCIES)[number];

export const isCurrency = (c: unknown): c is Currency => c === 'EUR' || c === 'USD';

/**
 * Único sitio donde el servidor da formato a un importe (en céntimos): avisos, correos, recibos y ZIP de datos.
 * EUR → «6,00 €» (coma decimal, símbolo detrás); USD → «$6.00» (punto decimal, símbolo delante).
 * Los negativos llevan el signo delante: «-6,00 €», «-$6.00».
 */
export function fmtMoney(cents: number, currency: string = 'EUR'): string {
  const abs = Math.abs(cents) / 100;
  const sign = cents < 0 ? '-' : '';
  if (currency === 'USD') return `${sign}$${abs.toFixed(2)}`;
  return `${sign}${abs.toFixed(2).replace('.', ',')} €`;
}

/** Símbolo suelto («€», «$») para etiquetas. */
export const currencySymbol = (currency: string = 'EUR') => (currency === 'USD' ? '$' : '€');
