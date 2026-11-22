import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, Lock, PauseCircle, Plus, Sparkles, Timer, Unlock } from 'lucide-react';
import { api, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { useScreenState } from '../lib/screen-state';
import { minutesHM } from '../lib/deadline';
import type { ScreenBlock, ScreenPlanRow, ScreenSession, User } from '../lib/types';
import { Avatar, Badge, Button, Disclosure, Loading, PageHeader, SectionTitle, useToast } from '../components/ui';
import { Countdown, PendingSessionCard, ScreenBatteries, SessionsHistory, StopButton, TodayLine } from '../components/ScreenParts';
import { BlockSheet, GiveMinutesSheet, ManualMinutesSheet, TimerSheet } from '../components/ScreenSheets';
import { ScreenAdjustSheet } from '../components/ScreenAdjustSheet';
import { PlanRow } from '../components/ScreenSettings';
import { ScreenList } from '../components/Ledger';

function BlockRow({ b, child }: { b: ScreenBlock; child: User }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const lift = useMutation({
    mutationFn: () => post(`/screen/blocks/${b.id}/lift`),
    onSuccess: () => { toast(`Descanso terminado para ${child.display_name}`); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const c = b.challenge;
  return (
    <li className="card space-y-2 p-4">
      <p className="flex items-start gap-2 font-bold"><Lock size={17} className="mt-0.5 shrink-0 text-berry" aria-hidden /> {b.label}</p>
      <p className="text-sm muted">Motivo: {b.reason}{b.blocked_now ? ' · en descanso ahora' : ''}</p>
      {c ? (
        <p className="text-sm">
          Reto: «{c.text}» · {c.effect === 'lift' ? 'termina el descanso' : `acorta ${c.days} ${c.days === 1 ? 'día' : 'días'}`}{c.photo_required ? ' · con foto' : ''}{' '}
          {c.status === 'submitted' ? <Badge tone="sun">Por validar</Badge> : c.status === 'rejected' ? <Badge tone="berry">Repetir</Badge> : c.status === 'approved' ? <Badge tone="leaf">Cumplido</Badge> : <Badge>Pendiente</Badge>}
        </p>
      ) : null}
      {b.state === 'active' ? <Button size="sm" variant="secondary" loading={lift.isPending} onClick={() => lift.mutate()} aria-label={`Terminar ya el descanso: ${b.reason}`}><Unlock size={16} aria-hidden /> Terminar ya</Button> : <Badge>{b.state === 'lifted' ? 'Terminado antes' : 'Terminado'}</Badge>}
    </li>
  );
}

function KidScreen({ child }: { child: User }) {
  const q = useScreenState(child.id);
  const plans = useQuery({ queryKey: ['screen-plans'], queryFn: () => api<{ plans: ScreenPlanRow[] }>('/screen/plans') });
  const [sheet, setSheet] = useState<'give' | 'timer' | 'block' | 'adjust' | 'manual' | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'stop' | 'extend'; minutes?: number }) => post(`/screen/sessions/${v.id}/${v.action}`, v.minutes ? { minutes: v.minutes } : {}),
    onSuccess: (r, v) => { toast(v.action === 'stop' ? `Parado. Ha usado ${r.session.used_minutes} min` : `+${v.minutes} min más`); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const endPause = useMutation({
    mutationFn: async () => { const v = await api<{ pauses: { id: string; status: string }[] }>(`/screen/${child.id}`); const p = v.pauses.find((x) => x.status === 'active'); if (p) await post(`/screen/adjustments/${p.id}/end`); },
    onSuccess: () => { toast('Pausa terminada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const s = q.data;
  const row = plans.data?.plans.find((p) => p.user_id === child.id);
  if (!s) return <Loading />;
  const running = s.session?.status === 'running' ? s.session : null;
  const waitingTimer: ScreenSession | null = s.session?.status === 'pending' ? { ...s.session, display_name: child.display_name, avatar: child.avatar, color: child.color } : null;
  const blocks = s.blocks;
  return (
    <div className="space-y-5" data-testid={`screen-of-${child.display_name}`}>
      <div className="flex items-center gap-3">
        <Avatar name={child.display_name} avatar={child.avatar} colorKey={child.color} size={48} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-xl font-extrabold">{child.display_name}</h2>
          <p className="text-sm muted">Le quedan <b className="num text-[var(--fg)]">{minutesHM(s.balance)}</b></p>
        </div>
      </div>

      {running ? (
        <Countdown state={s} session={running}>
          <div className="mt-4 flex flex-wrap justify-center gap-2" role="group" aria-label="Ampliar el temporizador">
            {[5, 10, 15].map((m) => <Button key={m} size="sm" variant="secondary" disabled={act.isPending} onClick={() => act.mutate({ id: running.id, action: 'extend', minutes: m })}>+{m} min</Button>)}
          </div>
          <StopButton loading={act.isPending} onClick={() => act.mutate({ id: running.id, action: 'stop' })} label={`Parar el temporizador de ${child.display_name}`} />
        </Countdown>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Button size="lg" className="h-auto min-h-14 min-w-0 flex-col gap-0.5 px-2 py-2 text-center leading-tight !whitespace-normal" onClick={() => setSheet('timer')} disabled={!!waitingTimer}>
            <span className="flex items-center justify-center gap-1.5"><Timer size={19} className="shrink-0" aria-hidden /> Encender temporizador</span>
            <span className="text-xs font-semibold opacity-80">Cuenta atrás; cobra lo usado</span>
          </Button>
          <Button size="lg" variant="secondary" className="h-auto min-h-14 min-w-0 flex-col gap-0.5 px-2 py-2 text-center leading-tight !whitespace-normal" onClick={() => setSheet('give')}>
            <span className="flex items-center justify-center gap-1.5"><Sparkles size={19} className="shrink-0" aria-hidden /> Dar minutos</span>
            <span className="text-xs font-semibold opacity-80">Se descuentan ya, sin temporizador</span>
          </Button>
        </div>
      )}
      {!running && !s.can_start && s.reason_code === 'blocked' ? <p role="status" className="text-sm font-bold text-berry-deep dark:text-[#ff9dbf]">{s.reason}</p> : null}

      {waitingTimer || s.pending_extra ? (
        <ul className="space-y-3" aria-label="Peticiones de pantalla">
          {waitingTimer ? <PendingSessionCard s={waitingTimer} balance={s.balance} rates={s.rates} showName={false} /> : null}
          {s.pending_extra ? <PendingSessionCard s={{ ...s.pending_extra, display_name: child.display_name, avatar: child.avatar, color: child.color }} balance={s.balance} rates={s.rates} showName={false} /> : null}
        </ul>
      ) : null}

      <ScreenBatteries state={s} />
      <TodayLine state={s} />
      {s.debt_minutes > 0 ? <p className="text-sm font-bold text-berry-deep dark:text-[#ff9dbf]">Se pasó de tiempo: {s.debt_minutes} min se descuentan de la semana que viene.</p> : null}
      {s.pause ? (
        <p className="flex flex-wrap items-center gap-2 rounded-2xl bg-sun-soft px-3.5 py-2 text-sm font-bold text-sun-ink dark:bg-sun/15 dark:text-[#ffd979]">
          <PauseCircle size={16} aria-hidden /> <span className="min-w-0 flex-1">{s.pause.label}</span>
          <Button size="sm" variant="secondary" loading={endPause.isPending} onClick={() => endPause.mutate()}>Terminar pausa</Button>
        </p>
      ) : null}

      <section aria-label="Plan semanal">
        <SectionTitle>Plan semanal y días</SectionTitle>
        {row ? <ul><PlanRow key={`${row.minutes_per_week}-${row.enabled}-${(row.allowed_days ?? []).join('')}-${JSON.stringify(row.day_max)}-${row.require_approval}`} row={row} compact /></ul> : null}
      </section>

      <section aria-label="Descansos de pantalla">
        <SectionTitle action={<Button size="sm" variant="secondary" onClick={() => setSheet('block')}><Lock size={16} aria-hidden /> Programar descanso</Button>}>Descansos de pantalla</SectionTitle>
        {blocks.length ? <ul className="space-y-3">{blocks.map((b) => <BlockRow key={b.id} b={b} child={child} />)}</ul> : <p className="muted">Sin descansos programados. Puedes reservar días enteros o una franja sin pantalla, con un reto opcional para terminarlo antes.</p>}
      </section>

      <section aria-label="Ajustes manuales">
        <SectionTitle>Ajustes manuales</SectionTitle>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={() => setSheet('adjust')}><Sparkles size={16} aria-hidden /> Ajuste de pantalla</Button>
          <Button size="sm" variant="secondary" onClick={() => setSheet('manual')}><Plus size={16} aria-hidden /> Regalar o quitar minutos</Button>
        </div>
      </section>

      <section aria-label="Historial de sesiones">
        <SectionTitle>Historial de sesiones</SectionTitle>
        <SessionsHistory userId={child.id} timezone={s.timezone} />
      </section>
      <Disclosure title="Todos los movimientos de minutos"><ScreenList userId={child.id} /></Disclosure>

      {sheet === 'give' ? <GiveMinutesSheet child={child} onClose={() => setSheet(null)} /> : null}
      {sheet === 'timer' ? <TimerSheet child={child} onClose={() => setSheet(null)} /> : null}
      {sheet === 'block' ? <BlockSheet child={child} onClose={() => setSheet(null)} /> : null}
      {sheet === 'adjust' ? <ScreenAdjustSheet child={child} onClose={() => setSheet(null)} /> : null}
      {sheet === 'manual' ? <ManualMinutesSheet child={child} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}

/** «Pantalla» de los padres: una sola pantalla por hijo con el plan, las dos baterías, el temporizador, las peticiones, los castigos y el historial. */
export default function ScreenAdult() {
  const fam = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const [params, setParams] = useSearchParams();
  if (fam.isLoading) return <Loading />;
  const kids = (fam.data?.members ?? []).filter((m) => m.role === 'child' && m.active);
  const child = kids.find((k) => k.id === params.get('hijo')) ?? kids[0];
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Pantalla" subtitle="Tiempo, temporizador y descansos de cada hijo" action={<Link to="/ajustes" className="inline-flex min-h-11 items-center gap-1 text-sm font-bold text-tangerine-deep underline underline-offset-4">Ajustes de pantalla <ArrowRight size={14} aria-hidden /></Link>} />
      {!child ? <p className="muted">Todavía no hay hijos.</p> : (
        <>
          {kids.length > 1 ? (
            <div role="tablist" aria-label="Hijos" className="mb-5 flex gap-2 overflow-x-auto pb-1">
              {kids.map((k) => (
                <button key={k.id} type="button" role="tab" aria-selected={k.id === child.id} onClick={() => setParams({ hijo: k.id }, { replace: true })}
                  className={`flex h-12 shrink-0 items-center gap-2 rounded-full border px-3.5 font-bold ${k.id === child.id ? 'border-sky bg-sky/15' : 'border-[var(--line)] bg-[var(--chip)] text-[var(--fg-3)]'}`}>
                  <Avatar name={k.display_name} avatar={k.avatar} colorKey={k.color} size={28} /> {k.display_name}
                </button>
              ))}
            </div>
          ) : null}
          <KidScreen key={child.id} child={child} />
        </>
      )}
    </div>
  );
}
