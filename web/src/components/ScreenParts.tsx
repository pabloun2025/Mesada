import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarClock, Clock, History, Lock, Sparkles, Timer } from 'lucide-react';
import { api, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { euros, fmtDateTime, fmtTime } from '../lib/format';
import { minutesHM } from '../lib/deadline';
import { categoryInfo } from '../lib/screen';
import { clock, useRemainingMs } from '../lib/screen-state';
import type { ScreenSession, ScreenState } from '../lib/types';
import { Avatar, Badge, Button, Empty, Field, useToast } from './ui';
import { expiryPhrase } from './ScreenPanel';

/** Una batería: cuánto queda de lo que entró. Baja a medida que se gasta. */
function Battery({ label, tone, minutes, amount, caption, testId, target }: { label: string; tone: 'sky' | 'sun'; minutes: number; amount: number; caption: string; testId: string; target?: boolean }) {
  const pct = amount > 0 ? Math.max(minutes > 0 ? 6 : 0, Math.min(100, Math.round((minutes / amount) * 100))) : 0;
  const fill = tone === 'sky' ? 'bg-sky' : 'bg-sun';
  const Icon = tone === 'sky' ? CalendarClock : Sparkles;
  return (
    <div className="card min-w-0 p-3.5" data-testid={testId} {...(target ? { 'data-minutes-target': '' } : {})}>
      <p className="flex items-center gap-1.5 text-sm font-bold">
        <Icon size={16} aria-hidden className={tone === 'sky' ? 'text-sky' : 'text-sun-ink dark:text-sun'} /> {label}
      </p>
      <p className="num mt-1 text-2xl leading-tight font-extrabold">{minutesHM(minutes)}</p>
      <div className="mt-2.5 flex items-center" role="img" aria-label={`Batería ${label}: ${pct} % llena`}>
        <div className="relative h-7 min-w-0 flex-1 overflow-hidden rounded-lg border-2 border-[var(--line)] bg-[var(--bg)]">
          <div className={`h-full rounded-[0.3rem] ${fill} transition-[width] duration-700 ease-out`} style={{ width: `${pct}%` }} />
        </div>
        <span aria-hidden className="h-3.5 w-1.5 rounded-r bg-[var(--line)]" />
      </div>
      <p className="mt-2 text-xs leading-snug muted">{caption}</p>
    </div>
  );
}

/** Las dos baterías: «Semana» (plan gratis, azul, se recarga el lunes) y «Ganado» (dorado, lotes con caducidad). */
export function ScreenBatteries({ state }: { state: ScreenState }) {
  const { plan, earned } = state.buckets;
  const tz = state.timezone;
  const first = earned.lots[0];
  return (
    <section aria-label="Tus baterías de pantalla">
      <div className="grid grid-cols-2 gap-3">
        <Battery
          label="Semana" tone="sky" minutes={plan.minutes} amount={plan.amount || state.plan.minutes_per_week} testId="battery-week"
          caption={plan.minutes > 0 && plan.expires_at ? `Gratis · caduca ${expiryPhrase(plan.expires_at, tz)}` : state.plan.enabled ? 'Gratis · se recarga el lunes' : 'Sin plan semanal'}
        />
        <Battery
          label="Ganado" tone="sun" minutes={earned.minutes} amount={earned.amount} testId="battery-earned" target
          caption={first ? `${first.minutes} min caducan ${expiryPhrase(first.expires_at, tz, true)}` : 'Los ganas con tareas'}
        />
      </div>
      {earned.lots.length > 1 ? (
        <ul aria-label="Lotes de minutos ganados" className="mt-2 flex flex-wrap gap-1.5 text-xs">
          {earned.lots.map((l, i) => <li key={i} className="num rounded-full bg-[var(--chip)] px-2.5 py-1">{l.minutes} min · {expiryPhrase(l.expires_at, tz)}</li>)}
        </ul>
      ) : null}
      <p className="mt-2 px-1 text-xs muted">Se gasta primero lo que caduca antes.</p>
    </section>
  );
}

/** Cuenta atrás grande de la sesión en marcha. */
export function Countdown({ state, session, children }: { state: ScreenState; session: ScreenSession; children?: React.ReactNode }) {
  const ms = useRemainingMs(state, session);
  const total = (session.requested_minutes + session.extended_minutes) * 60_000;
  const left = Math.max(0, ms ?? 0);
  const pct = total > 0 ? Math.min(100, Math.round((left / total) * 100)) : 0;
  const soon = ms != null && ms <= 5 * 60_000;
  return (
    <section aria-label="Temporizador de pantalla" className="card p-5 text-center" data-testid="screen-timer">
      <p className="flex items-center justify-center gap-1.5 text-sm font-bold muted"><Timer size={16} aria-hidden /> Pantalla en marcha{session.note ? ` · ${session.note}` : ''}</p>
      <p role="timer" aria-live="off" data-testid="countdown" className={`num mt-1 text-[4rem] leading-none font-extrabold ${soon ? 'text-berry-deep dark:text-[#ff9dbf]' : ''}`}>{clock(left)}</p>
      <div className="mx-auto mt-3 h-2.5 max-w-xs overflow-hidden rounded-full bg-[var(--chip)]" aria-hidden>
        <div className={`h-full rounded-full transition-[width] duration-500 ${soon ? 'bg-berry' : 'bg-sky'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-sm muted">
        {session.planned_end_at ? `Termina a las ${fmtTime(session.planned_end_at, state.timezone)}` : ''} · de {session.requested_minutes + session.extended_minutes} min
        {session.started_by_name && session.started_by !== session.user_id ? ` · lo encendió ${session.started_by_name}` : ''}
      </p>
      {children}
    </section>
  );
}

const END_TEXT: Record<string, string> = { stopped: 'Parada', expired: 'Se acabó el tiempo', charge: 'Minutos dados', blocked: 'Parada por un descanso' };

function sessionTitle(s: ScreenSession) {
  const cat = s.category ? ` · ${categoryInfo(s.category)?.emoji ?? ''} ${categoryInfo(s.category)?.label ?? ''}` : '';
  if (s.kind === 'charge') return `${s.extra && s.started_by === s.user_id ? 'Tiempo extra' : 'Minutos dados'}: ${s.requested_minutes} min${s.note ? ` (${s.note})` : ''}`;
  return `${s.status === 'finished' ? s.used_minutes : s.requested_minutes} min de pantalla${s.note ? ` (${s.note})` : ''}${cat}`;
}

function sessionDetail(s: ScreenSession, tz: string) {
  const who = s.kind === 'charge' ? (s.started_by === s.user_id ? `Pedido por ${s.display_name ?? 'el hijo'}, aprobado por ${s.stopped_by_name ?? 'un adulto'}` : `Lo dio ${s.started_by_name ?? 'un adulto'}`) : `Lo encendió ${s.started_by_name ?? '—'}`;
  const parts = [fmtDateTime(s.started_at ?? s.created_at), who];
  if (s.kind === 'timer' && s.status === 'finished') {
    parts.push(`${END_TEXT[s.end_reason ?? 'stopped']}${s.end_reason === 'stopped' && s.stopped_by_name ? `: ${s.stopped_by_name}` : ''}`);
    if (s.ended_at) parts.push(`hasta las ${fmtTime(s.ended_at, tz)}`);
  }
  if (s.paid_points) parts.push(`pagado con ${s.paid_points} puntos`);
  if (s.paid_cents) parts.push(`pagado con ${euros(s.paid_cents)}`);
  if (s.shortfall_minutes > 0 && !s.paid_points && !s.paid_cents) parts.push(`${s.shortfall_minutes} min a la semana siguiente`);
  if (s.overrun_minutes) parts.push(`se pasó ${s.overrun_minutes} min`);
  return parts.join(' · ');
}

/** Historial de sesiones: quién las encendió, cuánto duraron y cómo se pagaron. Lo ven padres e hijo. */
export function SessionsHistory({ userId, timezone }: { userId: string; timezone: string }) {
  const q = useQuery({ queryKey: ['screen-sessions', userId], queryFn: () => api<{ sessions: ScreenSession[] }>(`/screen/${userId}/sessions`), refetchInterval: 30_000 });
  const rows = q.data?.sessions ?? [];
  if (q.isLoading) return null;
  if (!rows.length) return <Empty icon={<History />} title="Todavía no hay sesiones">Aquí quedará cada vez que se use la pantalla.</Empty>;
  return (
    <ul className="space-y-2.5" aria-label="Historial de sesiones de pantalla">
      {rows.map((s) => (
        <li key={s.id} className="card flex items-start gap-3 p-3.5">
          <span aria-hidden className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-[var(--chip)]">{s.kind === 'charge' ? <Sparkles size={17} /> : <Timer size={17} />}</span>
          <div className="min-w-0 flex-1">
            <p className="font-bold">{sessionTitle(s)}</p>
            <p className="text-sm muted">{sessionDetail(s, timezone)}</p>
          </div>
          {s.status === 'pending' ? <Badge tone="sun">Esperando</Badge> : s.status === 'running' ? <Badge tone="sky">En marcha</Badge> : s.status === 'rejected' ? <Badge tone="berry">Rechazada</Badge> : null}
        </li>
      ))}
    </ul>
  );
}

/** Cuánto se puede usar hoy según el plan: días permitidos y tope. */
export function TodayLine({ state }: { state: ScreenState }) {
  const t = state.today;
  if (!t.allowed) return <p className="flex items-start gap-2 text-sm font-bold text-berry-deep dark:text-[#ff9dbf]"><Lock size={16} className="mt-0.5 shrink-0" aria-hidden /> Hoy no toca pantalla según el plan.</p>;
  if (t.cap == null) return <p className="flex items-center gap-2 text-sm muted"><Clock size={16} aria-hidden /> Hoy no hay tope diario.</p>;
  return <p className="flex items-center gap-2 text-sm muted"><Clock size={16} aria-hidden /> Hoy: tope de {minutesHM(t.cap)} · llevas {minutesHM(t.used)}{t.cap_left != null ? ` · te quedan ${minutesHM(t.cap_left)}` : ''}</p>;
}

export function StopButton({ onClick, loading, label = 'Parar' }: { onClick: () => void; loading?: boolean; label?: string }) {
  return <Button size="lg" variant="danger" className="mt-4 w-full" loading={loading} onClick={onClick}>{label}</Button>;
}

/** Petición de pantalla o de tiempo extra esperando a un adulto: se aprueba o se rechaza en un toque. */
export function PendingSessionCard({ s, balance, rates, showName = true }: { s: ScreenSession; balance: number; rates: { pointsPer15: number; centsPer15: number }; showName?: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const act = useMutation({
    mutationFn: (a: 'approve' | 'reject') => post(`/screen/sessions/${s.id}/${a}`),
    onSuccess: (_r, a) => { toast(a === 'approve' ? (s.kind === 'charge' ? 'Aprobado: minutos descontados' : 'Aprobado: temporizador en marcha') : 'Rechazado'); invalidate(); },
    onError: (e: Error) => { toast(e.message, 'error'); invalidate(); },
  });
  const name = s.display_name ?? 'El hijo';
  const short = s.kind === 'charge' ? Math.max(0, s.requested_minutes - balance) : 0;
  const pay = short > 0 ? (s.shortfall_mode === 'points' ? `${Math.ceil((short * rates.pointsPer15) / 15)} puntos` : s.shortfall_mode === 'money' ? euros(Math.ceil((short * rates.centsPer15) / 15)) : 'la semana siguiente') : '';
  return (
    <li className="card space-y-3 p-4" data-testid="pending-screen">
      <div className="flex items-start gap-3">
        {s.display_name ? <Avatar name={s.display_name} avatar={s.avatar} colorKey={s.color} size={40} /> : null}
        <div className="min-w-0 flex-1">
          <p className="font-bold">{showName ? `${name} pide ` : 'Pide '}{s.kind === 'charge' ? `${s.requested_minutes} min de tiempo extra` : `usar ${s.requested_minutes} min de pantalla`}{s.note ? ` (${s.note})` : ''}</p>
          <p className="text-sm muted">
            {s.kind === 'charge'
              ? `Se descuenta al aprobar. Le quedan ${minutesHM(balance)}${short > 0 ? ` · le faltan ${short} min: ${s.shortfall_mode === 'debt' ? '' : 'los paga con '}${pay}` : ''}.`
              : 'El temporizador empieza al aprobarlo.'}
          </p>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="flex-1" disabled={act.isPending} onClick={() => act.mutate('reject')} aria-label={`Rechazar la petición de ${name}`}>Rechazar</Button>
        <Button variant="success" size="sm" className="flex-1" disabled={act.isPending} onClick={() => act.mutate('approve')} aria-label={`Aprobar la petición de ${name}`}>Aprobar</Button>
      </div>
    </li>
  );
}

/** Reto cumplido por el hijo, esperando que un adulto lo valide (con su foto, si la hay). */
export function ChallengeReviewCard({ b, showName = true }: { b: { id: string; display_name?: string; avatar?: string | null; color?: string | null; challenge_text: string; challenge_effect: string; challenge_days: number | null; challenge_note: string; has_photo: boolean; reason: string }; showName?: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [note, setNote] = useState('');
  const act = useMutation({
    mutationFn: (approve: boolean) => post(`/screen/blocks/${b.id}/challenge/review`, { approve, note: approve ? undefined : note || undefined }),
    onSuccess: (r) => { toast(r.result === 'lifted' ? 'Reto validado: descanso terminado' : r.result === 'shortened' ? 'Reto validado: descanso acortado' : 'Le pides repetirlo'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <li className="card space-y-3 p-4" data-testid="pending-challenge">
      <div className="flex items-start gap-3">
        {b.display_name ? <Avatar name={b.display_name} avatar={b.avatar} colorKey={b.color} size={40} /> : null}
        <div className="min-w-0 flex-1">
          <p className="font-bold">{showName && b.display_name ? `${b.display_name} dice que ha cumplido su reto` : 'Reto cumplido'}</p>
          <p className="text-sm">«{b.challenge_text}»</p>
          <p className="text-sm muted">Descanso: {b.reason} · {b.challenge_effect === 'lift' ? 'al validarlo termina' : `al validarlo se acorta ${b.challenge_days} ${b.challenge_days === 1 ? 'día' : 'días'}`}.{b.challenge_note ? ` Dice: «${b.challenge_note}»` : ''}</p>
        </div>
      </div>
      {b.has_photo ? <img src={`/api/screen/blocks/${b.id}/photo`} alt="Foto del reto cumplido" className="max-h-60 w-full rounded-2xl object-cover" /> : null}
      <Field label="Si hay que repetirlo, dile qué falta (opcional)">{(id) => <input id={id} className="field" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}</Field>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" className="flex-1" disabled={act.isPending} onClick={() => act.mutate(false)}>Repetir</Button>
        <Button variant="success" size="sm" className="flex-1" disabled={act.isPending} onClick={() => act.mutate(true)}>Validar</Button>
      </div>
    </li>
  );
}
