import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { AlarmClock, Hourglass, Lock, MonitorPlay, Plus, ShieldAlert } from 'lucide-react';
import { post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { useScreenState } from '../lib/screen-state';
import { minutesHM } from '../lib/deadline';
import { Badge, Button, Disclosure, Loading, PageHeader, SectionTitle, useToast } from '../components/ui';
import { Countdown, ScreenBatteries, SessionsHistory, StopButton, TodayLine } from '../components/ScreenParts';
import { ChallengeDoneSheet, ExtraSheet, UseScreenSheet } from '../components/ScreenSheets';
import { ScreenList } from '../components/Ledger';
import { expiryPhrase } from '../components/ScreenPanel';
import type { ScreenBlock } from '../lib/types';

/** Un castigo visible para el hijo: qué, por qué, hasta cuándo y, si lo hay, su reto. */
function BlockCard({ b, onDone }: { b: ScreenBlock; onDone: (b: ScreenBlock) => void }) {
  const c = b.challenge;
  return (
    <li className="card space-y-2 border-berry/40 p-4">
      <p className="flex items-start gap-2 font-bold text-berry-deep dark:text-[#ff9dbf]"><Lock size={18} className="mt-0.5 shrink-0" aria-hidden /> {b.label}</p>
      <p className="text-sm">Motivo: {b.reason}</p>
      {c ? (
        <div className="rounded-2xl bg-[var(--chip)] p-3 text-sm">
          <p className="font-bold">Reto: {c.text}</p>
          <p className="muted">{c.effect === 'lift' ? 'Si lo cumples, el descanso termina.' : `Si lo cumples, el descanso se acorta ${c.days} ${c.days === 1 ? 'día' : 'días'}.`}{c.photo_required ? ' Hay que mandar una foto.' : ''}</p>
          {c.status === 'submitted' ? <p className="mt-2"><Badge tone="sun">Esperando a que un adulto lo valide</Badge></p> : null}
          {c.status === 'rejected' ? <p className="mt-2 font-bold text-berry-deep dark:text-[#ff9dbf]">Hay que repetirlo{c.note ? `: «${c.note}»` : ''}</p> : null}
          {c.status === 'open' || c.status === 'rejected' ? <Button size="sm" className="mt-2" onClick={() => onDone(b)}>Ya lo he hecho</Button> : null}
        </div>
      ) : null}
    </li>
  );
}

/** «Mi pantalla»: dos baterías, un solo botón para usar la pantalla y todo lo que la limita, a la vista. */
export default function ChildScreen() {
  const { user } = useSession();
  const q = useScreenState(user.id);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [sheet, setSheet] = useState<'use' | 'extra' | null>(null);
  const [challenge, setChallenge] = useState<ScreenBlock | null>(null);
  const stop = useMutation({
    mutationFn: (id: string) => post(`/screen/sessions/${id}/stop`),
    onSuccess: (r) => { toast(r.session.used_minutes ? `Parado. Has usado ${r.session.used_minutes} min` : 'Parado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/screen/sessions/${id}/cancel`),
    onSuccess: () => { toast('Petición cancelada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const s = q.data;
  if (q.isLoading || !s) return <Loading />;
  const running = s.session?.status === 'running' ? s.session : null;
  const waiting = s.session?.status === 'pending' ? s.session : null;
  const blocks = s.blocks.filter((b) => b.state === 'active');

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <PageHeader title="Mi pantalla" subtitle="Tu tiempo libre de la semana y el que ganas con tareas" />

      {s.expiring ? (
        <p role="status" data-testid="expiring-warning" className="flex items-start gap-2 rounded-2xl bg-sun-soft p-3 text-sm font-bold text-sun-ink dark:bg-sun/15 dark:text-[#ffd979]">
          <Hourglass size={18} className="mt-0.5 shrink-0" aria-hidden /> {expiryPhrase(s.expiring.expires_at, s.timezone, true).replace(/^el /, 'El ')} caducan {s.expiring.minutes} min: úsalos.
        </p>
      ) : null}
      {s.debt_minutes > 0 ? (
        <p role="status" className="flex items-start gap-2 rounded-2xl bg-berry-soft p-3 text-sm font-bold text-berry-deep dark:bg-berry/20 dark:text-[#ff9dbf]">
          <ShieldAlert size={18} className="mt-0.5 shrink-0" aria-hidden /> Te pasaste de tiempo: {s.debt_minutes} min se descuentan de la semana que viene.
        </p>
      ) : null}

      {running ? (
        <Countdown state={s} session={running}>
          <StopButton loading={stop.isPending} onClick={() => stop.mutate(running.id)} label="Parar pantalla" />
          <p className="mt-2 text-xs muted">Al parar, solo se descuenta lo que has usado.</p>
        </Countdown>
      ) : waiting ? (
        <section className="card p-5 text-center" aria-label="Petición en espera">
          <AlarmClock size={30} className="mx-auto text-sun-ink dark:text-sun" aria-hidden />
          <p className="mt-2 text-lg font-extrabold">Esperando a un adulto</p>
          <p className="muted">Has pedido {minutesHM(waiting.requested_minutes)} de pantalla. Empezarán cuando lo aprueben.</p>
          <Button variant="ghost" className="mt-2" loading={cancel.isPending} onClick={() => cancel.mutate(waiting.id)}>Cancelar petición</Button>
        </section>
      ) : (
        <section className="card p-5" aria-label="Usar pantalla">
          <Button size="lg" className="w-full" disabled={!s.can_start} onClick={() => setSheet('use')}><MonitorPlay size={22} aria-hidden /> Usar pantalla</Button>
          {!s.can_start && s.reason ? <p role="status" data-testid="start-reason" className="mt-3 text-center text-sm font-bold text-berry-deep dark:text-[#ff9dbf]">{s.reason}</p> : null}
          {s.can_start ? <p className="mt-3 text-center text-sm muted">Puedes usar hasta {minutesHM(s.max_minutes)} ahora.</p> : null}
        </section>
      )}

      <ScreenBatteries state={s} />
      <TodayLine state={s} />
      {s.pause ? <p className="text-sm font-bold text-sun-ink dark:text-[#ffd979]">{s.pause.label}. Tus minutos no caducan mientras tanto.</p> : null}

      {s.pending_extra ? (
        <section className="card flex flex-wrap items-center gap-3 p-4" aria-label="Tiempo extra pedido">
          <div className="min-w-0 flex-1"><p className="font-bold">Tiempo extra: {minutesHM(s.pending_extra.requested_minutes)}{s.pending_extra.note ? ` (${s.pending_extra.note})` : ''}</p><p className="text-sm muted">Esperando a que un adulto lo apruebe</p></div>
          <Button size="sm" variant="ghost" loading={cancel.isPending} onClick={() => cancel.mutate(s.pending_extra!.id)}>Cancelar</Button>
        </section>
      ) : !s.pause && !s.blocks.some((b) => b.blocked_now) ? (
        <Button variant="secondary" className="w-full" onClick={() => setSheet('extra')}><Plus size={18} aria-hidden /> Pedir tiempo extra</Button>
      ) : null}

      {blocks.length ? (
        <section aria-label="Descansos de pantalla">
          <SectionTitle>Descansos de pantalla</SectionTitle>
          <ul className="space-y-3">{blocks.map((b) => <BlockCard key={b.id} b={b} onDone={setChallenge} />)}</ul>
        </section>
      ) : null}

      <section>
        <SectionTitle>Mis sesiones</SectionTitle>
        <SessionsHistory userId={user.id} timezone={s.timezone} />
      </section>
      <Disclosure title="Todos mis movimientos de minutos"><ScreenList userId={user.id} /></Disclosure>

      {sheet === 'use' ? <UseScreenSheet state={s} userId={user.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'extra' ? <ExtraSheet state={s} onClose={() => setSheet(null)} /> : null}
      {challenge?.challenge ? <ChallengeDoneSheet blockId={challenge.id} text={challenge.challenge.text} photoRequired={challenge.challenge.photo_required} onClose={() => setChallenge(null)} /> : null}
    </div>
  );
}
