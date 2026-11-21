import { useMemo, useRef, useState, type ReactNode } from 'react';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import {
  ArrowRightLeft, Banknote, CalendarClock, CalendarCheck2, Check, CheckCheck, FastForward, Gift, HandCoins, Handshake, History, Landmark, Lock, Nfc, Percent,
  PiggyBank, Plus, ShoppingBag, SlidersHorizontal, Sparkles, Target, TrendingDown, TrendingUp, Undo2, type LucideIcon,
} from 'lucide-react';
import { api, newKey, post } from '../lib/api';
import { dayKey, euros, fmtDate, fmtTime, fmtWeekdayShort, parseEuros, refCode } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { BalanceHistory, Bank, BankAction, Goal, Loan, StatementEntry, User, Wallet } from '../lib/types';
import { Badge, Button, Empty, Field, Loading, Sheet, useToast } from './ui';
import { AmountSheet, Pips } from './AmountSheet';
import { useReceipt } from './Receipt';

/** Adultos de la familia: a quién avisamos en los recibos. */
function useAdultNotice() {
  const { data } = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const adults = (data?.members ?? []).filter((m) => m.role === 'adult' && m.active);
  const one = adults.length === 1 ? adults[0] : null;
  return {
    who: one ? one.display_name : 'tus padres',
    avatar: one ? { name: one.display_name, avatar: one.avatar, color: one.color } : undefined,
  };
}

/* ---------- Tarjetas de cuenta (carrusel) ---------- */

const RAYS = ['84.6 140.8 6.4 129.8', '88.2 126.9 14.2 99.2', '94.6 114.1 28.4 71.0', '103.7 102.9 48.4 46.6', '115.0 94.0 73.2 27.0', '128.0 87.8 101.6 13.3'];

/** Rayos del sol de la marca en la esquina de la tarjeta. */
function Rays({ color, opacity }: { color: string; opacity: number }) {
  return (
    <svg className="acct-rays" viewBox="0 0 150 150" width="150" height="150" aria-hidden stroke={color} strokeOpacity={opacity} strokeWidth="3" strokeLinecap="round">
      {RAYS.map((r) => {
        const [x1, y1, x2, y2] = r.split(' ');
        return <line key={r} x1={x1} y1={y1} x2={x2} y2={y2} />;
      })}
    </svg>
  );
}

/** Una tarjeta de cuenta. El número de cuenta es de juguete (sale del identificador del usuario). */
export function AccountCard({ tone, title, number, children, foot }: { tone: 'money' | 'points'; title: string; number: string; children: ReactNode; foot?: ReactNode }) {
  const money = tone === 'money';
  return (
    <section aria-label={title} className={`acct ${money ? 'acct-money' : 'acct-pts'}`}>
      {money ? <Rays color="#ffb800" opacity={0.35} /> : <Rays color="#fff" opacity={0.5} />}
      <div className="flex items-center justify-between text-sm font-bold">
        <span className="flex items-center gap-2"><Landmark size={18} aria-hidden /> DiploP · {title}</span>
        <Nfc size={22} aria-hidden className="opacity-80" />
      </div>
      <p className="num mt-3 text-sm font-medium tracking-[0.14em] opacity-85" aria-label={`Número de cuenta ${number}`}>{number}</p>
      <p className="num mt-auto flex items-baseline gap-1.5 text-[2.75rem] leading-none font-extrabold">{children}</p>
      <p className="mt-2.5 flex min-h-6 items-center gap-1.5 text-[0.8rem] opacity-95">{foot}</p>
    </section>
  );
}

/** Cuenta de dinero y cuenta de puntos en un carrusel con puntos indicadores. Con espacio para las dos, se ven juntas. */
export function AccountRail({ bank, wallet }: { bank: Bank; wallet: Wallet }) {
  const rail = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const cards = ['Cuenta de dinero', 'Cuenta de puntos'];
  const onScroll = () => {
    const el = rail.current;
    if (!el || el.children.length < 2) return;
    const step = (el.children[1] as HTMLElement).offsetLeft - (el.children[0] as HTMLElement).offsetLeft;
    setIndex(el.scrollLeft > step / 2 ? 1 : 0);
  };
  const go = (i: number) => {
    const el = rail.current;
    if (!el) return;
    const step = (el.children[1] as HTMLElement).offsetLeft - (el.children[0] as HTMLElement).offsetLeft;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo({ left: i * step, behavior: reduce ? 'auto' : 'smooth' });
  };
  const wd = bank.history.week_delta_cents;
  const negative = bank.money_cents < 0;
  return (
    <div>
      <div
        ref={rail}
        onScroll={onScroll}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
          if (e.key === 'ArrowLeft') { e.preventDefault(); go(0); }
        }}
        role="group"
        aria-roledescription="carrusel"
        aria-label="Mis cuentas"
        tabIndex={0}
        className="rail"
      >
        <AccountCard
          tone="money" title="Cuenta de dinero" number={bank.accounts.money}
          foot={wd !== 0 ? <><b className="num rounded-full bg-white/16 px-2.5 py-px">{wd > 0 ? '+' : '−'}{euros(Math.abs(wd))}</b> esta semana</> : <>Sin cambios esta semana</>}
        >
          <span className={negative ? 'text-[#ffb3c7]' : ''}>{euros(bank.money_cents).replace(/\s?€/, '')}</span>
          <small className="text-xl font-bold">€</small>
        </AccountCard>
        <AccountCard tone="points" title="Cuenta de puntos" number={bank.accounts.points} foot={<>≈ {euros(wallet.points_value_cents)} por convertir</>}>
          <span className={bank.points < 0 ? 'text-berry' : ''}>{bank.points}</span>
          <small className="text-xl font-bold">pts</small>
        </AccountCard>
      </div>
      <div className="flex justify-center gap-1 pt-1 md:hidden" role="group" aria-label="Elegir cuenta">
        {cards.map((c, i) => (
          <button key={c} type="button" aria-label={c} aria-current={index === i} onClick={() => go(i)} className="flex size-6 items-center justify-center rounded-full">
            <i className={`block h-1.5 rounded-full transition-all duration-300 ${index === i ? 'w-5 bg-tangerine' : 'w-1.5 bg-[#c3cde0] dark:bg-[#3a4a6e]'}`} />
          </button>
        ))}
      </div>
    </div>
  );
}

