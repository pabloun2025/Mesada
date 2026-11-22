import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Hourglass } from 'lucide-react';
import { api, post } from '../lib/api';
import { chime, prefersReducedMotion, startAlarm } from '../lib/alarm';
import { useSession } from '../lib/session';
import { useRemainingMs, useScreenState } from '../lib/screen-state';
import type { ScreenView } from '../lib/types';
import { Button, useToast } from './ui';

const ackKey = (id: string) => `mesada:screen-ack:${id}`;
const acked = (id: string) => { try { return localStorage.getItem(ackKey(id)) === '1'; } catch { return false; } };
const setAcked = (id: string) => { try { localStorage.setItem(ackKey(id), '1'); } catch { /* sin almacenamiento */ } };

/**
 * Aviso a los 5 minutos y alarma al llegar a 0 en la app del hijo: sonido (Web Audio), vibración si existe y pantalla
 * «Se acabó el tiempo». El que manda es el servidor: la cuenta atrás se mide con su hora y, vencida, él cierra la sesión;
 * si la app se abre más tarde, la pantalla sigue ahí hasta que el hijo la cierra.
 */
export function ScreenAlarm() {
  const { user } = useSession();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useScreenState(user.id);
  const state = q.data;
  const session = state?.session ?? null;
  const ms = useRemainingMs(state, session);
  const warned = useRef(new Set<string>());
  const played = useRef(new Set<string>());
  const stopSound = useRef<null | (() => void)>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const [closed, setClosed] = useState(0); // fuerza el repintado al cerrar la pantalla
  void closed;

  // Aviso previo a los 5 minutos (una vez por sesión y ampliación).
  useEffect(() => {
    if (!session || ms == null || ms <= 0 || ms > 5 * 60_000) return;
    const total = session.requested_minutes + session.extended_minutes;
    const key = `${session.id}:${session.extended_minutes}`;
    if (total <= 5 || warned.current.has(key)) return;
    warned.current.add(key);
    chime();
    toast('Te quedan 5 minutos de pantalla');
  }, [session, ms, toast]);

  // Al llegar a 0, se le pide al servidor que cierre la sesión (sin esperar al siguiente repaso).
  const zero = session != null && ms != null && ms <= 0;
  useEffect(() => {
    if (!zero) return;
    const refetch = () => qc.invalidateQueries({ queryKey: ['screen-state', user.id] });
    refetch();
    const id = setInterval(refetch, 3000);
    return () => clearInterval(id);
  }, [zero, qc, user.id]);

  const last = state?.last_session ?? null;
  const showEnd = !!last && last.end_reason === 'expired' && !!last.ended_at && !acked(last.id) && Date.now() - Date.parse(last.ended_at) < 12 * 3600_000;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (showEnd && !d.open) {
      d.showModal();
      // Solo suena si acaba de terminar: si abre la app horas después, ve la pantalla pero sin ruido.
      if (last && !played.current.has(last.id) && Date.now() - Date.parse(last.ended_at!) < 3 * 60_000) {
        played.current.add(last.id);
        stopSound.current = startAlarm();
      }
    }
    if (!showEnd && d.open) d.close();
  }, [showEnd, last]);

  const finish = () => {
    stopSound.current?.();
    stopSound.current = null;
    if (last) setAcked(last.id);
    setClosed((n) => n + 1);
    dialog.current?.close();
    qc.invalidateQueries({ queryKey: ['screen-state', user.id] });
  };
  const over = useMutation({
    mutationFn: (minutes: number) => post(`/screen/sessions/${last!.id}/overrun`, { minutes }),
    onSuccess: (_r, minutes) => { toast(`Anotado: ${minutes} min de más. Se descuentan la semana siguiente`); qc.invalidateQueries(); finish(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  return (
    <dialog ref={dialog} aria-label="Se acabó el tiempo" onCancel={(e) => { e.preventDefault(); finish(); }} className="m-auto w-[min(92vw,24rem)] overflow-visible bg-transparent p-0 backdrop:bg-[#0c1428]/80">
      {last && showEnd ? (
        <div role="alertdialog" aria-labelledby="alarm-title" className="relative overflow-hidden rounded-[var(--radius-panel)] bg-[var(--card)] p-7 text-center text-[var(--fg)]">
          <p className={`flex justify-center text-berry ${prefersReducedMotion() ? '' : 'alarm-ring'}`} aria-hidden><AlarmClock size={72} strokeWidth={1.75} /></p>
          <h2 id="alarm-title" className="mt-3 font-display text-3xl font-extrabold">Se acabó el tiempo</h2>
          <p className="mt-2 muted">Han pasado tus {last.requested_minutes + last.extended_minutes} min de pantalla. Es hora de parar.</p>
          <Button size="lg" className="mt-5 w-full" onClick={finish}>Vale, ya paro</Button>
          <div className="mt-4 border-t border-[var(--line)] pt-3">
            <p className="text-sm muted">¿Te has pasado? Dilo con sinceridad: se descuenta de la semana siguiente.</p>
            <div className="mt-2 flex justify-center gap-2" role="group" aria-label="Minutos de más">
              {[5, 10, 15].map((m) => (
                <button key={m} type="button" disabled={over.isPending} onClick={() => over.mutate(m)} className="num h-11 rounded-full bg-[var(--chip)] px-4 font-bold disabled:opacity-50">+{m} min</button>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </dialog>
  );
}

/** Notificación que sale del vuelo: icono y texto. */
const CREDIT_KINDS = new Set(['bonus', 'task', 'adjustment', 'refund']);

/**
 * Cuando un adulto valida una tarea que da minutos, «vuelan» a la batería Ganado. Recuerda hasta qué momento ya los vio
 * (por aparato) para animar solo lo nuevo. Con «reducir movimiento», solo aparece el aviso, sin volar.
 */
export function MinutesFlight() {
  const { user } = useSession();
  const q = useQuery({ queryKey: ['screen', user.id], queryFn: () => api<ScreenView>(`/screen/${user.id}`), refetchInterval: 30_000, refetchOnWindowFocus: true });
  const [flight, setFlight] = useState<{ text: string; key: string } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const seenKey = `mesada:minutes-seen:${user.id}`;

  useEffect(() => {
    const entries = q.data?.entries;
    if (!entries) return;
    const credits = entries.filter((e) => e.delta > 0 && CREDIT_KINDS.has(e.kind) && e.kind !== 'refund');
    const newest = credits.reduce((m, e) => (e.created_at > m ? e.created_at : m), '');
    let seen: string | null = null;
    try { seen = localStorage.getItem(seenKey); } catch { /* sin almacenamiento */ }
    // La primera vez no se anima el historial entero: se apunta hasta dónde llega.
    if (seen == null) { try { localStorage.setItem(seenKey, newest || new Date(0).toISOString()); } catch { /* nada */ } return; }
    const fresh = credits.filter((e) => e.created_at > seen!);
    if (!fresh.length) return;
    try { localStorage.setItem(seenKey, newest); } catch { /* nada */ }
    const total = fresh.reduce((s, e) => s + e.delta, 0);
    setFlight({ text: `+${total} min`, key: newest });
  }, [q.data, seenKey]);

  useEffect(() => {
    if (!flight || !ref.current) return;
    const el = ref.current;
    const targets = [...document.querySelectorAll('[data-minutes-target]'), ...document.querySelectorAll('[data-minutes-fallback]')].filter((t) => t.getBoundingClientRect().width > 0);
    const target = targets[0];
    if (prefersReducedMotion() || !target) {
      const id = setTimeout(() => setFlight(null), 3500);
      return () => clearTimeout(id);
    }
    const to = target.getBoundingClientRect();
    const from = el.getBoundingClientRect();
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const a = el.animate(
      [{ transform: 'translate(0,0) scale(1)', opacity: 1 }, { transform: 'translate(0,0) scale(1.25)', opacity: 1, offset: 0.35 }, { transform: `translate(${dx}px,${dy}px) scale(0.3)`, opacity: 0.15 }],
      { duration: 1500, easing: 'cubic-bezier(0.5, 0, 0.3, 1)', fill: 'forwards' },
    );
    a.onfinish = () => {
      target.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.07)' }, { transform: 'scale(1)' }], { duration: 450 });
      setFlight(null);
    };
    return () => a.cancel();
  }, [flight]);

  if (!flight) return null;
  return (
    <div aria-hidden={false} className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      <span ref={ref} role="status" data-testid="minutes-flight" className="num inline-flex items-center gap-2 rounded-full bg-sun px-5 py-3 text-2xl font-extrabold text-ink shadow-[0_10px_30px_-8px_rgb(227_162_0/0.9)]">
        <Hourglass size={22} aria-hidden /> {flight.text} <span className="sr-only">de pantalla ganados</span>
      </span>
    </div>
  );
}
