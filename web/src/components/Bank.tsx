import { useState, type ReactNode } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRightLeft, Banknote, FastForward, HandCoins, History, Landmark, Nfc, PiggyBank, Plus, Target } from 'lucide-react';
import { api, newKey, post } from '../lib/api';
import { euros, fmtDate, fmtDateTime, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import type { Bank, BankAction, Goal, Loan, StatementEntry } from '../lib/types';
import { Badge, Button, Empty, Field, Loading, Segmented, Sheet, useToast } from './ui';
import { Bar } from './Ring';
import { LEDGER_KIND } from './Ledger';

/* ---------- Tarjetas de cuenta ---------- */

/**
 * Tarjeta de cuenta al estilo banco, con los colores de DiploP: marino para el dinero y sol para los puntos.
 * El número de cuenta es de juguete (sale del identificador del usuario).
 */
export function AccountCard({ tone, title, number, value, unit, children }: { tone: 'money' | 'points'; title: string; number: string; value: number; unit: 'eur' | 'pts'; children?: ReactNode }) {
  const money = tone === 'money';
  const negative = value < 0;
  return (
    <section
      aria-label={title}
      className={`relative overflow-hidden rounded-[var(--radius-panel)] p-5 shadow-[var(--shadow-lift)] ${money ? 'text-white' : 'text-ink'}`}
      style={{ background: money ? 'radial-gradient(120% 90% at 0% 0%, #3d8bd0 0%, transparent 55%), linear-gradient(160deg, #1f63ad 0%, #154d93 55%, #142a5c 100%)' : 'linear-gradient(150deg, #ffd45c 0%, #ffb800 100%)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={`flex items-center gap-1.5 text-sm font-bold ${money ? 'text-white/80' : 'text-ink/75'}`}><Landmark size={15} aria-hidden /> DiploP · {title}</p>
          <p className="num mt-1 text-[0.95rem] font-bold tracking-[0.12em] opacity-90" aria-label={`Número de cuenta ${number}`}>{number}</p>
        </div>
        {/* Chip de la tarjeta */}
        <span aria-hidden className={`mt-1 inline-flex h-7 w-9 items-center justify-center rounded-md ${money ? 'bg-white/25' : 'bg-ink/15'}`}><Nfc size={16} /></span>
      </div>
      <p className={`num mt-4 text-[2.6rem] leading-none font-extrabold ${negative ? (money ? 'text-[#ffb3c7]' : 'text-berry') : ''}`}>
        {unit === 'eur' ? euros(value) : <>{value} <span className="text-xl font-bold">pts</span></>}
      </p>
      {children ? <div className={`mt-3 text-sm ${money ? 'text-white/80' : 'text-ink/80'}`}>{children}</div> : null}
    </section>
  );
}

/* ---------- Botones de cajero ---------- */

export type AtmKey = 'withdraw' | 'exchange' | 'advance' | 'loan' | 'save';
const ATM: { key: AtmKey; label: string; icon: ReactNode }[] = [
  { key: 'withdraw', label: 'Retirar', icon: <Banknote size={22} /> },
  { key: 'exchange', label: 'Canjear puntos', icon: <ArrowRightLeft size={22} /> },
  { key: 'advance', label: 'Adelanto', icon: <FastForward size={22} /> },
  { key: 'loan', label: 'Préstamo', icon: <HandCoins size={22} /> },
  { key: 'save', label: 'Ahorrar', icon: <PiggyBank size={22} /> },
];

/** Fila de botones tipo cajero. Los no disponibles se quedan visibles y dicen por qué (sin desaparecer). */
export function AtmButtons({ bank, onPick }: { bank: Bank; onPick: (k: AtmKey) => void }) {
  const toast = useToast();
  return (
    <div role="group" aria-label="Operaciones" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      {ATM.map((a) => {
        const act: BankAction = bank.actions[a.key];
        return (
          <button
            key={a.key}
            type="button"
            aria-disabled={!act.ok}
            onClick={() => (act.ok ? onPick(a.key) : toast(act.reason ?? 'Ahora no está disponible', 'error'))}
            className={`flex min-h-24 flex-col items-center gap-1 rounded-[var(--radius-card)] border px-1.5 py-3 text-center transition active:scale-[0.97] ${act.ok ? 'border-[var(--line)] bg-[var(--card)] text-[var(--fg)] shadow-[var(--shadow-press)] hover:border-tangerine' : 'border-dashed border-[var(--line)] bg-transparent text-[var(--fg-3)]'}`}
          >
            <span className={act.ok ? 'text-tangerine' : ''} aria-hidden>{a.icon}</span>
            <span className="text-sm leading-tight font-bold">{a.label}</span>
            {!act.ok && act.reason ? <span className="text-[0.7rem] leading-tight font-normal">{act.reason}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Extracto ---------- */

/** Extracto: fecha, concepto, importe (verde/rojo) y saldo tras cada movimiento. */
export function Statement({ userId, initial = 'money' }: { userId: string; initial?: 'money' | 'points' }) {
  const [account, setAccount] = useState<'money' | 'points'>(initial);
  const { data, isLoading } = useQuery({ queryKey: ['statement', userId, account], queryFn: () => api<{ entries: StatementEntry[] }>(`/statement/${userId}?account=${account}`) });
  const fmt = (n: number) => (account === 'money' ? euros(n) : `${n} pts`);
  return (
    <div>
      <Segmented label="Cuenta del extracto" value={account} onChange={setAccount} options={[{ value: 'money', label: 'Cuenta de dinero' }, { value: 'points', label: 'Cuenta de puntos' }]} />
      {isLoading ? <Loading /> : data?.entries.length ? (
        <ul className="mt-3 divide-y divide-[var(--line)]">
          {data.entries.map((e) => (
            <li key={e.id} className="flex items-start gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-bold">{e.note || LEDGER_KIND[e.kind] || e.kind}</p>
                <p className="text-xs muted">{fmtDateTime(e.created_at)}{e.created_by_name ? ` · ${e.created_by_name}` : ''}</p>
              </div>
              <div className="shrink-0 text-right">
                <p className={`num font-extrabold ${e.amount > 0 ? 'text-leaf' : 'text-berry'}`}>{e.amount > 0 ? '+' : '−'}{fmt(Math.abs(e.amount))}</p>
                <p className="num text-xs muted">Saldo {fmt(e.balance_after)}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : <Empty icon={<History />} title="Sin movimientos" />}
    </div>
  );
}

/* ---------- Productos ---------- */

export function LoanProduct({ loan, mine }: { loan: Loan; mine: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const cancel = useMutation({
    mutationFn: () => post(`/loans/${loan.id}/cancel`),
    onSuccess: () => { toast('Petición cancelada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <HandCoins size={18} className="text-tangerine" aria-hidden />
        <span className="flex-1 font-bold">Préstamo de {euros(loan.amount_cents)}</span>
        {loan.status === 'pending' ? <Badge tone="sun">Esperando respuesta</Badge> : <Badge tone="sky">Activo</Badge>}
      </div>
      {loan.status === 'pending' ? (
        <>
          <p className="text-sm muted">A devolver en {loan.weeks} {loan.weeks === 1 ? 'semana' : 'semanas'}.</p>
          {mine ? <Button size="sm" variant="ghost" className="mt-2" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancelar petición</Button> : null}
        </>
      ) : (
        <>
          <Bar value={loan.installments_paid} max={loan.weeks} tone="sky" />
          <p className="mt-2 text-sm">
            Quedan <strong className="num">{loan.remaining_installments}</strong> {loan.remaining_installments === 1 ? 'cuota' : 'cuotas'} de <strong className="num">{euros(loan.installment_cents)}</strong>
            {loan.interest_points ? <> y {loan.interest_points} puntos</> : null}. Faltan por devolver <strong className="num">{euros(loan.remaining_cents)}</strong>.
          </p>
          {loan.next_charge_week ? <p className="text-sm muted">Próximo cobro: lunes {fmtDate(loan.next_charge_week, { day: 'numeric', month: 'long' })}.</p> : null}
        </>
      )}
    </div>
  );
}

/** Una meta de ahorro programado: barra hacia el objetivo, interés ganado y lo que se puede hacer con ella. */
export function GoalProduct({ goal, mine, onDeposit, onRemove }: { goal: Goal; mine: boolean; onDeposit?: (g: Goal) => void; onRemove?: (g: Goal) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [confirm, setConfirm] = useState(false);
  const act = useMutation({
    mutationFn: (what: 'withdraw' | 'redeem' | 'cashout' | 'cancel') =>
      what === 'cancel' ? post(`/goal-requests/${goal.pending_request!.id}/cancel`) : post(`/goals/${goal.id}/${what}`),
    onSuccess: (r, what) => {
      toast({ withdraw: `Sacado: ${euros(r.principal_cents)} vuelven a tu cuenta${r.forfeited_cents ? ` (pierdes ${euros(r.forfeited_cents)} de interés)` : ''}`, redeem: 'Pedido. Un adulto irá contigo a la tienda', cashout: 'Pedido. Un adulto tiene que aprobarlo', cancel: 'Petición cancelada' }[what]);
      setConfirm(false);
      invalidate();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const closed = goal.status !== 'active';
  return (
    <li className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Target size={18} className="shrink-0 text-leaf" aria-hidden />
        <span className="min-w-0 flex-1 font-bold">{goal.title}</span>
        {closed ? <Badge tone="leaf">{goal.status === 'bought' ? `Comprada por ${euros(goal.price_cents ?? 0)}` : 'Pasada a efectivo'}</Badge> : <span className="num text-sm font-bold">{euros(goal.balance_cents)} / {euros(goal.target_cents)}</span>}
      </div>
      {closed ? null : (
        <>
          <Bar value={goal.balance_cents} max={goal.target_cents} tone="leaf" />
          <p className="mt-2 text-sm muted">
            Ahorrado {euros(goal.principal_cents)} · interés ganado <strong className="num text-leaf-deep dark:text-[#7fe0b2]">{euros(goal.interest_cents)}</strong>
            {goal.reached ? ' · ¡Meta alcanzada! Sigue ganando interés hasta que la canjees' : ''}
          </p>
          {mine ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {goal.pending_request ? (
                <>
                  <Badge tone="sun">{goal.pending_request.kind === 'redeem' ? 'Esperando para canjear' : 'Esperando permiso'}</Badge>
                  <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cancel')}>Cancelar</Button>
                </>
              ) : (
                <>
                  <Button size="sm" variant="success" onClick={() => onDeposit?.(goal)}><Plus size={16} /> Meter dinero</Button>
                  {goal.reached ? (
                    <>
                      <Button size="sm" disabled={act.isPending} onClick={() => act.mutate('redeem')}>Canjear meta</Button>
                      <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cashout')}>Pasar a efectivo</Button>
                    </>
                  ) : goal.balance_cents > 0 ? (
                    <Button size="sm" variant="secondary" onClick={() => setConfirm(true)}>Sacar</Button>
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => onRemove?.(goal)}>Quitar meta</Button>
                  )}
                </>
              )}
            </div>
          ) : null}
        </>
      )}
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Sacar mi ahorro" footer={<Button className="w-full" variant="danger" loading={act.isPending} onClick={() => act.mutate('withdraw')}>Sí, sacar mi dinero</Button>}>
        <p>Recuperas <strong className="num">{euros(goal.principal_cents)}</strong> en tu cuenta de dinero.</p>
        {goal.interest_cents > 0 ? <p className="mt-2 font-bold text-berry">Pierdes los {euros(goal.interest_cents)} de interés que has ganado.</p> : null}
        <p className="mt-2 muted">Si esperas a llegar a la meta, conservas el interés.</p>
      </Sheet>
    </li>
  );
}

/* ---------- Hojas de operaciones ---------- */

const eurInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

export function ExchangeSheet({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const a = bank.actions.exchange;
  const [value, setValue] = useState(String(a.max_points));
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const n = Number(value);
  const valid = Number.isInteger(n) && n >= a.min_points && n <= a.max_points;
  const cents = valid ? Math.floor((n * bank.rate.cents) / bank.rate.points) : 0;
  const send = useMutation({
    mutationFn: () => {
      if (!valid) throw new Error(`Escribe entre ${a.min_points} y ${a.max_points} puntos`);
      return post('/bank/exchange', { points: n }, key);
    },
    onSuccess: () => { toast(`Hecho: ${n} puntos por ${euros(cents)}`); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Canjear puntos" footer={<Button className="w-full" variant="success" loading={send.isPending} onClick={() => send.mutate()}>Cambiar por dinero</Button>}>
      <div className="space-y-4">
        <p className="muted">{bank.rate.points} puntos = {euros(bank.rate.cents)}. Mínimo {a.min_points} puntos. Puedes cambiar hasta <strong className="num text-[var(--fg)]">{a.max_points} puntos</strong>{bank.week.remaining_cents != null ? <> (te caben {euros(bank.week.remaining_cents)} esta semana)</> : null}.</p>
        <Field label="¿Cuántos puntos?">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))} />}</Field>
        <p aria-live="polite" className="num rounded-2xl bg-leaf-soft p-3 text-center text-xl font-extrabold text-leaf-deep dark:bg-leaf/15 dark:text-[#7fe0b2]">{valid ? `Recibes ${euros(cents)}` : '—'}</p>
      </div>
    </Sheet>
  );
}

export function AdvanceSheet({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const a = bank.actions.advance;
  const [value, setValue] = useState(eurInput(a.max_cents));
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => {
      const cents = parseEuros(value);
      if (!cents || cents > a.max_cents) throw new Error(`Escribe un importe hasta ${euros(a.max_cents)}`);
      return post('/bank/advance', { cents }, key);
    },
    onSuccess: () => { toast('Adelanto hecho. Un adulto ha sido avisado'); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const cents = parseEuros(value);
  const points = cents ? Math.ceil((cents * bank.rate.points) / bank.rate.cents) : 0;
  return (
    <Sheet open onClose={onClose} title="Adelanto" footer={<Button className="w-full" variant="success" loading={send.isPending} onClick={() => send.mutate()}>Adelantar</Button>}>
      <div className="space-y-4">
        <p className="muted">Cambias puntos que ya tienes por dinero, por encima del tope de esta semana. Ese dinero se resta del tope de la semana que viene. Puedes adelantar hasta <strong className="num text-[var(--fg)]">{euros(a.max_cents)}</strong>.</p>
        <Field label="Importe (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        {cents ? <p className="text-sm muted">Gastas {points} puntos.</p> : null}
      </div>
    </Sheet>
  );
}

export function LoanSheet({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const a = bank.actions.loan;
  const [amount, setAmount] = useState('');
  const [weeks, setWeeks] = useState('4');
  const [note, setNote] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const cents = parseEuros(amount);
  const w = Number(weeks);
  const ok = !!cents && cents <= a.max_cents && Number.isInteger(w) && w >= 1 && w <= a.max_weeks;
  const send = useMutation({
    mutationFn: () => {
      if (!cents || cents > a.max_cents) throw new Error(`Puedes pedir hasta ${euros(a.max_cents)}`);
      if (!ok) throw new Error(`Elige entre 1 y ${a.max_weeks} semanas`);
      return post('/loans', { amountCents: cents, weeks: w, note: note || undefined }, key);
    },
    onSuccess: () => { toast('Petición enviada. Un adulto la verá'); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Pedir un préstamo" footer={<Button className="w-full" loading={send.isPending} onClick={() => send.mutate()}>Pedir préstamo</Button>}>
      <div className="space-y-4">
        <p className="muted">Puedes pedir hasta <strong className="num text-[var(--fg)]">{euros(a.max_cents)}</strong>. Lo devuelves en cuotas cada lunes{a.interest_points ? `, con ${a.interest_points} puntos de interés por semana` : ''}. Si no tienes saldo, la cuenta se queda en negativo y no podrás retirar hasta recuperarla.</p>
        <Field label="¿Cuánto necesitas? (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label={`¿En cuántas semanas lo devuelves? (1 a ${a.max_weeks})`}>{(id) => <input id={id} className="field num" inputMode="numeric" value={weeks} onChange={(e) => setWeeks(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label="¿Para qué es? (opcional)">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />}</Field>
        {ok ? (
          <p aria-live="polite" className="rounded-2xl bg-[var(--chip)] p-3 text-sm">
            Cada lunes pagarás unos <strong className="num">{euros(Math.floor(cents! / w))}</strong>{a.interest_points ? <> y {a.interest_points} puntos</> : null}, durante {w} {w === 1 ? 'semana' : 'semanas'}.
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}

export function SaveSheet({ bank, goals, initialGoal, onClose }: { bank: Bank; goals: Goal[]; initialGoal?: string; onClose: () => void }) {
  const open = goals.filter((g) => g.status === 'active' && !g.pending_request);
  const [goalId, setGoalId] = useState(initialGoal ?? open[0]?.id ?? '');
  const [amount, setAmount] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => {
      const cents = parseEuros(amount);
      if (!cents) throw new Error('Escribe un importe, por ejemplo 2,50');
      if (cents > bank.money_cents) throw new Error(`Solo tienes ${euros(bank.money_cents)} en tu cuenta`);
      return post(`/goals/${goalId}/deposit`, { cents }, key);
    },
    onSuccess: () => { toast('Guardado en tu meta'); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Ahorrar" footer={<Button className="w-full" variant="success" loading={send.isPending} disabled={!goalId} onClick={() => send.mutate()}>Guardar en la meta</Button>}>
      <div className="space-y-4">
        <p className="muted">Pasas dinero de tu cuenta a una meta y gana interés cada lunes. Disponible: <strong className="num text-[var(--fg)]">{euros(bank.money_cents)}</strong>.</p>
        {open.length > 1 ? (
          <div role="radiogroup" aria-label="Meta" className="flex flex-wrap gap-2">
            {open.map((g) => (
              <button key={g.id} type="button" role="radio" aria-checked={goalId === g.id} onClick={() => setGoalId(g.id)}
                className={`inline-flex h-10 items-center rounded-full border px-3.5 text-sm font-bold ${goalId === g.id ? 'border-sky bg-sky/15' : 'border-[var(--line)] bg-[var(--chip)] text-[var(--fg-3)]'}`}>{g.title}</button>
            ))}
          </div>
        ) : open[0] ? <p className="font-bold">{open[0].title}</p> : null}
        <Field label="Importe (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
      </div>
    </Sheet>
  );
}

export function NewGoalSheet({ userId, onClose }: { userId: string; onClose: () => void }) {
  const [goal, setGoal] = useState({ title: '', target: '' });
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const add = useMutation({
    mutationFn: () => {
      const cents = parseEuros(goal.target);
      if (!cents || !goal.title.trim()) throw new Error('Pon un nombre y un importe');
      return post('/goals', { userId, title: goal.title, targetCents: cents });
    },
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Nueva meta" footer={<Button className="w-full" loading={add.isPending} onClick={() => add.mutate()}>Crear meta</Button>}>
      <div className="space-y-4">
        <Field label="¿Para qué ahorras?">{(id) => <input id={id} className="field" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} maxLength={80} />}</Field>
        <Field label="¿Cuánto cuesta? (€)">{(id) => <input id={id} className="field num" inputMode="decimal" value={goal.target} onChange={(e) => setGoal({ ...goal, target: e.target.value })} />}</Field>
      </div>
    </Sheet>
  );
}
