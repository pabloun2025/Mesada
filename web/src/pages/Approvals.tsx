import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Check, CircleCheckBig, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { addDays, euros, fmtDate, parseEuros, relative } from '../lib/format';
import { useDecideRedemption, useInvalidateAll } from '../lib/hooks';
import type { BonusGrant, GoalRequest, Instance, Loan, PayMethod, PayoutRequest, Redemption, ScreenLog, Wallet } from '../lib/types';
import { screenPhrase } from '../lib/screen';
import { MethodPicker } from '../components/MoneySheets';
import { Avatar, Badge, Button, Empty, Field, Loading, PageHeader, PointsPill, SectionTitle, Sheet, useToast } from '../components/ui';
import { ApprovalCard } from '../components/ApprovalCard';

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

/** Aprobar o rechazar una petición del hijo: dinero pide forma de pago; ambas admiten una nota. */
function DecideSheet({ req, mode, onClose }: { req: PayoutRequest; mode: 'approve' | 'reject'; onClose: () => void }) {
  const [method, setMethod] = useState<PayMethod>('cash');
  const [note, setNote] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const wallet = useQuery({ queryKey: ['wallet', req.user_id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${req.user_id}`) });
  const w = wallet.data?.wallet;
  const what = req.kind === 'money' ? euros(req.amount_cents!) : screenPhrase(req.minutes!, req.category);
  const left = req.kind === 'money' ? w?.cents_pending : w?.screen_minutes;
  const asked = req.kind === 'money' ? req.amount_cents! : req.minutes!;
  const reduced = left != null && left < asked;
  const decide = useMutation({
    mutationFn: () => post(`/payout-requests/${req.id}/${mode}`, { method: mode === 'approve' && req.kind === 'money' ? method : undefined, note: note || undefined }),
    onSuccess: (r) => {
      toast(mode === 'reject' ? 'Petición rechazada' : r.reduced ? `Aprobada por menos: ${req.kind === 'money' ? euros(r.granted) : `${r.granted} min`} (no había más)` : 'Petición aprobada');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title={mode === 'approve' ? `Aprobar a ${req.display_name}` : `Rechazar a ${req.display_name}`}
      footer={<Button className="w-full" variant={mode === 'approve' ? 'success' : 'danger'} loading={decide.isPending} onClick={() => decide.mutate()}>{mode === 'approve' ? (req.kind === 'money' ? 'Pagar y aprobar' : 'Dar minutos y aprobar') : 'Rechazar'}</Button>}>
      <div className="space-y-4">
        <p>{req.kind === 'money' ? 'Retira' : 'Pide'} <strong className="num">{what}</strong>{req.note ? <> · «{req.note}»</> : null}.</p>
        {mode === 'approve' && reduced ? (
          <p role="status" className="rounded-2xl bg-sun-soft p-3 text-sm font-bold dark:bg-sun/10">
            Ahora solo tiene {req.kind === 'money' ? euros(left!) : `${left} min`}. Se aprobará por esa cantidad{left! <= 0 ? ' (es 0: no se podrá aprobar)' : ''}.
          </p>
        ) : null}
        {mode === 'approve' && req.kind === 'money' ? <MethodPicker value={method} onChange={setMethod} /> : null}
        <Field label="Nota (opcional)">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field>
      </div>
    </Sheet>
  );
}

function Requests() {
  const [open, setOpen] = useState<{ req: PayoutRequest; mode: 'approve' | 'reject' } | null>(null);
  const list = useQuery({ queryKey: ['payout-requests', 'pending'], queryFn: () => api<{ requests: PayoutRequest[] }>('/payout-requests?status=pending') });
  const requests = list.data?.requests ?? [];
  if (!requests.length) return null;
  return (
    <section className="mb-8">
      <SectionTitle>Retiros y pantalla</SectionTitle>
      <ul className="space-y-3">
        {requests.map((r) => (
          <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3.5">
            <Avatar name={r.display_name} avatar={r.avatar} colorKey={r.color} size={40} />
            <div className="min-w-0 flex-1">
              <p className="font-bold">{r.kind === 'money' ? `Retira ${euros(r.amount_cents!)}` : `Pide ${screenPhrase(r.minutes!, r.category)}`}</p>
              <p className="text-sm muted">{r.display_name} · {relative(r.created_at)}{r.note ? ` · «${r.note}»` : ''}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="danger" onClick={() => setOpen({ req: r, mode: 'reject' })} aria-label={`Rechazar la petición de ${r.display_name}`}>Rechazar</Button>
              <Button size="sm" variant="success" onClick={() => setOpen({ req: r, mode: 'approve' })} aria-label={`Aprobar la petición de ${r.display_name}`}>Aprobar</Button>
            </div>
          </li>
        ))}
      </ul>
      {open ? <DecideSheet key={open.req.id + open.mode} req={open.req} mode={open.mode} onClose={() => setOpen(null)} /> : null}
    </section>
  );
}

/** Préstamos pedidos: se aprueban o se rechazan aquí; al aprobar, el dinero entra en su cuenta. */
function Loans() {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const list = useQuery({ queryKey: ['loans', 'pending'], queryFn: () => api<{ loans: Loan[] }>('/loans?status=pending') });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) => post(`/loans/${v.id}/${v.decision}`),
    onSuccess: (_r, v) => { toast(v.decision === 'approve' ? 'Préstamo aprobado: el dinero ya está en su cuenta' : 'Préstamo rechazado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const loans = list.data?.loans ?? [];
  if (!loans.length) return null;
  return (
    <section className="mb-8">
      <SectionTitle>Préstamos</SectionTitle>
      <ul className="space-y-3">
        {loans.map((l) => (
          <li key={l.id} className="card flex flex-wrap items-center gap-3 p-3.5">
            <Avatar name={l.display_name} avatar={l.avatar} colorKey={l.color} size={40} />
            <div className="min-w-0 flex-1">
              <p className="font-bold">Pide un préstamo de {euros(l.amount_cents)}</p>
              <p className="text-sm muted">{l.display_name} · {l.weeks} {l.weeks === 1 ? 'semana' : 'semanas'}{l.interest_points ? ` · ${l.interest_points} puntos de interés por semana` : ''}{l.note ? ` · «${l.note}»` : ''}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, decision: 'reject' })} aria-label={`Rechazar el préstamo de ${l.display_name}`}>Rechazar</Button>
              <Button size="sm" variant="success" disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, decision: 'approve' })} aria-label={`Aprobar el préstamo de ${l.display_name}`}>Aprobar</Button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Metas de ahorro: «Comprado» con el precio real, o paso a efectivo (sin interés). */
function GoalRequests() {
  const [open, setOpen] = useState<GoalRequest | null>(null);
  const [price, setPrice] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const list = useQuery({ queryKey: ['goal-requests', 'pending'], queryFn: () => api<{ requests: GoalRequest[] }>('/goal-requests?status=pending') });
  const decide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject'; priceCents?: number }) => post(`/goal-requests/${v.id}/${v.decision}`, { priceCents: v.priceCents }),
    onSuccess: (r, v) => {
      toast(v.decision === 'reject' ? 'Petición rechazada' : r.settle_cents == null || r.request.kind === 'cashout' ? 'Pasado a su cuenta de dinero' : r.settle_cents >= 0 ? `Comprado. Vuelven ${euros(r.settle_cents)} a su cuenta` : `Comprado. Se descuentan ${euros(-r.settle_cents)} de su cuenta`);
      setOpen(null);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const reqs = list.data?.requests ?? [];
  if (!reqs.length) return null;
  const cents = parseEuros(price);
  const diff = open && cents ? open.balance_cents - cents : null;
  return (
    <section className="mb-8">
      <SectionTitle>Metas de ahorro</SectionTitle>
      <ul className="space-y-3">
        {reqs.map((r) => (
          <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3.5">
            <Avatar name={r.display_name} avatar={r.avatar} colorKey={r.color} size={40} />
            <div className="min-w-0 flex-1">
              <p className="font-bold">{r.kind === 'redeem' ? `Canjear «${r.goal_title}»` : `Pasar a efectivo «${r.goal_title}»`}</p>
              <p className="text-sm muted">{r.display_name} · {euros(r.balance_cents)} ahorrados{r.kind === 'redeem' ? ' · ve con él o ella a la tienda' : ' · pierde el interés'}</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="danger" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'reject' })} aria-label={`Rechazar la meta «${r.goal_title}» de ${r.display_name}`}>Rechazar</Button>
              {r.kind === 'redeem' ? (
                <Button size="sm" variant="success" onClick={() => { setPrice((r.balance_cents / 100).toFixed(2).replace('.', ',')); setOpen(r); }} aria-label={`Marcar comprada la meta «${r.goal_title}» de ${r.display_name}`}>Comprado</Button>
              ) : (
                <Button size="sm" variant="success" disabled={decide.isPending} onClick={() => decide.mutate({ id: r.id, decision: 'approve' })} aria-label={`Aprobar el paso a efectivo de «${r.goal_title}» de ${r.display_name}`}>Aprobar</Button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {open ? (
        <Sheet open onClose={() => setOpen(null)} title={`Comprado: ${open.goal_title}`}
          footer={<Button className="w-full" variant="success" loading={decide.isPending} disabled={!cents} onClick={() => decide.mutate({ id: open.id, decision: 'approve', priceCents: cents! })}>Marcar comprado</Button>}>
          <div className="space-y-4">
            <p>{open.display_name} tiene <strong className="num">{euros(open.balance_cents)}</strong> en esta meta. Paga en la tienda con él o ella y apunta lo que ha costado de verdad.</p>
            <Field label="Precio real (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
            {diff != null ? (
              <p role="status" className="rounded-2xl bg-[var(--chip)] p-3 text-sm font-bold">
                {diff > 0 ? `Sobran ${euros(diff)}: vuelven a su cuenta de dinero.` : diff < 0 ? `Faltan ${euros(-diff)}: se descuentan de su cuenta de dinero (puede quedar en negativo).` : 'Justo lo que tenía ahorrado.'}
              </p>
            ) : null}
          </div>
        </Sheet>
      ) : null}
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
      <Requests />
      <Loans />
      <GoalRequests />
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
