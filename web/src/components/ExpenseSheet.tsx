import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ApiError, api, post } from '../lib/api';
import { currencySymbol, euros, getCurrency, num, parseEuros, type Currency } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { ExpenseBreakdown, ExpenseContribution, ExpenseRule, User } from '../lib/types';
import { Button, Field, Segmented, Sheet, useToast } from './ui';

const MODES = [{ value: 'percent', label: 'Porcentaje' }, { value: 'amount', label: 'Importe fijo' }] as const;

type ExpenseInput = {
  userId: string;
  title: string;
  totalCents: number;
  currency: Currency;
  contribution?: ExpenseContribution;
  ruleId?: string;
  overrideReason?: string;
};

type ExpensePreview = { breakdown: ExpenseBreakdown; token: string; requestId: string };
type Review = { input: ExpenseInput; quote: ExpensePreview; submitted?: boolean };

export function parseBasisPoints(value: string) {
  const raw = value.trim().replace(',', '.');
  const points = /^\d+(\.\d{1,2})?$/.test(raw) ? Math.round(Number(raw) * 100) : null;
  return points != null && points <= 10_000 ? points : null;
}

export function useExpenseRules() {
  return useQuery({ queryKey: ['expense-rules'], queryFn: () => api<{ rules: ExpenseRule[] }>('/expense-rules') });
}

export function ruleContribution(rule: ExpenseRule) {
  return rule.type === 'percent' ? `${num(rule.basis_points / 100)} %` : euros(rule.cents, rule.currency);
}

function readPendingExpense(key: string): Review | null {
  try {
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as Review | null;
  } catch {
    return null;
  }
}

function savePendingExpense(key: string, review: Review | null) {
  try {
    if (review) sessionStorage.setItem(key, JSON.stringify(review));
    else sessionStorage.removeItem(key);
  } catch {
    // La hoja conserva el intento en memoria si el navegador bloquea el almacenamiento.
  }
}

export function ExpenseDetails({ expense: e, mine = false, currency }: { expense: ExpenseBreakdown; mine?: boolean; currency?: Currency }) {
  const parentRate = e.parent_basis_points == null ? '' : ` (${num(e.parent_basis_points / 100)} %)`;
  const excess = Math.max(0, e.cash_cents + e.points_cents - e.child_cents);
  const money = (cents: number) => euros(cents, e.currency ?? currency);
  const loan = e.loan_cents ?? 0;
  const loanUsed = e.loan_applied_cents ?? 0;
  const rows = [
    ['Precio total', money(e.total_cents)],
    ...(loan ? [
      ['Del préstamo', money(loanUsed)], ['Del saldo previo', money(e.prior_cash_cents ?? 0)],
      ...(loan > loanUsed ? [['Préstamo que queda en el saldo', money(loan - loanUsed)]] : []),
    ] : [
      [mine ? 'Paga tu familia' : 'Aportación familiar', money(e.parent_cents) + parentRate],
      [mine ? 'Pagas tú' : 'Parte del hijo', money(e.child_cents)],
      [mine ? 'De tu dinero' : 'Del saldo en dinero', money(e.cash_cents)],
    ]),
    ...(e.rule ? [['Regla aplicada', `${e.rule.title} · ${ruleContribution(e.rule)}`]] : []),
    ...(e.rule?.override_reason ? [['Excepción a la aportación de ' + money(e.rule.proposed_cents), e.rule.override_reason]] : []),
    [mine ? 'De tus puntos' : 'Puntos convertidos', e.used_points ? `${num(e.used_points)} pts → ${money(e.points_cents)}` : 'Ninguno'],
    ...(excess ? [[mine ? 'Lo que sobró de tus puntos, a tu saldo' : 'Sobrante abonado al saldo', money(excess)]] : []),
    [mine ? 'Te queda por pagar' : 'Pendiente de este gasto', money(e.debt_cents)],
    [mine ? 'Tu saldo ahora' : 'Saldo tras el gasto', money(e.balance_after)],
  ];
  // Para el hijo, una frase llana antes de las cifras: quién pagó qué y si queda algo pendiente.
  const summary = mine && !loan ? [
    `Tu familia puso ${money(e.parent_cents)} y tú ${money(e.child_cents)}`,
    e.cash_cents && e.used_points ? ` (${money(e.cash_cents)} de tu dinero y ${money(e.points_cents)} de tus puntos)` : e.used_points ? ` con ${num(e.used_points)} puntos` : '',
    e.debt_cents ? `. Te quedan ${money(e.debt_cents)} por pagar.` : '. No te queda nada por pagar.',
  ].join('') : null;
  return (
    <>
    {summary ? <p className="mb-2 text-sm font-bold">{summary}</p> : null}
    <dl className="space-y-1.5 rounded-xl bg-[var(--chip)] p-3 text-sm">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
          <dt className="text-[var(--fg-2)]">{label}</dt>
          <dd className={`num font-bold wrap-anywhere ${(label === 'Saldo tras el gasto' || label === 'Tu saldo ahora') && e.balance_after < 0 ? 'text-berry-deep dark:text-[#ff9dbf]' : ''}`}>{value}</dd>
        </div>
      ))}
    </dl>
    </>
  );
}

