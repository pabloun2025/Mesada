import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import type { ScreenSession, ScreenState } from './types';

/** Todo lo de la pantalla de un hijo en una llamada. Se repite más a menudo mientras hay una sesión en marcha. */
export function useScreenState(userId: string, enabled = true, fresh = false) {
  return useQuery({
    queryKey: ['screen-state', userId],
    queryFn: async () => ({ ...(await api<ScreenState>(`/screen/${userId}/state`)), _recv: Date.now() }),
    enabled,
    // Las hojas que cobran minutos piden el saldo al abrirse: no se fían de lo que hubiera en memoria.
    ...(fresh ? { staleTime: 0 } : {}),
    refetchInterval: (q) => (q.state.data?.session ? 10_000 : 30_000),
    refetchOnWindowFocus: true,
  });
}

/** Segundos que faltan para el fin previsto, medidos con la hora del servidor (no depende del reloj del móvil). */
export function useRemainingMs(state: ScreenState | undefined, session: ScreenSession | null | undefined) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!session?.planned_end_at) return;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [session?.planned_end_at, session?.id]);
  if (!state || !session?.planned_end_at || session.status !== 'running') return null;
  const skew = Date.parse(state.now) - (state._recv ?? Date.now());
  return Date.parse(session.planned_end_at) - (Date.now() + skew);
}

/** «12:05» o «1:02:05». */
export function clock(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(ss)}` : `${two(m)}:${two(ss)}`;
}

export const DAY_NAMES = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
export const DAY_LETTERS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
