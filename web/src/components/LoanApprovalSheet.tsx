import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api, post } from '../lib/api';
import { currencySymbol, euros, fmtDate, getCurrency, parseEuros, type Currency } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import type { ExpenseBreakdown, Goal, Loan } from '../lib/types';
import { ExpenseDetails } from './ExpenseSheet';
import { Button, Field, Sheet, useToast } from './ui';

type Purchase = { type: 'purchase'; title: string; totalCents: number; currency: Currency };
type Quote = { breakdown: ExpenseBreakdown; token: string; requestId: string };
type LoanDestination = { type: 'balance' } | { type: 'external'; method: 'cash' | 'bizum' | 'transfer' }
  | { type: 'goal'; goalId: string } | (Purchase & { requestId: string; token: string });

export function LoanApprovalSheet({ loan, onClose }: { loan: Loan; onClose: () => void }) {
  const [kind, setKind] = useState<LoanDestination['type']>('balance');
  const [method, setMethod] = useState<'cash' | 'bizum' | 'transfer'>('cash');
  const [goalId, setGoalId] = useState('');
  const [title, setTitle] = useState('');
  const [price, setPrice] = useState('');
  const [review, setReview] = useState<{ purchase: Purchase; quote: Quote } | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const goals = useQuery({ queryKey: ['goals', loan.user_id], queryFn: () => api<{ goals: Goal[] }>(`/goals/${loan.user_id}`), enabled: kind === 'goal' });
  const eligibleGoals = (goals.data?.goals ?? []).filter((g) => g.status === 'active' && !g.pending_request);
  const preview = useMutation({
    mutationFn: (purchase: Purchase) => post<Quote>(`/loans/${loan.id}/preview`, { destination: purchase }),
    onSuccess: (quote, purchase) => setReview({ purchase, quote }),
    onError: (e: Error) => {
      if (e instanceof ApiError && e.code === 'expense_currency_changed') invalidate();
      setError(e.message);
    },
  });
  const approve = useMutation({
    mutationFn: (destination: LoanDestination) => post(`/loans/${loan.id}/approve`, { destination }),
    onSuccess: (_r, destination) => {
      toast(destination.type === 'balance' ? 'Préstamo aprobado: el dinero ya está en su cuenta' : 'Préstamo aprobado');
      invalidate();
      onClose();
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && ['expense_quote_changed', 'expense_currency_changed'].includes(e.code)) {
        setReview(null);
        invalidate();
      }
      setError(e.message);
    },
  });
  const total = parseEuros(price);
  const busy = preview.isPending || approve.isPending;
  const submit = () => {
    setError('');
    if (kind === 'external') approve.mutate({ type: kind, method });
    else if (kind === 'goal') approve.mutate({ type: kind, goalId });
    else if (review) approve.mutate({ ...review.purchase, token: review.quote.token, requestId: review.quote.requestId });
    else if (kind === 'purchase' && total) preview.mutate({ type: kind, title: title.trim(), totalCents: total, currency: getCurrency() });
    else if (kind === 'balance') approve.mutate({ type: kind });
  };
  return (
    <Sheet open onClose={onClose} title={`Aprobar el préstamo de ${loan.display_name}`} footer={
      <div className="flex gap-2">
        {review ? <Button variant="secondary" disabled={busy} onClick={() => { setError(''); setReview(null); }}>Editar</Button> : null}
        <Button variant="success" className="flex-1" loading={busy} disabled={kind === 'goal' ? !goalId : kind === 'purchase' && (!title.trim() || !total || total > 10_000_000)} onClick={submit}>
          {kind === 'purchase' && !review ? 'Ver desglose' : 'Aprobar préstamo'}
        </Button>
      </div>
    }>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 rounded-xl bg-[var(--chip)] p-3 text-sm">
          <dt>Principal</dt><dd className="num text-right font-bold">{euros(loan.amount_cents)}</dd>
          <dt>Cuotas semanales</dt><dd className="num text-right font-bold">{loan.weeks} · {euros(loan.installment_cents)}{loan.interest_points ? ` + ${loan.interest_points} pts` : ''}</dd>
          {loan.proposed_first_charge_week ? <><dt>Primer cobro</dt><dd className="text-right font-bold">{fmtDate(loan.proposed_first_charge_week, { weekday: 'short', day: 'numeric', month: 'short' })}</dd></> : null}
        </dl>
        {review ? <div className="space-y-2"><h3 className="font-bold wrap-anywhere">{review.purchase.title} · {review.purchase.currency}</h3><ExpenseDetails expense={review.quote.breakdown} currency={review.purchase.currency} /></div> : (
          <fieldset disabled={busy} className="space-y-4">
            <Field label="Destino del préstamo">{(id) => <select id={id} className="field" value={kind} onChange={(e) => { setKind(e.target.value as LoanDestination['type']); setError(''); }}>
              <option value="balance">Saldo disponible</option><option value="external">Entrega externa</option><option value="goal">Meta de ahorro</option><option value="purchase">Compra</option>
            </select>}</Field>
            {kind === 'external' ? <Field label="Medio de entrega" hint="Registra la entrega que ya hiciste.">{(id) => <select id={id} className="field" value={method} onChange={(e) => setMethod(e.target.value as typeof method)}><option value="cash">Efectivo</option><option value="bizum">Bizum</option><option value="transfer">Transferencia</option></select>}</Field> : null}
            {kind === 'goal' ? <Field label="Meta activa" error={goals.error?.message} hint={!goals.isLoading && !eligibleGoals.length ? 'No hay metas que admitan aportaciones.' : undefined}>{(id) => <select id={id} className="field" value={goalId} onChange={(e) => setGoalId(e.target.value)}>
              <option value="">Elige la meta</option>{eligibleGoals.map((g) => <option key={g.id} value={g.id}>{g.title}</option>)}
            </select>}</Field> : null}
            {kind === 'purchase' ? <>
              <Field label="Artículo">{(id) => <input id={id} className="field" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />}</Field>
              <Field label={`Precio total (${currencySymbol()})`}>{(id) => <input id={id} className="field" value={price} inputMode="decimal" maxLength={12} onChange={(e) => setPrice(e.target.value)} />}</Field>
            </> : null}
          </fieldset>
        )}
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
      </div>
    </Sheet>
  );
}
