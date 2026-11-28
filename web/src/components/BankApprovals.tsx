import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Banknote, CalendarClock, Check, HandCoins, MonitorSmartphone, PiggyBank, ShoppingBag, Target, X, type LucideIcon } from 'lucide-react';
import { api, post } from '../lib/api';
import { currencySymbol, euros, parseEuros, refCode, relative } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { screenPhrase, PAY_METHODS } from '../lib/screen';
import type { GoalProposals, GoalRequest, Loan, PayMethod, PayoutRequest, Wallet } from '../lib/types';
import { Button, Field, Sheet, useToast } from './ui';
import { AmountSheet } from './AmountSheet';
import { MethodPicker } from './MoneySheets';
import { useReceipt } from './Receipt';
import { LoanApprovalSheet } from './LoanApprovalSheet';

type Tone = 'berry' | 'sky' | 'sun' | 'leaf';
const TONE: Record<Tone, string> = {
  berry: 'bg-berry-soft text-[#a8214f] dark:bg-berry/20 dark:text-[#ff9dbf]',
  sky: 'bg-sky-soft text-[#2a5fc2] dark:bg-sky/20 dark:text-[#a9c7ff]',
  sun: 'bg-sun-soft text-sun-ink dark:bg-sun/20 dark:text-[#ffd979]',
  leaf: 'bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]',
};

type Item = {
  key: string;
  at: string;
  icon: LucideIcon;
  tone: Tone;
  title: string;
  detail: string;
  amount: string;
  who: string;
  onReject: () => void;
  onApprove: () => void;
  rejectLabel: string;
  approveLabel: string;
  busy?: boolean;
};

/** Todo lo que un adulto tiene que aprobar del banco: retiros, pantalla, préstamos y metas, de más nuevo a más viejo. */
export function useBankApprovals() {
  const pay = useQuery({ queryKey: ['payout-requests', 'pending'], queryFn: () => api<{ requests: PayoutRequest[] }>('/payout-requests?status=pending') });
  const loans = useQuery({ queryKey: ['loans', 'pending'], queryFn: () => api<{ loans: Loan[] }>('/loans?status=pending') });
  const goals = useQuery({ queryKey: ['goal-requests', 'pending'], queryFn: () => api<{ requests: GoalRequest[] }>('/goal-requests?status=pending') });
  const proposals = useQuery({ queryKey: ['goal-proposals'], queryFn: () => api<GoalProposals>('/goal-proposals') });
  const count = (pay.data?.requests.length ?? 0) + (loans.data?.loans.length ?? 0) + (goals.data?.requests.length ?? 0) + (proposals.data?.proposals.length ?? 0) + (proposals.data?.autoRequests.length ?? 0);
  return {
    pay: pay.data?.requests ?? [], loans: loans.data?.loans ?? [], goals: goals.data?.requests ?? [],
    proposals: proposals.data?.proposals ?? [], autoRequests: proposals.data?.autoRequests ?? [], count,
  };
}