export function ExpenseSheet({ child, onClose }: { child: User; onClose: () => void }) {
  const { user } = useSession();
  const storageKey = `mesada:pending-expense:${user.id}:${child.id}`;
  const [review, setReview] = useState<Review | null>(() => readPendingExpense(storageKey));
  const [title, setTitle] = useState(review?.input.title ?? '');
  const [total, setTotal] = useState(review ? String(review.input.totalCents / 100) : '');
  const [percent, setPercent] = useState(review?.input.contribution?.type === 'percent' ? String(review.input.contribution.basisPoints / 100) : '50');
  const [amount, setAmount] = useState(review?.input.contribution?.type === 'amount' ? String(review.input.contribution.cents / 100) : '');
  const [mode, setMode] = useState<'amount' | 'percent'>(review?.input.contribution?.type ?? 'percent');
  const rules = useExpenseRules();
  const [ruleId, setRuleId] = useState(review?.input.ruleId ?? '');
  const [override, setOverride] = useState(!!review?.input.overrideReason);
  const [reason, setReason] = useState(review?.input.overrideReason ?? '');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();

  const preview = useMutation({
    mutationFn: (input: ExpenseInput) => post<ExpensePreview>('/expenses/preview', input),
    onSuccess: (quote, input) => setReview({ input, quote }),
    onError: (e: Error) => {
      if (e instanceof ApiError && e.code === 'expense_currency_changed') invalidate();
      setError(e.message);
    },
  });
  const save = useMutation({
    mutationFn: ({ input, quote }: Review) => post('/expenses', { ...input, token: quote.token, requestId: quote.requestId }),
    onMutate: (value) => {
      const submitted = { ...value, submitted: true };
      savePendingExpense(storageKey, submitted);
      setReview(submitted);
    },
    onSuccess: () => { savePendingExpense(storageKey, null); toast('Gasto registrado'); invalidate(); onClose(); },
    onError: (e: Error) => {
      if (e instanceof ApiError && ['expense_quote_changed', 'expense_currency_changed', 'expense_rule_unavailable', 'expense_rule_currency', 'expense_already_recorded'].includes(e.code)) {
        savePendingExpense(storageKey, null);
        if (e.code === 'expense_rule_unavailable') setRuleId('');
        invalidate();
        setReview(null);
      }
      setError(e.message);
    },
  });

  function requestPreview() {
    setError('');
    const totalCents = parseEuros(total);
    if (!title.trim()) { setError('Escribe el motivo del gasto.'); return; }
    if (!totalCents || totalCents > 10_000_000) { setError('Indica un precio total válido.'); return; }
    const input = { userId: child.id, title, totalCents, currency: getCurrency(), ruleId: ruleId || undefined, overrideReason: ruleId && override ? reason.trim() : undefined };
    if (ruleId && !override) { preview.mutate(input); return; }
    if (ruleId && !reason.trim()) { setError('Explica por qué cambia la aportación de la regla.'); return; }

    if (mode === 'percent') {
      const basisPoints = parseBasisPoints(percent);
      if (basisPoints == null) { setError('Introduce un porcentaje entre 0 y 100.'); return; }
      preview.mutate({ ...input, contribution: { type: 'percent', basisPoints } });
    } else {
      const cents = parseEuros(amount);
      if (cents == null || cents > totalCents) { setError('La aportación debe estar entre cero y el precio total.'); return; }
      preview.mutate({ ...input, contribution: { type: 'amount', cents } });
    }
  }

  const symbol = currencySymbol();
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Registrar gasto de ${child.display_name}`}
      footer={
        <div className="flex flex-wrap gap-2">
          {review ? (
            <>
              <Button variant="secondary" disabled={save.isPending || review.submitted} onClick={() => { setError(''); setReview(null); }}>Editar</Button>
              <Button className="flex-1" variant="success" loading={save.isPending} onClick={() => { setError(''); save.mutate(review); }}>Confirmar gasto</Button>
            </>
          ) : <Button className="w-full" loading={preview.isPending} onClick={requestPreview}>Ver desglose</Button>}
        </div>
      }
    >
      {review ? (
        <div className="space-y-3">
          <h3 className="break-words font-bold">{review.input.title}</h3>
          <ExpenseDetails expense={review.quote.breakdown} currency={review.input.currency} />
          <p className="text-sm muted">{child.display_name} recibirá un aviso con este desglose y podrá consultarlo en su extracto.</p>
          {review.submitted && !save.isPending ? <p className="text-sm font-bold">Vuelve a confirmar para comprobar si el gasto quedó registrado.</p> : null}
        </div>
      ) : (
        <fieldset disabled={preview.isPending} className="space-y-4">
          <Field label="Motivo">{(id) => <input id={id} className="field" maxLength={120} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Entrada de cine" />}</Field>
          <Field label={`Precio total (${symbol})`}>{(id) => <input id={id} className="field" inputMode="decimal" maxLength={12} value={total} onChange={(e) => setTotal(e.target.value)} />}</Field>
          {rules.data?.rules.length || ruleId ? <Field label="Regla de gasto">{(id) => <select id={id} className="field" value={ruleId} onChange={(e) => { setRuleId(e.target.value); setOverride(false); setReason(''); }}>
            <option value="">Aportación manual</option>
            {rules.data?.rules.map((rule) => <option key={rule.id} value={rule.id}>{rule.title} · {ruleContribution(rule)}</option>)}
          </select>}</Field> : null}
          {ruleId ? <label className="flex min-h-11 items-center gap-2 text-sm font-bold"><input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} /> Hacer una excepción</label> : null}
          {!ruleId || override ? <>
            <Segmented label="Cómo aporta la familia" value={mode} onChange={setMode} options={[...MODES]} wrap />
            {mode === 'percent' ? (
            <Field label="Porcentaje que aporta la familia" hint="Si sobra una fracción de céntimo, la cubre la familia.">
              {(id) => <input id={id} className="field" inputMode="decimal" maxLength={6} value={percent} onChange={(e) => setPercent(e.target.value)} />}
            </Field>
          ) : (
            <Field label={`Aportación familiar (${symbol})`}>
              {(id) => <input id={id} className="field" inputMode="decimal" maxLength={12} value={amount} onChange={(e) => setAmount(e.target.value)} />}
            </Field>
            )}
            {ruleId ? <Field label="Motivo de la excepción">{(id) => <textarea id={id} className="field" rows={2} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />}</Field> : null}
          </> : null}
        </fieldset>
      )}
      {error ? <p role="alert" className="mt-3 text-sm font-bold text-berry-deep dark:text-[#ff9dbf]">{error}</p> : null}
    </Sheet>
  );
}
