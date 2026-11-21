import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, CircleCheckBig, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { addDays, fmtDate, relative } from '../lib/format';
import { useDecideRedemption, useInvalidateAll } from '../lib/hooks';
import type { BonusGrant, Instance, Redemption, ScreenLog } from '../lib/types';
import { screenPhrase } from '../lib/screen';
import { Avatar, Badge, Button, Empty, Loading, PageHeader, PointsPill, SectionTitle, useToast } from '../components/ui';
import { ApprovalCard } from '../components/ApprovalCard';
import { BankApprovals } from '../components/BankApprovals';

/** Tareas que marca un adulto: dos botones, y se puede corregir después. */
function CheckTasks({ today }: { today: string }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const list = useQuery({
    queryKey: ['instances', 'checks', today],
    queryFn: () => api<{ instances: Instance[] }>(`/instances?from=${addDays(today, -6)}&to=${today}`),
  });
  const mark = useMutation({
    mutationFn: (v: { id: string; met: boolean }) => post(`/instances/${v.id}/check`, { met: v.met }),
    onSuccess: (r) => {
      toast(r.duplicate ? 'Ya estaba marcada así' : r.met ? 'Marcada como cumplida' : r.penaltyApplied ? `No cumplida: −${r.penaltyApplied} min de pantalla` : 'No cumplida');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  // Hoy se muestran todas (para poder corregir); de días anteriores, solo las que quedaron sin marcar.
  const items = (list.data?.instances ?? []).filter((i) => i.check_mode && (i.due_date === today || i.check_met === null));
  if (!items.length) return null;
  return (
    <section className="mb-8">
      <SectionTitle>Para comprobar</SectionTitle>
      <ul className="space-y-3">
        {items.map((i) => (
          <li key={i.id} className="card p-3.5">
            <div className="flex items-center gap-3">
              <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-[var(--chip)] text-2xl">{i.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">{i.title}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-sm muted">
                  {i.assignee_name && <Avatar name={i.assignee_name} avatar={i.assignee_avatar} colorKey={i.assignee_color} size={18} />}
                  {i.assignee_name}{i.due_date !== today ? ` · ${fmtDate(i.due_date, { weekday: 'long', day: 'numeric' })}` : ''}
                  {i.check_met === true ? <Badge tone="leaf">Cumplida</Badge> : i.check_met === false ? <Badge tone="berry">No cumplida</Badge> : null}
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant={i.check_met === false ? 'danger' : 'secondary'} className="flex-1" size="sm" disabled={mark.isPending} onClick={() => mark.mutate({ id: i.id, met: false })}
                aria-label={`No cumplida: «${i.title}» de ${i.assignee_name}`}>
                <X size={16} /> No cumplida{i.penalty_minutes ? ` (−${i.penalty_minutes} min)` : ''}
              </Button>
              <Button variant="success" className="flex-1" size="sm" disabled={mark.isPending} onClick={() => mark.mutate({ id: i.id, met: true })}
                aria-label={`Cumplida: «${i.title}» de ${i.assignee_name}`}>
                <Check size={16} /> Cumplida
              </Button>
            </div>
            {i.check_met === null && (i.points > 0 || i.success_minutes > 0) ? (
              <p className="mt-2 text-sm muted">Si se cumple: {[i.points > 0 ? `+${i.points} puntos` : '', i.success_minutes ? `+${i.success_minutes} min de pantalla` : ''].filter(Boolean).join(' · ')}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Bonos de texto o recompensa que un adulto tiene que cumplir a mano. */
function PendingGrants() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const list = useQuery({ queryKey: ['bonus-grants', 'pending'], queryFn: () => api<{ grants: BonusGrant[] }>('/bonus-grants') });
  const fulfill = useMutation({
    mutationFn: (id: string) => post(`/bonus-grants/${id}/fulfill`),
    onSuccess: () => { toast('Marcado como cumplido'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const grants = list.data?.grants ?? [];
  if (!grants.length) return null;
  return (
    <section className="mb-8">
      <SectionTitle>Premios por cumplir</SectionTitle>
      <ul className="space-y-3">
        {grants.map((g) => (
          <li key={g.id} className="card flex flex-wrap items-center gap-3 p-3.5">
            <Avatar name={g.display_name} avatar={g.avatar} colorKey={g.color} size={40} />
            <div className="min-w-0 flex-1">
              <p className="font-bold">{g.surprise ? '🎁 ' : ''}{g.label}</p>
              <p className="text-sm muted">{g.display_name} · por «{g.task_title}» · pendiente de cumplir</p>
            </div>
            <Button size="sm" variant="success" disabled={fulfill.isPending} onClick={() => fulfill.mutate(g.id)}><Check size={16} /> Cumplido</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Pantalla que el hijo ha anotado: ya está restada; el adulto la confirma (con puntos de honestidad) o la anula. */
function UsageLogs() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const list = useQuery({ queryKey: ['screen-logs', 'pending'], queryFn: () => api<{ logs: ScreenLog[] }>('/screen-logs?status=pending') });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'confirm' | 'void' }) => post(`/screen-logs/${v.id}/${v.action}`),
    onSuccess: (r, v) => {
      toast(v.action === 'void' ? (r.refunded ? `Anulada: devueltos ${r.refunded} min` : 'Anulada') : r.honesty ? 'Confirmada: +5 puntos por ser honesto' : 'Confirmada');
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const logs = list.data?.logs ?? [];
  if (!logs.length) return null;
  return (
    <section className="mb-8">
      <SectionTitle>Pantalla anotada</SectionTitle>
      <ul className="space-y-3">
        {logs.map((l) => (
          <li key={l.id} className="card p-3.5">
            <div className="flex items-center gap-3">
              <Avatar name={l.display_name} avatar={l.avatar} colorKey={l.color} size={40} />
              <div className="min-w-0 flex-1">
                <p className="font-bold">{l.display_name} anotó {screenPhrase(l.minutes, l.category)}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-sm muted">
                  {fmtDate(l.day, { weekday: 'long', day: 'numeric' })}{l.note ? ` · «${l.note}»` : ''}
                  {l.overflow_minutes > 0 ? <Badge tone="berry">Se pasó {l.overflow_minutes} min</Badge> : null}
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" size="sm" className="flex-1" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'void' })} aria-label={`Anular la pantalla de ${l.display_name}`}><X size={16} /> Anular</Button>
              <Button variant="success" size="sm" className="flex-1" disabled={act.isPending} onClick={() => act.mutate({ id: l.id, action: 'confirm' })} aria-label={`Confirmar la pantalla de ${l.display_name}`}><Check size={16} /> Confirmar</Button>
            </div>
            {l.overflow_minutes > 0 ? <p className="mt-2 text-sm muted">Tenía menos minutos de los que anotó: hoy no gana puntos de honestidad.</p> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Approvals() {
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/dashboard') });
  const reds = useQuery({ queryKey: ['redemptions', 'requested'], queryFn: () => api<{ redemptions: Redemption[] }>('/redemptions?status=requested') });
  const decide = useDecideRedemption();
  if (isLoading || !data) return <Loading />;
  const list = data.pendingApprovals;
  const requested = reds.data?.redemptions ?? [];

  return (
    <div className="max-w-3xl">
      <PageHeader title="Validar" subtitle="Revisa lo que han hecho. Puedes ajustar los puntos antes de aprobar." />
      <CheckTasks today={data.today} />
      <BankApprovals heading={() => <SectionTitle>Dinero y pantalla</SectionTitle>} />
      <UsageLogs />
      <PendingGrants />
      <section className="mb-8">
        <SectionTitle>Tareas terminadas</SectionTitle>
        {list.length ? (
          <ul className="space-y-3">{list.map((p: any) => <ApprovalCard key={p.id} p={p} />)}</ul>
        ) : (
          <div className="card"><Empty mascot icon={<CircleCheckBig />} title="Nada por validar">Cuando marquen una tarea, aparecerá aquí.</Empty></div>
        )}
      </section>
      {requested.length ? (
        <section>
          <SectionTitle>Recompensas pedidas</SectionTitle>
          <ul className="space-y-3">
            {requested.map((r) => (
              <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3.5">
                <Avatar name={r.display_name} avatar={r.avatar} colorKey={r.color} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{r.reward_title}</p>
                  <p className="text-sm muted">{r.display_name} · {relative(r.requested_at)}</p>
                </div>
                <PointsPill points={r.cost_points} sign={false} />
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}>Rechazar</Button>
                  <Button size="sm" variant="success" onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>Aprobar</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