/** Una meta propuesta por un hijo: el adulto la aprueba (pudiendo ajustar nombre y precio) o la rechaza con un motivo. */
function ProposalSheet({ p, mode, onClose }: { p: GoalProposals['proposals'][number]; mode: 'approve' | 'reject'; onClose: () => void }) {
  const [title, setTitle] = useState(p.title);
  const [price, setPrice] = useState((p.target_cents / 100).toFixed(2).replace('.', ','));
  const [note, setNote] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const decide = useMutation({
    mutationFn: () => {
      if (mode === 'reject') {
        if (!note.trim()) throw new Error('Cuéntale por qué (el motivo es obligatorio)');
        return post(`/goals/${p.id}/proposal/reject`, { note });
      }
      const cents = parseEuros(price);
      if (!cents || !title.trim()) throw new Error('Pon un nombre y un precio');
      return post(`/goals/${p.id}/proposal/approve`, { title, targetCents: cents, note: note.trim() || undefined });
    },
    onSuccess: () => { toast(mode === 'approve' ? `Meta de ${p.display_name} aprobada` : 'Meta rechazada'); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title={mode === 'approve' ? `Aprobar la meta de ${p.display_name}` : `Rechazar la meta de ${p.display_name}`}
      footer={<Button className="w-full" variant={mode === 'approve' ? 'success' : 'danger'} loading={decide.isPending} onClick={() => decide.mutate()}>{mode === 'approve' ? 'Aprobar meta' : 'Rechazar meta'}</Button>}>
      <div className="space-y-4">
        {mode === 'approve' ? (
          <>
            <p className="muted">Puedes ajustar el nombre o el precio antes de aprobarla.</p>
            <Field label="Nombre de la meta">{(id) => <input id={id} className="field" maxLength={80} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
            <Field label={`Precio (${currencySymbol()})`}>{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
          </>
        ) : null}
        <Field label={mode === 'approve' ? 'Mensaje (opcional)' : 'Motivo (obligatorio)'} hint={mode === 'reject' ? 'Lo verá el niño: sé amable y concreto.' : undefined}>
          {(id) => <input id={id} className="field" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}
        </Field>
      </div>
    </Sheet>
  );
}

/** Aprobar o rechazar una petición de pantalla, o rechazar un retiro; ambas admiten una nota. */
function DecideSheet({ req, mode, onClose }: { req: PayoutRequest; mode: 'approve' | 'reject'; onClose: () => void }) {
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
    mutationFn: () => post(`/payout-requests/${req.id}/${mode}`, { note: note || undefined }),
    onSuccess: (r) => {
      toast(mode === 'reject' ? 'Petición rechazada' : r.reduced ? `Aprobada por menos: ${r.granted} min (no había más)` : 'Petición aprobada');
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title={mode === 'approve' ? `Aprobar a ${req.display_name}` : `Rechazar a ${req.display_name}`}
      footer={<Button className="w-full" variant={mode === 'approve' ? 'success' : 'danger'} loading={decide.isPending} onClick={() => decide.mutate()}>{mode === 'approve' ? 'Dar minutos y aprobar' : 'Rechazar'}</Button>}>
      <div className="space-y-4">
        <p>{req.kind === 'money' ? 'Retira' : 'Pide'} <strong className="num">{what}</strong>{req.note ? <> · «{req.note}»</> : null}.</p>
        {mode === 'approve' && reduced ? (
          <p role="status" className="rounded-2xl bg-sun-soft p-3 text-sm font-bold dark:bg-sun/10">
            Ahora solo tiene {`${left} min`}. Se aprobará por esa cantidad{left! <= 0 ? ' (es 0: no se podrá aprobar)' : ''}.
          </p>
        ) : null}
        <Field label="Nota (opcional)">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field>
      </div>
    </Sheet>
  );
}

/** Aprobar un retiro = pagarlo: hoja de importe fijado, con forma de pago, y recibo al terminar. */
function PayRequestSheet({ req, onClose }: { req: PayoutRequest; onClose: () => void }) {
  const [method, setMethod] = useState<PayMethod>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const wallet = useQuery({ queryKey: ['wallet', req.user_id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${req.user_id}`) });
  const w = wallet.data?.wallet;
  const asked = req.amount_cents!;
  // Si el saldo bajó desde que lo pidió, se paga lo que haya.
  const grant = w ? Math.min(asked, Math.max(0, w.cents_pending)) : asked;
  const reduced = !!w && grant < asked;
  const pay = useMutation({
    mutationFn: () => post(`/payout-requests/${req.id}/approve`, { method, note: note || undefined }),
    onSuccess: (r) => {
      invalidate();
      onClose();
      const paid = r.granted ?? grant;
      showReceipt({
        title: 'Pago registrado', amount: euros(paid), at: new Date(), ref: refCode('PG', req.id),
        rows: [{ label: 'A', value: req.display_name }, { label: 'Forma de pago', value: PAY_METHODS.find((m) => m.value === method)?.label ?? '' }, { label: 'Importe', value: euros(paid) }],
        total: w ? { label: 'Le quedan', value: euros(w.cents_pending - paid) } : undefined,
        notice: { title: `Avisamos a ${req.display_name}.`, sub: 'Retiro aprobado y pagado.', avatar: { name: req.display_name, avatar: req.avatar, color: req.color } },
      });
    },
    onError: (e: Error) => { setError(e.message); toast(e.message, 'error'); },
  });
  return (
    <AmountSheet
      title={`Pagar a ${req.display_name}`} subtitle={<>Retiro pedido de la cuenta de dinero{req.note ? ` · «${req.note}»` : ''}</>}
      unit="eur" max={grant} min={1} initial={grant} locked variant="success" blocked={!w || grant <= 0}
      info={reduced ? <span role="status" className="rounded-2xl bg-sun-soft px-3 py-2 text-center font-bold text-sun-ink">Pidió {euros(asked)}, pero ahora solo tiene {euros(grant)}. Se paga eso.</span> : undefined}
      extra={<><MethodPicker value={method} onChange={setMethod} /><Field label="Nota (opcional)">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field></>}
      cta={(v) => (v ? `Pagar ${euros(v)}` : 'Pagar')}
      error={error} loading={pay.isPending} onSubmit={() => { setError(''); pay.mutate(); }} onClose={onClose}
    />
  );
}

/**
 * Lista «Por aprobar» compartida por Banca familiar y Validar. Con `empty`, enseña un texto si no hay nada;
 * sin él, no pinta nada.
 */
export function BankApprovals({ heading, empty }: { heading: (count: number) => React.ReactNode; empty?: React.ReactNode }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const { pay, loans, goals, proposals, autoRequests, count } = useBankApprovals();
  const [prop, setProp] = useState<{ p: GoalProposals['proposals'][number]; mode: 'approve' | 'reject' } | null>(null);
  const [open, setOpen] = useState<{ req: PayoutRequest; mode: 'approve' | 'reject' } | null>(null);
  const [buy, setBuy] = useState<GoalRequest | null>(null);
  const [loan, setLoan] = useState<Loan | null>(null);
  const [price, setPrice] = useState('');

  const rejectLoan = useMutation({
    mutationFn: (id: string) => post(`/loans/${id}/reject`),
    onSuccess: () => { toast('Préstamo rechazado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const goalDecide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject'; priceCents?: number }) => post(`/goal-requests/${v.id}/${v.decision}`, { priceCents: v.priceCents }),
    onSuccess: (r, v) => {
      toast(v.decision === 'reject' ? 'Petición rechazada' : r.settle_cents == null || r.request.kind === 'cashout' ? 'Pasado a su cuenta de dinero' : r.settle_cents >= 0 ? `Comprado. Vuelven ${euros(r.settle_cents)} a su cuenta` : `Comprado. Se descuentan ${euros(-r.settle_cents)} de su cuenta`);
      setBuy(null);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const autoDecide = useMutation({
    mutationFn: (v: { id: string; decision: 'approve' | 'reject' }) => post(`/goals/${v.id}/auto/${v.decision}`),
    onSuccess: (_r, v) => { toast(v.decision === 'approve' ? 'Ahorro automático aprobado' : 'Ahorro automático rechazado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const items: Item[] = [
    ...proposals.map<Item>((g) => ({
      key: `np${g.id}`, at: g.created_at, icon: Target, tone: 'leaf', title: `Meta de ahorro «${g.title}»`,
      detail: `${g.display_name} · ${relative(g.created_at)} · propone esta meta`, amount: euros(g.target_cents), who: g.display_name,
      rejectLabel: `Rechazar la meta «${g.title}» de ${g.display_name}`, approveLabel: `Aprobar la meta «${g.title}» de ${g.display_name}`,
      onReject: () => setProp({ p: g, mode: 'reject' }), onApprove: () => setProp({ p: g, mode: 'approve' }),
    })),
    ...autoRequests.map<Item>((g) => ({
      key: `na${g.id}`, at: g.created_at, icon: CalendarClock, tone: 'sky', title: `Ahorro automático en «${g.title}»`,
      detail: `${g.display_name} · quiere ahorrar solo el ${g.auto_pending_percent} % de cada cierre`, amount: `${g.auto_pending_percent} %`, who: g.display_name,
      rejectLabel: `Rechazar el ahorro automático de ${g.display_name}`, approveLabel: `Aprobar el ahorro automático de ${g.display_name}`, busy: autoDecide.isPending,
      onReject: () => autoDecide.mutate({ id: g.id, decision: 'reject' }), onApprove: () => autoDecide.mutate({ id: g.id, decision: 'approve' }),
    })),
    ...pay.map<Item>((r) => r.kind === 'money' ? {
      key: `p${r.id}`, at: r.created_at, icon: Banknote, tone: 'berry', title: `Retiro de ${euros(r.amount_cents!)}`,
      detail: `${r.display_name} · ${relative(r.created_at)} · de su cuenta de dinero${r.note ? ` · «${r.note}»` : ''}`, amount: euros(r.amount_cents!), who: r.display_name,
      rejectLabel: `Rechazar la petición de ${r.display_name}`, approveLabel: `Aprobar la petición de ${r.display_name}`,
      onReject: () => setOpen({ req: r, mode: 'reject' }), onApprove: () => setOpen({ req: r, mode: 'approve' }),
    } : {
      key: `p${r.id}`, at: r.created_at, icon: MonitorSmartphone, tone: 'sun', title: `Pide ${screenPhrase(r.minutes!, r.category)}`,
      detail: `${r.display_name} · ${relative(r.created_at)}${r.note ? ` · «${r.note}»` : ''}`, amount: `${r.minutes} min`, who: r.display_name,
      rejectLabel: `Rechazar la petición de ${r.display_name}`, approveLabel: `Aprobar la petición de ${r.display_name}`,
      onReject: () => setOpen({ req: r, mode: 'reject' }), onApprove: () => setOpen({ req: r, mode: 'approve' }),
    }),
    ...loans.map<Item>((l) => ({
      key: `l${l.id}`, at: l.created_at, icon: HandCoins, tone: 'sky', title: `Préstamo en ${l.weeks} ${l.weeks === 1 ? 'semana' : 'semanas'}`,
      detail: `${l.display_name} · ${relative(l.created_at)} · cuotas de ${euros(l.installment_cents)}${l.interest_points ? ` + ${l.interest_points} pts` : ''}${l.note ? ` · «${l.note}»` : ''}`, amount: euros(l.amount_cents), who: l.display_name,
      rejectLabel: `Rechazar el préstamo de ${l.display_name}`, approveLabel: `Aprobar el préstamo de ${l.display_name}`, busy: rejectLoan.isPending,
      onReject: () => rejectLoan.mutate(l.id), onApprove: () => setLoan(l),
    })),
    ...goals.map<Item>((g) => g.kind === 'redeem' ? {
      key: `g${g.id}`, at: g.created_at, icon: ShoppingBag, tone: 'sun', title: `Canjear meta «${g.goal_title}»`,
      detail: `${g.display_name} · ${relative(g.created_at)} · meta alcanzada, pagas en la tienda`, amount: euros(g.balance_cents), who: g.display_name,
      rejectLabel: `Rechazar la meta «${g.goal_title}» de ${g.display_name}`, approveLabel: `Marcar comprada la meta «${g.goal_title}» de ${g.display_name}`, busy: goalDecide.isPending,
      onReject: () => goalDecide.mutate({ id: g.id, decision: 'reject' }), onApprove: () => { setPrice((g.balance_cents / 100).toFixed(2).replace('.', ',')); setBuy(g); },
    } : {
      key: `g${g.id}`, at: g.created_at, icon: PiggyBank, tone: 'leaf', title: `Pasar a efectivo «${g.goal_title}»`,
      detail: `${g.display_name} · ${relative(g.created_at)} · pierde el interés`, amount: euros(g.balance_cents), who: g.display_name,
      rejectLabel: `Rechazar la meta «${g.goal_title}» de ${g.display_name}`, approveLabel: `Aprobar el paso a efectivo de «${g.goal_title}» de ${g.display_name}`, busy: goalDecide.isPending,
      onReject: () => goalDecide.mutate({ id: g.id, decision: 'reject' }), onApprove: () => goalDecide.mutate({ id: g.id, decision: 'approve' }),
    }),
  ].sort((a, b) => b.at.localeCompare(a.at));

  if (!items.length && !empty && !loan) return null;
  const cents = parseEuros(price);
  const diff = buy && cents ? buy.balance_cents - cents : null;

  return (
    <section className="mb-8" aria-label="Por aprobar">
      {loan ? <LoanApprovalSheet loan={loan} onClose={() => setLoan(null)} /> : null}
      {heading(count)}
      {items.length ? (
        <ul className="card overflow-hidden">
          {items.map((it) => {
            const Icon = it.icon;
            return (
              <li key={it.key} className="grid grid-cols-[44px_1fr] items-center gap-x-4 gap-y-2.5 px-4 py-3.5 not-first:border-t not-first:border-[var(--line)] sm:grid-cols-[44px_1fr_auto_auto] sm:px-[1.125rem]">
                <span className={`flex size-11 items-center justify-center rounded-full ${TONE[it.tone]}`}><Icon size={22} aria-hidden /></span>
                <div className="min-w-0">
                  <b className="block leading-tight">{it.title}</b>
                  <small className="text-[0.85rem] text-[var(--fg-3)]">{it.detail}</small>
                </div>
                <p className="num col-span-2 text-[1.35rem] font-extrabold sm:col-span-1 sm:text-right">{it.amount}</p>
                <div className="col-span-2 grid grid-cols-2 gap-2 sm:col-span-1 sm:flex">
                  <Button size="sm" variant="danger" disabled={it.busy} onClick={it.onReject} aria-label={it.rejectLabel}><X size={16} aria-hidden /> Rechazar</Button>
                  <Button size="sm" variant="success" disabled={it.busy} onClick={it.onApprove} aria-label={it.approveLabel}><Check size={16} aria-hidden /> Aprobar</Button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : <div className="card p-5 text-center muted">{empty}</div>}

      {prop ? <ProposalSheet key={prop.p.id + prop.mode} p={prop.p} mode={prop.mode} onClose={() => setProp(null)} /> : null}
      {open?.mode === 'approve' && open.req.kind === 'money' ? <PayRequestSheet key={open.req.id} req={open.req} onClose={() => setOpen(null)} /> : null}
      {open && !(open.mode === 'approve' && open.req.kind === 'money') ? <DecideSheet key={open.req.id + open.mode} req={open.req} mode={open.mode} onClose={() => setOpen(null)} /> : null}
      {buy ? (
        <Sheet open onClose={() => setBuy(null)} title={`Comprado: ${buy.goal_title}`}
          footer={<Button className="w-full" variant="success" loading={goalDecide.isPending} disabled={!cents} onClick={() => goalDecide.mutate({ id: buy.id, decision: 'approve', priceCents: cents! })}>Marcar comprado</Button>}>
          <div className="space-y-4">
            <p>{buy.display_name} tiene <strong className="num">{euros(buy.balance_cents)}</strong> en esta meta. Paga en la tienda con él o ella y apunta lo que ha costado de verdad.</p>
            <Field label={`Precio real (${currencySymbol()})`}>{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />}</Field>
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