/* ---------- Botones redondos ---------- */

export type AtmKey = 'withdraw' | 'exchange' | 'advance' | 'loan' | 'save';
const ATM: { key: AtmKey; label: string; icon: LucideIcon }[] = [
  { key: 'withdraw', label: 'Retirar', icon: Banknote },
  { key: 'exchange', label: 'Canjear', icon: ArrowRightLeft },
  { key: 'advance', label: 'Adelanto', icon: FastForward },
  { key: 'loan', label: 'Préstamo', icon: HandCoins },
  { key: 'save', label: 'Ahorrar', icon: PiggyBank },
];

/** Cinco acciones redondas. Las no disponibles se quedan con un candado y una pista corta; el motivo completo sale al tocarlas. */
export function AtmButtons({ bank, onPick }: { bank: Bank; onPick: (k: AtmKey) => void }) {
  const toast = useToast();
  return (
    <div role="group" aria-label="Operaciones" className="grid grid-cols-5 gap-1 pt-3.5">
      {ATM.map((a) => {
        const act: BankAction = bank.actions[a.key];
        const Icon = a.icon;
        return (
          <button
            key={a.key}
            type="button"
            aria-disabled={!act.ok}
            title={act.reason ?? undefined}
            onClick={() => (act.ok ? onPick(a.key) : toast(act.reason ?? 'Ahora no está disponible', 'error'))}
            className="group flex min-w-0 flex-col items-center gap-[7px] text-center"
          >
            <span className={`flex size-12 min-[360px]:size-14 items-center justify-center rounded-full border transition group-active:scale-[0.94] ${act.ok ? 'border-[var(--line)] bg-[var(--card)] text-tangerine shadow-[var(--shadow-lift)] group-hover:border-tangerine' : 'border-transparent bg-[var(--chip)] text-[var(--fg-3)]'}`}>
              <Icon size={24} aria-hidden />
            </span>
            <b className={`max-w-full truncate text-[0.72rem] min-[360px]:text-[0.8rem] leading-tight ${act.ok ? '' : 'text-[var(--fg-3)]'}`}>{a.label}</b>
            {!act.ok ? (
              <span className="-mt-1 flex max-w-full items-start justify-center gap-0.5 text-[0.7rem] leading-tight font-bold text-[var(--fg-3)]">
                <Lock size={11} aria-hidden className="mt-px shrink-0" />
                <span aria-hidden>{act.hint ?? 'No disponible'}</span>
                <span className="sr-only">No disponible: {act.reason}</span>
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Gráfica del saldo ---------- */

/** Curva suave entre los puntos (un tramo cúbico por segmento). */
function smoothPath(pts: [number, number][]) {
  return pts.reduce((d, [x, y], i) => {
    if (i === 0) return `M${x} ${y}`;
    const [px, py] = pts[i - 1];
    const mx = (px + x) / 2;
    return `${d} C${mx} ${py},${mx} ${y},${x} ${y}`;
  }, '');
}

/** «Tu saldo»: línea del dinero de las últimas 8 semanas, dibujada a mano en SVG (sin librería de gráficos). */
export function BalanceTrend({ history }: { history: BalanceHistory }) {
  const { weeks, delta_cents: delta } = history;
  const W = 311, H = 64, padX = 6, padY = 10;
  const values = weeks.map((w) => w.balance_cents);
  const lo = Math.min(...values, history.start_cents);
  const hi = Math.max(...values, history.start_cents);
  const span = hi - lo || 1;
  const pts: [number, number][] = values.map((v, i) => [padX + (i * (W - padX * 2)) / Math.max(1, values.length - 1), hi === lo ? H / 2 : padY + (1 - (v - lo) / span) * (H - padY * 2)]);
  const line = smoothPath(pts);
  const last = pts[pts.length - 1];
  const up = delta >= 0;
  return (
    <div className="card px-4 pt-3.5 pb-3">
      <header className="mb-2.5 flex items-center justify-between">
        <b className="font-display text-base">Tu saldo</b>
        <span className={`num inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${delta === 0 ? 'bg-[var(--chip)] text-[var(--fg-2)]' : up ? 'bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]' : 'bg-berry-soft text-berry dark:bg-berry/20 dark:text-[#ff9dbf]'}`}>
          {delta === 0 ? null : up ? <TrendingUp size={14} aria-hidden /> : <TrendingDown size={14} aria-hidden />}
          {delta === 0 ? 'Sin cambios en 8 semanas' : `${up ? '+' : '−'}${euros(Math.abs(delta))} en 8 semanas`}
        </span>
      </header>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" preserveAspectRatio="none" className="block overflow-visible"
          aria-label={`Saldo de las últimas 8 semanas: de ${euros(history.start_cents)} a ${euros(values[values.length - 1] ?? 0)}`}>
          <defs>
            <linearGradient id="trend-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#1d5fae" stopOpacity=".22" />
              <stop offset="1" stopColor="#1d5fae" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={`${line} L${last[0]} ${H} L${pts[0][0]} ${H} Z`} fill="url(#trend-fill)" />
          <path d={line} fill="none" stroke="var(--color-tangerine)" strokeWidth="2.5" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
        </svg>
        {/* El punto final es HTML: dentro del SVG estirado se aplastaría. */}
        <span aria-hidden className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-[2.5px] border-tangerine bg-[var(--card)]" style={{ left: `${(last[0] / W) * 100}%`, top: `${(last[1] / H) * 100}%` }} />
      </div>
      <div className="mt-1.5 flex justify-between text-xs muted">
        <span>{fmtDate(weeks[0].week_start)}</span>
        <span>Hoy</span>
      </div>
    </div>
  );
}

/* ---------- Productos ---------- */

/** Cuotas del préstamo como tramos: pagadas en verde, la próxima con borde de sol. Con muchas semanas, una barra. */
function Steps({ paid, total }: { paid: number; total: number }) {
  if (total > 16) {
    return <div className="h-2 overflow-hidden rounded-full bg-[var(--chip)]" role="img" aria-label={`${paid} de ${total} cuotas pagadas`}><i className="block h-full rounded-full bg-leaf" style={{ width: `${(paid / total) * 100}%` }} /></div>;
  }
  return (
    <div role="img" aria-label={`${paid} de ${total} cuotas pagadas`} className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${total}, 1fr)` }}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={`h-2 rounded-full ${i < paid ? 'bg-leaf' : i === paid ? 'bg-sun-soft shadow-[inset_0_0_0_2px_var(--color-sun)]' : 'bg-[var(--chip)]'}`} />
      ))}
    </div>
  );
}

const instLabel = (n: number) => (n === 1 ? 'cuota' : 'cuotas');

export function LoanProduct({ loan, mine, compact = false }: { loan: Loan; mine: boolean; compact?: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const cancel = useMutation({
    mutationFn: () => post(`/loans/${loan.id}/cancel`),
    onSuccess: () => { toast('Petición cancelada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const pending = loan.status === 'pending';
  const interest = loan.interest_points ? <> + {loan.interest_points} pts</> : null;
  if (compact) {
    return (
      <div className="rounded-[1.1rem] border border-[var(--line)] p-3">
        <div className="flex items-center gap-2.5 font-bold">
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-sky-soft text-[#2a5fc2] dark:bg-sky/20 dark:text-[#a9c7ff]"><HandCoins size={18} aria-hidden /></span>
          Préstamo
          {pending ? <Badge tone="sun">Esperando respuesta</Badge> : <Badge tone="tangerine">Activo</Badge>}
          <span className="num ml-auto text-base">{euros(pending ? loan.amount_cents : loan.remaining_cents)}</span>
        </div>
        {pending ? <p className="mt-1.5 text-sm text-[var(--fg-2)]">Pide {euros(loan.amount_cents)} a {loan.weeks} {loan.weeks === 1 ? 'semana' : 'semanas'}.</p> : (
          <>
            <div className="mt-2.5"><Steps paid={loan.installments_paid} total={loan.weeks} /></div>
            <p className="mt-1.5 text-sm text-[var(--fg-2)]">
              Quedan <b className="text-[var(--fg)]">{loan.remaining_installments} {instLabel(loan.remaining_installments)}</b> de <b className="num text-[var(--fg)]">{euros(loan.installment_cents)}</b>{interest}
              {loan.next_charge_week ? <> · cobro <b className="text-[var(--fg)]">{fmtWeekdayShort(loan.next_charge_week)}</b></> : null}
            </p>
          </>
        )}
      </div>
    );
  }
  return (
    <article className="card p-4" aria-label="Mi préstamo">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-soft text-[#2a5fc2] dark:bg-sky/20 dark:text-[#a9c7ff]"><HandCoins size={22} aria-hidden /></span>
        <h3 className="flex-1 text-[1.05rem]">Mi préstamo</h3>
        {pending ? <Badge tone="sun">Esperando respuesta</Badge> : <Badge tone="tangerine">Activo</Badge>}
      </div>
      <p className="num mt-3 flex items-baseline gap-2 text-[1.75rem] font-extrabold">
        {euros(pending ? loan.amount_cents : loan.remaining_cents)}
        <small className="font-sans text-[0.8rem] font-normal tracking-normal text-[var(--fg-2)]">{pending ? 'pedidos' : 'por devolver'}</small>
      </p>
      {pending ? (
        <>
          <p className="mt-2 text-sm text-[var(--fg-2)]">A devolver en {loan.weeks} {loan.weeks === 1 ? 'semana' : 'semanas'}.</p>
          {mine ? <Button size="sm" variant="secondary" className="mt-3" disabled={cancel.isPending} onClick={() => cancel.mutate()}>Cancelar petición</Button> : null}
        </>
      ) : (
        <>
          <div className="my-3"><Steps paid={loan.installments_paid} total={loan.weeks} /></div>
          <p className="text-sm text-[var(--fg-2)]">
            Quedan <b className="text-[var(--fg)]">{loan.remaining_installments} {instLabel(loan.remaining_installments)}</b> de <b className="num text-[var(--fg)]">{euros(loan.installment_cents)}</b>{interest}
          </p>
          {loan.next_charge_week ? (
            <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--line)] pt-3 text-sm">
              <span className="text-[var(--fg-2)]">Próximo cobro</span>
              <b>{fmtWeekdayShort(loan.next_charge_week)}</b>
            </div>
          ) : null}
        </>
      )}
    </article>
  );
}

const pct = (g: Goal) => (g.target_cents > 0 ? Math.min(100, Math.floor((g.balance_cents / g.target_cents) * 100)) : 0);

/** Una meta de ahorro programado: progreso, interés ganado y lo que se puede hacer con ella. */
export function GoalProduct({ goal, mine, compact = false, onDeposit, onRemove }: { goal: Goal; mine: boolean; compact?: boolean; onDeposit?: (g: Goal) => void; onRemove?: (g: Goal) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const notice = useAdultNotice();
  const [confirm, setConfirm] = useState(false);
  const act = useMutation({
    mutationFn: (what: 'withdraw' | 'redeem' | 'cashout' | 'cancel') =>
      what === 'cancel' ? post(`/goal-requests/${goal.pending_request!.id}/cancel`) : post(`/goals/${goal.id}/${what}`),
    onSuccess: (r, what) => {
      invalidate();
      setConfirm(false);
      const at = new Date();
      if (what === 'cancel') toast('Petición cancelada');
      else if (what === 'withdraw') {
        showReceipt({
          title: 'Ahorro sacado', amount: `+${euros(r.principal_cents)}`, at, ref: refCode('SA', goal.id),
          rows: [{ label: 'Desde', value: `Meta ${goal.title}` }, { label: 'A', value: 'Cuenta de dinero' }, { label: 'Interés perdido', value: euros(r.forfeited_cents) }],
          notice: { title: 'Tu dinero vuelve a tu cuenta.', sub: r.forfeited_cents ? `Pierdes ${euros(r.forfeited_cents)} de interés.` : undefined },
        });
      } else {
        const redeem = what === 'redeem';
        showReceipt({
          title: redeem ? 'Meta pedida' : 'Paso a efectivo pedido', badge: 'Esperando a un adulto', amount: euros(goal.balance_cents), at, ref: refCode(redeem ? 'MT' : 'EF', r.request.id),
          rows: [{ label: 'Meta', value: goal.title }, { label: 'Ahorrado', value: euros(goal.balance_cents) }],
          notice: { title: redeem ? `Avisamos a ${notice.who}.` : `Avisamos a ${notice.who} para que lo apruebe.`, sub: redeem ? 'Irá contigo a la tienda.' : 'Pierdes el interés ganado.', avatar: notice.avatar },
        });
      }
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const closed = goal.status !== 'active';
  const p = pct(goal);

  if (closed) {
    return (
      <li className="card flex flex-wrap items-center gap-2 p-3.5">
        <Target size={18} className="shrink-0 text-leaf" aria-hidden />
        <span className="min-w-0 flex-1 font-bold">{goal.title}</span>
        <Badge tone="leaf">{goal.status === 'bought' ? `Comprada por ${euros(goal.price_cents ?? 0)}` : 'Pasada a efectivo'}</Badge>
      </li>
    );
  }
  if (compact) {
    return (
      <li className="rounded-[1.1rem] border border-[var(--line)] p-3">
        <div className="flex items-center gap-2.5 font-bold">
          <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[11px] bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]"><Target size={18} aria-hidden /></span>
          <span className="min-w-0 truncate">Ahorros · {goal.title}</span>
          <span className="num ml-auto shrink-0 text-base">{euros(goal.balance_cents)}{goal.reached ? '' : <small className="font-sans text-[0.8rem] font-normal text-[var(--fg-3)]"> / {euros(goal.target_cents)}</small>}</span>
        </div>
        <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-[var(--chip)]"><i className="block h-full rounded-full bg-gradient-to-r from-leaf to-[#38c28a]" style={{ width: `${p}%` }} /></div>
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--fg-2)]">
          {goal.reached ? <span className="inline-flex items-center gap-1 rounded-full bg-leaf-soft px-2.5 py-0.5 text-xs font-bold text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]"><Check size={13} aria-hidden /> Meta alcanzada</span> : null}
          Interés ganado <b className="num text-leaf-deep dark:text-[#7fe0b2]">{euros(goal.interest_cents)}</b>
        </p>
      </li>
    );
  }
  return (
    <li className="card p-4" aria-label={`Meta ${goal.title}`}>
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]"><Target size={22} aria-hidden /></span>
        <h3 className="min-w-0 flex-1 text-[1.05rem]">Mis ahorros · {goal.title}</h3>
        {mine && !goal.pending_request ? (
          <button type="button" onClick={() => onDeposit?.(goal)} aria-label={`Meter dinero en ${goal.title}`} title="Meter dinero" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-leaf-soft text-leaf-deep transition active:scale-95 dark:bg-leaf/20 dark:text-[#7fe0b2]"><Plus size={20} aria-hidden /></button>
        ) : null}
      </div>
      <p className="num mt-3 flex items-baseline gap-2 text-[1.75rem] font-extrabold">
        {euros(goal.balance_cents)} <small className="font-sans text-[0.8rem] font-normal tracking-normal text-[var(--fg-2)]">de {euros(goal.target_cents)}</small>
      </p>
      <div className="my-3 h-2.5 overflow-hidden rounded-full bg-[var(--chip)]" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={`Meta ${goal.title}`}>
        <i className="block h-full rounded-full bg-gradient-to-r from-leaf to-[#38c28a] transition-[width] duration-700" style={{ width: `${p}%` }} />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-leaf-soft px-2.5 py-0.5 text-xs font-bold text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]">
          <Sparkles size={13} aria-hidden /> Interés ganado <span className="num">+{euros(goal.interest_cents)}</span>
        </span>
        <span className="num text-sm text-[var(--fg-2)]">{p} %</span>
      </div>
      {goal.reached ? <p className="mt-2 text-sm text-[var(--fg-2)]">¡Meta alcanzada! Sigue ganando interés hasta que la canjees.</p> : null}
      {mine ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[var(--line)] pt-3 text-sm">
          {goal.pending_request ? (
            <>
              <Badge tone="sun">{goal.pending_request.kind === 'redeem' ? 'Esperando para canjear' : 'Esperando permiso'}</Badge>
              <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cancel')}>Cancelar</Button>
            </>
          ) : (
            <>
              <button
                type="button"
                aria-disabled={!goal.reached}
                disabled={act.isPending}
                onClick={() => (goal.reached ? act.mutate('redeem') : toast(`Podrás canjearla al llegar a ${euros(goal.target_cents)}`))}
                className={`inline-flex min-h-9 items-center gap-1.5 font-bold ${goal.reached ? 'text-tangerine' : 'text-[var(--fg-3)]'}`}
              >
                <ShoppingBag size={18} aria-hidden /> Canjear meta
                {goal.reached ? null : <small className="font-normal">· al llegar a {euros(goal.target_cents)}</small>}
              </button>
              {goal.reached ? (
                <Button size="sm" variant="ghost" disabled={act.isPending} onClick={() => act.mutate('cashout')}>Pasar a efectivo</Button>
              ) : goal.balance_cents > 0 ? (
                <Button size="sm" variant="secondary" onClick={() => setConfirm(true)}>Sacar</Button>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => onRemove?.(goal)}>Quitar meta</Button>
              )}
            </>
          )}
        </div>
      ) : null}
      <Sheet open={confirm} onClose={() => setConfirm(false)} title="Sacar mi ahorro" footer={<Button className="w-full" variant="danger" loading={act.isPending} onClick={() => act.mutate('withdraw')}>Sí, sacar mi dinero</Button>}>
        <p>Recuperas <strong className="num">{euros(goal.principal_cents)}</strong> en tu cuenta de dinero.</p>
        {goal.interest_cents > 0 ? <p className="mt-2 font-bold text-berry">Pierdes los {euros(goal.interest_cents)} de interés que has ganado.</p> : null}
        <p className="mt-2 muted">Si esperas a llegar a la meta, conservas el interés.</p>
      </Sheet>
    </li>
  );
}

/* ---------- Extracto ---------- */

type Tone = 'brand' | 'sun' | 'berry' | 'sky' | 'leaf' | 'chip';
const TONES: Record<Tone, string> = {
  brand: 'bg-tangerine-soft text-tangerine dark:bg-tangerine/20',
  sun: 'bg-sun-soft text-sun-ink dark:bg-sun/20 dark:text-[#ffd979]',
  berry: 'bg-berry-soft text-[#a8214f] dark:bg-berry/20 dark:text-[#ff9dbf]',
  sky: 'bg-sky-soft text-[#2a5fc2] dark:bg-sky/20 dark:text-[#a9c7ff]',
  leaf: 'bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]',
  chip: 'bg-[var(--chip)] text-[var(--fg-2)]',
};
const METHOD: Record<string, string> = { cash: 'En mano', transfer: 'Transferencia', bizum: 'Bizum', other: 'Otro' };

/** Icono, color y título de cada tipo de movimiento. */
function describe(e: StatementEntry): { icon: LucideIcon; tone: Tone; title: string } {
  const note = e.note.trim();
  const by = e.created_by_name ?? 'un adulto';
  switch (e.kind) {
    case 'task': return { icon: CheckCheck, tone: 'brand', title: note || 'Tarea' };
    case 'bonus': return { icon: Gift, tone: 'sun', title: note || 'Extra' };
    case 'redemption': return { icon: Gift, tone: 'sky', title: note || 'Recompensa' };
    case 'refund': return { icon: Undo2, tone: 'chip', title: note || 'Devolución' };
    case 'adjustment': return { icon: SlidersHorizontal, tone: 'chip', title: note || 'Ajuste' };
    case 'conversion': return { icon: CalendarCheck2, tone: 'leaf', title: note || 'Cierre del periodo' };
    case 'exchange': return { icon: ArrowRightLeft, tone: 'sun', title: note || 'Canje' };
    case 'advance': return { icon: FastForward, tone: 'sun', title: 'Adelanto' };
    case 'loan': return { icon: HandCoins, tone: 'sky', title: 'Préstamo aprobado' };
    case 'loan_repayment': return { icon: CalendarClock, tone: 'sky', title: note || 'Cuota del préstamo' };
    case 'loan_interest': return { icon: Percent, tone: 'sky', title: note || 'Interés del préstamo' };
    case 'interest': return { icon: TrendingUp, tone: 'leaf', title: note || 'Interés' };
    case 'interest_forfeit': return { icon: TrendingDown, tone: 'berry', title: note || 'Interés perdido' };
    case 'goal_redeem': return { icon: ShoppingBag, tone: 'sun', title: note || 'Compra de meta' };
    case 'transfer': return { icon: PiggyBank, tone: 'leaf', title: note.startsWith('Ahorro:') ? `Ahorro en ${note.slice(7).trim()}` : note || 'Ahorro' };
    case 'payment': return e.is_withdrawal ? { icon: Banknote, tone: 'berry', title: 'Retiro' } : { icon: Handshake, tone: 'chip', title: `Pago de ${by}` };
    default: return { icon: History, tone: 'chip', title: note || e.kind };
  }
}

function subtitle(e: StatementEntry, tz: string, viewer: string) {
  const t = fmtTime(e.created_at, tz);
  const by = e.created_by_name;
  const mine = !!by && by === viewer;
  switch (e.kind) {
    case 'task': return `${t} · ${!by ? 'automática' : mine ? 'tú' : `validada por ${by}`}`;
    case 'payment': return e.is_withdrawal ? `${t} · pagado por ${by ?? 'un adulto'}` : `${e.method ? METHOD[e.method] : 'Pago'} · ${t}`;
    case 'interest': case 'interest_forfeit': return `${t} · va a tu meta`;
    case 'loan': return `${t} · ${by ?? 'un adulto'}`;
    default: return `${t}${by ? ` · ${mine ? 'tú' : by}` : ''}`;
  }
}

const TABS: { value: 'all' | 'money' | 'points'; label: string }[] = [{ value: 'all', label: 'Todo' }, { value: 'money', label: 'Dinero' }, { value: 'points', label: 'Puntos' }];
const PAGE = 15;

function dayLabel(key: string, today: string, yesterday: string) {
  if (key === today) return 'Hoy';
  if (key === yesterday) return 'Ayer';
  return fmtDate(key);
}

/**
 * Extracto: pestañas Todo/Dinero/Puntos, movimientos agrupados por día (zona de la familia), un icono por tipo,
 * importe en verde o rojo y saldo tras cada movimiento. Arriba, la próxima cuota programada del préstamo.
 */
export function Statement({ userId, loan }: { userId: string; loan?: Loan | null }) {
  const { user, family } = useSession();
  const tz = family.timezone;
  const [tab, setTab] = useState<'all' | 'money' | 'points'>('all');
  const q = useInfiniteQuery({
    queryKey: ['statement', userId, tab],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<{ entries: StatementEntry[]; has_more: boolean }>(`/statement/${userId}?account=${tab}&limit=${PAGE}&offset=${pageParam}`),
    getNextPageParam: (last, all) => (last.has_more ? all.length * PAGE : undefined),
  });
  const entries = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const now = new Date();
  const today = dayKey(now.toISOString(), tz);
  const yesterday = dayKey(new Date(now.getTime() - 86_400_000).toISOString(), tz);
  const groups = useMemo(() => {
    const out: { key: string; items: StatementEntry[] }[] = [];
    for (const e of entries) {
      const k = dayKey(e.created_at, tz);
      const g = out[out.length - 1];
      if (g?.key === k) g.items.push(e);
      else out.push({ key: k, items: [e] });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, tz]);
  const planned = tab !== 'points' && loan?.status === 'active' && loan.next_charge_week && loan.remaining_installments > 0 ? loan : null;
  const fmt = (e: StatementEntry, n: number) => (e.account === 'points' ? `${n} pts` : euros(n));

  return (
    <div>
      <div role="tablist" aria-label="Qué ver en el extracto" className="mb-1.5 flex gap-2 overflow-x-auto">
        {TABS.map((t) => (
          <button key={t.value} type="button" role="tab" aria-selected={tab === t.value} onClick={() => setTab(t.value)}
            className={`h-9 shrink-0 rounded-full px-4 text-sm font-bold transition ${tab === t.value ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-[var(--chip)] text-[var(--fg-2)]'}`}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="card px-4 pt-1.5 pb-2" role="tabpanel">
        {q.isLoading ? <Loading /> : !entries.length && !planned ? <Empty icon={<History />} title="Sin movimientos" /> : (
          <>
            {planned ? (
              <section aria-label="Próximo">
                <h3 className="flex items-baseline justify-between pt-3.5 pb-1 text-[0.95rem]">Próximo <small className="font-sans text-[0.8rem] font-normal tracking-normal text-[var(--fg-3)]">{fmtWeekdayShort(planned.next_charge_week!)}</small></h3>
                <ul>
                  <li className="grid grid-cols-[40px_1fr_auto] items-center gap-3 py-2.5 opacity-90">
                    <span className="flex size-10 items-center justify-center rounded-full text-sky ring-[1.5px] ring-[var(--line)] ring-inset"><CalendarClock size={20} aria-hidden /></span>
                    <div><b className="block leading-tight">Cuota {planned.installments_paid + 1} de {planned.weeks}</b><small className="text-[0.8rem] text-[var(--fg-3)]">Préstamo · programada</small></div>
                    <div className="text-right"><b className="num block text-[#c0245d] dark:text-[#ff9dbf]">−{euros(planned.installment_cents)}</b>{planned.interest_points ? <small className="text-[0.8rem] text-[var(--fg-3)]">+ {planned.interest_points} pts de interés</small> : null}</div>
                  </li>
                </ul>
              </section>
            ) : null}
            {groups.map((g) => (
              <section key={g.key} aria-label={dayLabel(g.key, today, yesterday)}>
                <h3 className="pt-3.5 pb-1 text-[0.95rem]">{dayLabel(g.key, today, yesterday)}</h3>
                <ul className="divide-y divide-[var(--line)]">
                  {g.items.map((e) => {
                    const d = describe(e);
                    const Icon = d.icon;
                    return (
                      <li key={`${e.account}-${e.id}`} className="grid grid-cols-[40px_1fr_auto] items-center gap-3 py-2.5">
                        <span className={`flex size-10 items-center justify-center rounded-full ${TONES[d.tone]}`}><Icon size={20} aria-hidden /></span>
                        <div className="min-w-0">
                          <b className="block leading-tight">{d.title}</b>
                          <small className="text-[0.8rem] text-[var(--fg-3)]">{subtitle(e, tz, user.display_name)}</small>
                        </div>
                        <div className="text-right">
                          <b className={`num block ${e.amount > 0 ? 'text-leaf-deep dark:text-[#7fe0b2]' : 'text-[#c0245d] dark:text-[#ff9dbf]'}`}>{e.amount > 0 ? '+' : '−'}{fmt(e, Math.abs(e.amount))}</b>
                          <small className="num text-[0.8rem] text-[var(--fg-3)]">{e.scope === 'goal' ? 'Meta' : 'Saldo'} {fmt(e, e.balance_after)}</small>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
            {q.hasNextPage ? (
              <div className="flex justify-center pt-3 pb-1.5">
                <Button size="sm" variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>{q.data && q.data.pages.length > 1 ? 'Ver más' : 'Ver extracto completo'}</Button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------- Operaciones del hijo (hoja de importe + recibo) ---------- */

const sinceNow = () => new Date();

/** Retiro (como en un cajero): el hijo saca hasta todo su saldo y un adulto se lo paga. */
export function WithdrawSheet({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const a = bank.actions.withdraw;
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const notice = useAdultNotice();
  const [error, setError] = useState('');
  const send = useMutation({
    mutationFn: (cents: number) => post('/payout-requests', { kind: 'money', amountCents: cents }, key).then((r) => ({ r, cents })),
    onSuccess: ({ r, cents }) => {
      invalidate();
      onClose();
      showReceipt({
        title: 'Retiro solicitado', badge: 'Pendiente de pago', amount: `−${euros(cents)}`, at: new Date(r.request.created_at ?? sinceNow()), ref: refCode('RT', r.request.id),
        rows: [{ label: 'Desde', value: 'Cuenta de dinero', sub: bank.accounts.money }, { label: 'Importe', value: euros(cents) }],
        total: { label: 'Te quedarán', value: euros(bank.money_cents - cents) },
        notice: { title: `Avisamos a ${notice.who} para que te ${notice.who === "tus padres" ? "paguen" : "pague"}.`, sub: `Retiros esta semana: ${bank.week.withdrawals_used + 1} de ${bank.week.withdrawals_max}`, avatar: notice.avatar },
      });
    },
    onError: (e: Error) => { setError(e.message); toast(e.message, 'error'); },
  });
  return (
    <AmountSheet
      title="Retirar dinero" subtitle={<>Disponible: <b className="text-[var(--fg)]">{euros(bank.money_cents)}</b></>}
      unit="eur" max={a.max_cents} chips={[500, 1000]}
      after={(v) => <>Te quedarán {euros(bank.money_cents - v)}</>}
      info={<><Pips used={bank.week.withdrawals_used} total={bank.week.withdrawals_max} /> Retiros esta semana: <b className="text-[var(--fg)]">{bank.week.withdrawals_used} de {bank.week.withdrawals_max}</b></>}
      overReason={(m) => `Solo tienes ${euros(m)} en tu cuenta`}
      cta={(v) => (v ? `Retirar ${euros(v)}` : 'Retirar')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

export function ExchangeSheet({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const a = bank.actions.exchange;
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const [error, setError] = useState('');
  const cents = (n: number) => Math.floor((n * bank.rate.cents) / bank.rate.points);
  const send = useMutation({
    mutationFn: (points: number) => post('/bank/exchange', { points }, key).then((r) => ({ r, points })),
    onSuccess: ({ r, points }) => {
      invalidate();
      onClose();
      const c = cents(points);
      showReceipt({
        title: 'Canje hecho', amount: `+${euros(c)}`, at: new Date(r.exchange.created_at ?? sinceNow()), ref: refCode('CJ', r.exchange.id),
        rows: [{ label: 'Desde', value: 'Cuenta de puntos', sub: bank.accounts.points }, { label: 'Puntos canjeados', value: `${points} pts` }, { label: 'Cambio', value: `${bank.rate.points} pts = ${euros(bank.rate.cents)}` }],
        total: { label: 'Saldo nuevo', value: euros(bank.money_cents + c) },
        notice: { title: 'Ya está en tu cuenta de dinero.', sub: `Te quedan ${bank.points - points} pts` },
      });
    },
    onError: (e: Error) => { setError(e.message); toast(e.message, 'error'); },
  });
  return (
    <AmountSheet
      title="Canjear puntos" subtitle={<>Tienes <b className="text-[var(--fg)]">{bank.points} pts</b></>}
      unit="pts" max={a.max_points} min={a.min_points} chips={[50, 100]} variant="success"
      after={(v) => <>Recibes <b className="num text-leaf-deep dark:text-[#7fe0b2]">{euros(cents(v))}</b></>}
      info={<span className="text-center">{bank.rate.points} pts = {euros(bank.rate.cents)}{bank.week.remaining_cents != null ? <> · esta semana te caben {euros(bank.week.remaining_cents)}</> : null}</span>}
      overReason={(m) => `Puedes canjear hasta ${m} pts`} underReason={(m) => `El mínimo son ${m} pts`}
      cta={(v) => (v ? `Canjear ${v} pts` : 'Canjear')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

export function AdvanceSheet({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const a = bank.actions.advance;
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const notice = useAdultNotice();
  const [error, setError] = useState('');
  const points = (c: number) => Math.ceil((c * bank.rate.points) / bank.rate.cents);
  const send = useMutation({
    mutationFn: (cents: number) => post('/bank/advance', { cents }, key).then((r) => ({ r, cents })),
    onSuccess: ({ r, cents }) => {
      invalidate();
      onClose();
      showReceipt({
        title: 'Adelanto hecho', amount: `+${euros(cents)}`, at: new Date(r.advance.created_at ?? sinceNow()), ref: refCode('AD', r.advance.id),
        rows: [{ label: 'Desde', value: 'Cuenta de puntos', sub: bank.accounts.points }, { label: 'Puntos gastados', value: `${points(cents)} pts` }, { label: 'Importe', value: euros(cents) }],
        total: { label: 'Saldo nuevo', value: euros(bank.money_cents + cents) },
        notice: { title: `Avisamos a ${notice.who}.`, sub: `La semana que viene tu tope baja ${euros(cents)}.`, avatar: notice.avatar },
      });
    },
    onError: (e: Error) => { setError(e.message); toast(e.message, 'error'); },
  });
  return (
    <AmountSheet
      title="Adelanto" subtitle="Puntos que ya tienes, por encima del tope de esta semana"
      unit="eur" max={a.max_cents} chips={[500]} variant="success"
      after={(v) => <>Gastas {points(v)} pts</>}
      info={<span className="text-center">Se resta del tope de la semana que viene. Puedes adelantar hasta {euros(a.max_cents)}.</span>}
      overReason={(m) => `Como mucho puedes adelantar ${euros(m)}`}
      cta={(v) => (v ? `Adelantar ${euros(v)}` : 'Adelantar')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

export function LoanSheet({ bank, onClose }: { bank: Bank; onClose: () => void }) {
  const a = bank.actions.loan;
  const [weeks, setWeeks] = useState(Math.min(4, a.max_weeks));
  const [note, setNote] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const notice = useAdultNotice();
  const [error, setError] = useState('');
  const send = useMutation({
    mutationFn: (cents: number) => post('/loans', { amountCents: cents, weeks, note: note || undefined }, key).then((r) => ({ r, cents })),
    onSuccess: ({ r, cents }) => {
      invalidate();
      onClose();
      const first = Math.floor(cents / weeks);
      showReceipt({
        title: 'Préstamo pedido', badge: 'Esperando respuesta', amount: euros(cents), at: new Date(r.loan.created_at ?? sinceNow()), ref: refCode('PR', r.loan.id),
        rows: [{ label: 'Plazo', value: `${weeks} ${weeks === 1 ? 'semana' : 'semanas'}` }, { label: 'Cuota cada lunes', value: `${euros(first)}${a.interest_points ? ` + ${a.interest_points} pts` : ''}` }],
        notice: { title: `Avisamos a ${notice.who}.`, sub: 'Cuando lo apruebe, el dinero llegará a tu cuenta.', avatar: notice.avatar },
      });
    },
    onError: (e: Error) => { setError(e.message); toast(e.message, 'error'); },
  });
  return (
    <AmountSheet
      title="Pedir un préstamo" subtitle={<>Puedes pedir hasta <b className="text-[var(--fg)]">{euros(a.max_cents)}</b></>}
      unit="eur" max={a.max_cents} chips={[500, 1000]}
      after={(v) => <>Pagarás <b className="num text-[var(--fg)]">{euros(Math.floor(v / weeks))}</b>{a.interest_points ? ` + ${a.interest_points} pts` : ''} cada lunes</>}
      overReason={(m) => `Puedes pedir hasta ${euros(m)}`}
      extra={
        <>
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-[var(--chip)] px-3 py-2">
            <span className="text-sm font-bold" id="weeks-label">Devuélvelo en</span>
            <div className="flex items-center gap-2" role="group" aria-labelledby="weeks-label">
              <button type="button" aria-label="Una semana menos" disabled={weeks <= 1} onClick={() => setWeeks(weeks - 1)} className="flex size-9 items-center justify-center rounded-full bg-[var(--card)] text-xl font-bold shadow-[var(--shadow-press)] disabled:opacity-40">−</button>
              <output className="num min-w-[5.5rem] text-center font-bold">{weeks} {weeks === 1 ? 'semana' : 'semanas'}</output>
              <button type="button" aria-label="Una semana más" disabled={weeks >= a.max_weeks} onClick={() => setWeeks(weeks + 1)} className="flex size-9 items-center justify-center rounded-full bg-[var(--card)] text-xl font-bold shadow-[var(--shadow-press)] disabled:opacity-40">+</button>
            </div>
          </div>
          <Field label="¿Para qué es? (opcional)">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />}</Field>
          <p className="text-sm text-[var(--fg-2)]">Si no tienes saldo para una cuota, la cuenta se queda en negativo y no podrás retirar hasta recuperarla.</p>
        </>
      }
      cta={(v) => (v ? `Pedir ${euros(v)}` : 'Pedir préstamo')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

export function SaveSheet({ bank, goals, initialGoal, onClose }: { bank: Bank; goals: Goal[]; initialGoal?: string; onClose: () => void }) {
  const open = goals.filter((g) => g.status === 'active' && !g.pending_request);
  const [goalId, setGoalId] = useState(initialGoal ?? open[0]?.id ?? '');
  const goal = open.find((g) => g.id === goalId);
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const [error, setError] = useState('');
  const send = useMutation({
    mutationFn: (cents: number) => post(`/goals/${goalId}/deposit`, { cents }, key).then((r) => ({ r, cents })),
    onSuccess: ({ r, cents }) => {
      invalidate();
      onClose();
      showReceipt({
        title: 'Ahorro hecho', amount: `−${euros(cents)}`, at: new Date(), ref: refCode('AH', r.entry_id ?? goalId),
        rows: [{ label: 'Desde', value: 'Cuenta de dinero', sub: bank.accounts.money }, { label: 'Hacia', value: `Meta ${goal?.title ?? ''}` }, { label: 'Importe', value: euros(cents) }],
        total: { label: 'Saldo nuevo', value: euros(bank.money_cents - cents) },
        notice: { title: `Tu meta lleva ${euros(r.balance)} de ${euros(goal?.target_cents ?? 0)}.`, sub: 'Gana interés cada lunes.' },
      });
    },
    onError: (e: Error) => { setError(e.message); toast(e.message, 'error'); },
  });
  return (
    <AmountSheet
      title="Ahorrar" subtitle={<>Disponible: <b className="text-[var(--fg)]">{euros(bank.money_cents)}</b></>}
      unit="eur" max={Math.max(0, bank.money_cents)} chips={[500, 1000]} variant="success" blocked={!goalId}
      after={(v) => (goal ? <>Tu meta pasará a {euros(goal.balance_cents + v)} de {euros(goal.target_cents)}</> : null)}
      overReason={(m) => `Solo tienes ${euros(m)} en tu cuenta`}
      extra={open.length > 1 ? (
        <div role="radiogroup" aria-label="Meta" className="flex flex-wrap justify-center gap-2">
          {open.map((g) => (
            <button key={g.id} type="button" role="radio" aria-checked={goalId === g.id} onClick={() => setGoalId(g.id)}
              className={`inline-flex h-10 items-center rounded-full border px-3.5 text-sm font-bold ${goalId === g.id ? 'border-sky bg-sky/15' : 'border-[var(--line)] bg-[var(--chip)] text-[var(--fg-3)]'}`}>{g.title}</button>
          ))}
        </div>
      ) : open[0] ? <p className="text-center font-bold">Meta: {open[0].title}</p> : null}
      cta={(v) => (v ? `Ahorrar ${euros(v)}` : 'Ahorrar')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
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
