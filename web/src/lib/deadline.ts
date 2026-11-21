import { useEffect, useState } from 'react';

/** Hora actual que se refresca cada minuto (y justo al empezar el siguiente), para las cuentas atrás. */
export function useNow(everyMs = 60_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** «25 min», «1 h 5 min». */
export function remaining(ms: number) {
  const m = Math.max(1, Math.ceil(ms / 60_000));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

export const minutesLabel = (n: number) => (n >= 60 && n % 60 === 0 ? `${n / 60} h` : `${n} min`);
