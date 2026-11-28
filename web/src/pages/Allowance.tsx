import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Banknote, CalendarCheck2, MonitorSmartphone, PauseCircle, ReceiptText, ShoppingBag, SlidersHorizontal, Sparkles } from 'lucide-react';
import { api, newKey, post } from '../lib/api';
import { currencySymbol, euros, fmtDate, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Bank, BankSummary, Goal, User, Wallet } from '../lib/types';
import { Avatar, Badge, Button, buttonClass, Field, Loading, PageHeader, SectionTitle, Segmented, Sheet, useToast } from '../components/ui';
import { ScreenAdjustSheet } from '../components/ScreenAdjustSheet';
import { Pips } from '../components/AmountSheet';
import { BankApprovals, useBankApprovals } from '../components/BankApprovals';
import { ScreenList } from '../components/Ledger';
import { GoalProduct, LoanProduct, Statement } from '../components/Bank';
import { minutesLabel } from '../lib/deadline';
import { PaySheet } from '../components/MoneySheets';
import { DeductMinutesSheet } from '../components/ScreenSheets';
import { ExpenseSheet } from '../components/ExpenseSheet';
import { ExpenseRules } from '../components/ExpenseRules';
import type { ScreenView } from '../lib/types';

function AdjustSheet({ child, onClose }: { child: User; onClose: () => void }) {
  const [type, setType] = useState<'points' | 'money'>('points');
  const [sign, setSign] = useState<'plus' | 'minus'>('plus');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => {
      const s = sign === 'plus' ? 1 : -1;
      if (type === 'points') {
        const n = Number(value);
        if (!Number.isInteger(n) || n <= 0) throw new Error('Escribe un número de puntos');
        return post('/adjustments/points', { userId: child.id, delta: s * n, note, bonus: sign === 'plus' }, key);
      }
      const c = parseEuros(value);
      if (!c) throw new Error('Escribe un importe válido');
      return post('/adjustments/money', { userId: child.id, deltaCents: s * c, note }, key);
    },
    onSuccess: () => { toast('Ajuste registrado'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={`Ajustar a ${child.display_name}`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>Guardar ajuste</Button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Segmented label="Qué ajustar" value={type} onChange={setType} options={[{ value: 'points', label: 'Puntos' }, { value: 'money', label: 'Dinero' }]} />
          <Segmented label="Sentido" value={sign} onChange={setSign} options={[{ value: 'plus', label: 'Sumar' }, { value: 'minus', label: 'Restar' }]} />
        </div>
        <Field label={type === 'points' ? 'Puntos' : `Importe (${currencySymbol()})`}>{(id) => <input id={id} className="field num text-xl font-bold" inputMode={type === 'points' ? 'numeric' : 'decimal'} value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        <Field label="Motivo" hint="Queda en el historial y lo verá tu hijo/a.">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Gracias por ayudar con la mudanza…" maxLength={300} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
      </div>
    </Sheet>
  );
}

const RAYS = ['84.6 140.8 6.4 129.8', '88.2 126.9 14.2 99.2', '94.6 114.1 28.4 71.0', '103.7 102.9 48.4 46.6', '115.0 94.0 73.2 27.0', '128.0 87.8 101.6 13.3'];

/** Una cuenta del hijo en su panel: etiqueta, importe grande y una línea de apoyo. */
function BalanceTile({ tone, label, value, note }: { tone: 'money' | 'points'; label: string; value: string; note: React.ReactNode }) {
  const money = tone === 'money';
  return (
    <div className={`min-w-0 rounded-[1.1rem] p-3.5 ${money ? 'bg-tangerine-soft dark:bg-tangerine/15' : 'bg-sun-soft dark:bg-sun/15'}`}>
      <p className="text-[0.8rem] text-[var(--fg-2)]">{label}</p>
      <p className={`num mt-0.5 text-[1.9rem] leading-tight font-extrabold ${value.startsWith('-') || value.startsWith('−') ? 'text-berry-deep' : ''}`}>{value}</p>
      <p className="mt-1 text-xs text-[var(--fg-3)]">{note}</p>
    </div>
  );
}

type SheetKind = 'pay' | 'adjust' | 'history' | 'screen' | 'screen-adjust' | 'screen-history' | 'expense';

/** Panel de banca de un hijo: sus dos cuentas, retiros de la semana, préstamo, metas y acciones. */
function KidPanel({ child: k, wallet: w, pending, onSheet }: { child: User; wallet?: Wallet; pending: number; onSheet: (kind: SheetKind, w: Wallet, bank?: Bank) => void }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const screenQ = useQuery({ queryKey: ['screen', k.id], queryFn: () => api<ScreenView>(`/screen/${k.id}`) });
  const endPause = useMutation({
    mutationFn: (id: string) => post(`/screen/adjustments/${id}/end`),
    onSuccess: () => { toast('Pausa terminada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const pause = screenQ.data?.pause ?? null;
  const bankQ = useQuery({ queryKey: ['bank', k.id], queryFn: () => api<{ bank: Bank }>(`/bank/${k.id}`) });
  const goalsQ = useQuery({ queryKey: ['goals', k.id], queryFn: () => api<{ goals: Goal[] }>(`/goals/${k.id}`) });
  const bank = bankQ.data?.bank;
  const goals = (goalsQ.data?.goals ?? []).filter((g) => g.status === 'active');
  const age = k.birth_year ? new Date().getFullYear() - k.birth_year : null;
  return (
    <article className="panel p-5" aria-label={`Cuenta de ${k.display_name}`}>
      <div className="flex items-center gap-3">
        <Avatar name={k.display_name} avatar={k.avatar} colorKey={k.color} size={48} />
        <div className="min-w-0 flex-1 leading-tight">
          <h3 className="truncate text-[1.35rem] font-extrabold">{k.display_name}</h3>
          {age ? <small className="text-[0.8rem] text-[var(--fg-3)]">{age} años</small> : null}
        </div>
        {pending ? <Badge tone="sun">{pending} por aprobar</Badge> : <Badge tone="leaf">Al día</Badge>}
      </div>
      {w && bank ? (
        <>
          <div className="mt-4 grid gap-2.5 min-[420px]:grid-cols-[1.25fr_1fr]">
            <BalanceTile tone="money" label={w.cents_pending < 0 ? 'Dinero · saldo en negativo' : 'Dinero · por pagar'} value={euros(w.cents_pending)} note={<span className="num tracking-[0.06em] whitespace-nowrap">{bank.accounts.money}</span>} />
            <BalanceTile tone="points" label="Puntos" value={String(w.points_available)} note={<>≈ {euros(w.points_value_cents)} sin convertir{w.points_reserved ? ` · ${w.points_reserved} reservados` : ''}</>} />
          </div>
          <p className="mt-3.5 flex items-center gap-2.5 text-sm text-[var(--fg-2)]"><Pips used={bank.week.withdrawals_used} total={bank.week.withdrawals_max} /> Retiros esta semana: <b className="text-[var(--fg)]">{bank.week.withdrawals_used} de {bank.week.withdrawals_max}</b></p>
          <div className="mt-3.5 grid gap-2.5">
            {bank.loan ? <LoanProduct loan={bank.loan} mine={false} compact /> : <p className="rounded-[1.1rem] border border-[var(--line)] bg-[var(--bg)] px-3.5 py-2.5 text-sm text-[var(--fg-3)]">Sin préstamo</p>}
            {goals.length ? <ul className="grid gap-2.5">{goals.map((g) => <GoalProduct key={g.id} goal={g} mine={false} compact manage />)}</ul> : null}
          </div>
          <p className="mt-3 flex flex-wrap items-center gap-x-2 text-sm text-[var(--fg-2)]">
            <MonitorSmartphone size={16} aria-hidden /> Pantalla: <b className="num text-[var(--fg)]">{minutesLabel(w.screen_minutes)}</b>
            {screenQ.data && screenQ.data.buckets.plan.minutes > 0 ? <span className="num">· plan {minutesLabel(screenQ.data.buckets.plan.minutes)}</span> : null}
            <button type="button" onClick={() => onSheet('screen-history', w)} className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-4">Ver historial</button>
          </p>
          {pause ? (
            <p className="flex flex-wrap items-center gap-2 rounded-2xl bg-sun-soft px-3.5 py-2 text-sm font-bold text-sun-ink dark:bg-sun/15 dark:text-[#ffd979]">
              <PauseCircle size={16} aria-hidden /> <span className="min-w-0 flex-1">{pause.label} · {pause.reason}</span>
              <Button size="sm" variant="secondary" loading={endPause.isPending} onClick={() => endPause.mutate(pause.id)}>Terminar pausa</Button>
            </p>
          ) : null}
          <p className="mt-1 text-xs text-[var(--fg-3)]">Convertido en total {euros(w.cents_converted_total)} · pagado {euros(w.cents_paid_total)}</p>
          <div className="mt-4 grid grid-cols-2 gap-2 min-[560px]:grid-cols-3 min-[1100px]:grid-cols-2 min-[1500px]:grid-cols-3">
            <Button variant="success" size="sm" className="h-11" disabled={w.cents_pending <= 0} onClick={() => onSheet('pay', w)}><Banknote size={17} aria-hidden /> Pagar</Button>
            <Button variant="secondary" size="sm" className="h-11 min-w-0 !px-2 leading-tight !whitespace-normal" onClick={() => onSheet('expense', w)}><ShoppingBag size={17} className="shrink-0" aria-hidden /> Registrar gasto</Button>
            <Button variant="secondary" size="sm" className="h-11 min-w-0 !px-2 text-center leading-tight !whitespace-normal" onClick={() => onSheet('screen', w)}><MonitorSmartphone size={17} className="shrink-0" aria-hidden /> Descontar minutos</Button>
            <Link to={`/pantalla?hijo=${k.id}`} className={`${buttonClass('secondary', 'sm')} h-11`}>Pantalla</Link>
            <Button variant="secondary" size="sm" className="h-11" onClick={() => onSheet('screen-adjust', w)}><Sparkles size={17} aria-hidden /> Ajuste de pantalla</Button>
            <Button variant="secondary" size="sm" className="h-11" onClick={() => onSheet('adjust', w)}><SlidersHorizontal size={17} aria-hidden /> Ajustar</Button>
            <Button variant="secondary" size="sm" className="h-11" onClick={() => onSheet('history', w, bank)}><ReceiptText size={17} aria-hidden /> Extracto</Button>
          </div>
        </>
      ) : <Loading />}
    </article>
  );
}

/** Tarjeta del resumen de arriba. La destacada («Pendiente de pagar») va en marino con los rayos del sol. */
function Tile({ label, value, note, hero, wide }: { label: string; value: React.ReactNode; note: React.ReactNode; hero?: boolean; wide?: boolean }) {
  return (
    <div className={`relative isolate overflow-hidden rounded-[var(--radius-card)] px-[1.125rem] py-4 ${hero ? 'bg-[linear-gradient(150deg,#1d5fae,#142a5c)] text-white shadow-[0_18px_30px_-18px_rgb(18_63_126/0.8)] max-[1099px]:col-span-2' : `card ${wide ? 'max-[1099px]:col-span-2' : ''}`}`}>
      {hero ? (
        <svg aria-hidden viewBox="0 0 150 150" className="absolute -top-1.5 -right-1.5 -z-10 size-28 -scale-y-100 opacity-90" stroke="#ffb800" strokeOpacity="0.35" strokeWidth="3" strokeLinecap="round">
          {RAYS.map((r) => { const [x1, y1, x2, y2] = r.split(' '); return <line key={r} x1={x1} y1={y1} x2={x2} y2={y2} />; })}
        </svg>
      ) : null}
      <p className={`text-[0.85rem] ${hero ? 'text-[#cfe0f7]' : 'text-[var(--fg-3)]'}`}>{label}</p>
      <p className={`num mt-0.5 font-extrabold leading-tight ${hero ? 'text-[2.4rem]' : 'text-[1.75rem]'}`}>{value}</p>
      <p className={`mt-0.5 text-[0.8rem] ${hero ? 'text-[#cfe0f7]' : 'text-[var(--fg-2)]'}`}>{note}</p>
    </div>
  );
}

export default function Allowance() {
  const { family } = useSession();
  const fam = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const kids = (fam.data?.members ?? []).filter((m) => m.role === 'child' && m.active);
  const wallets = useQueries({ queries: kids.map((k) => ({ queryKey: ['wallet', k.id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${k.id}`) })) });
  const summary = useQuery({ queryKey: ['bank-summary'], queryFn: () => api<{ summary: BankSummary }>('/bank-summary') });
  const settlements = useQuery({ queryKey: ['settlements'], queryFn: () => api('/settlements') });
  const approvals = useBankApprovals();
  const [sheet, setSheet] = useState<{ kind: SheetKind; child: User; wallet: Wallet; bank?: Bank } | null>(null);
  const [closing, setClosing] = useState(false);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const settle = useMutation({
    mutationFn: () => post('/allowance/settle', {}),
    onSuccess: (r) => {
      const ok = r.results.filter((x: any) => x.ok);
      const total = ok.reduce((s: number, x: any) => s + x.settlement.cents, 0);
      toast(ok.length ? `Periodo cerrado: ${euros(total)} convertidos` : r.results[0]?.error ?? 'Nada que cerrar', ok.length ? 'ok' : 'error');
      invalidate();
      setClosing(false);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  if (fam.isLoading) return <Loading />;
  const periodName = family.settlement_period === 'week' ? 'semana' : 'mes';
  const sm = summary.data?.summary;
  const pendingFor = (id: string) => approvals.pay.filter((r) => r.user_id === id).length + approvals.loans.filter((l) => l.user_id === id).length + approvals.goals.filter((g) => g.user_id === id).length + approvals.proposals.filter((g) => g.user_id === id).length + approvals.autoRequests.filter((g) => g.user_id === id).length;

  return (
    <div>
      <PageHeader
        title="Banca familiar"
        subtitle={`${family.rate_points} puntos = ${euros(family.rate_cents)}${family.cap_cents != null ? ` · tope ${family.settlement_period === 'week' ? 'semanal' : 'mensual'} ${euros(family.cap_cents)} por hijo` : ' · sin tope'}`}
        action={<Button onClick={() => setClosing(true)}><CalendarCheck2 size={18} aria-hidden /> Cerrar {periodName}</Button>}
      />

      <section aria-label="Resumen" className="mb-7 grid grid-cols-2 gap-3 min-[1100px]:grid-cols-[1.5fr_1fr_1fr_1fr]">
        <Tile hero label="Pendiente de pagar" value={sm ? euros(sm.owed_cents) : '—'} note={sm ? <>Dinero de los hijos {euros(sm.money_cents)} · Ahorros {euros(sm.savings_cents)}</> : ' '} />
        <Tile label="Por aprobar" value={approvals.count} note={approvals.count === 1 ? 'Operación' : 'Operaciones'} />
        <Tile label="Préstamos activos" value={sm ? euros(sm.loans_remaining_cents) : '—'} note={sm?.loans_active ? `${sm.loans_active} por devolver` : 'Ninguno'} />
        <Tile wide label="Interés de esta semana" value={sm ? euros(sm.interest_week_cents) : '—'} note="A cargo de los padres" />
      </section>

      <BankApprovals
        heading={(n) => <h2 className="mb-3 flex items-center gap-2.5 text-[1.3rem] font-bold">Por aprobar {n ? <span className="num rounded-full bg-sun px-2.5 text-sm text-ink">{n}</span> : null}</h2>}
        empty="Nada por aprobar. Todo al día."
      />

      <section aria-label="Cuentas de los hijos">
        <h2 className="mb-3 text-[1.3rem] font-bold">Cuentas de los hijos</h2>
        <div className="grid grid-cols-1 items-start gap-4 min-[1100px]:grid-cols-2">
          {kids.map((k, i) => <KidPanel key={k.id} child={k} wallet={wallets[i]?.data?.wallet} pending={pendingFor(k.id)} onSheet={(kind, w, bank) => setSheet({ kind, child: k, wallet: w, bank })} />)}
        </div>
      </section>

      <ExpenseRules manage />

      <section className="mt-8">
        <SectionTitle>Cierres anteriores</SectionTitle>
        {settlements.data?.settlements?.length ? (
          <ul className="card divide-y divide-[var(--line)]">
            {settlements.data.settlements.map((s: any) => (
              <li key={s.id} className="flex items-center gap-3 p-3.5">
                <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]"><CalendarCheck2 size={20} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{s.display_name}</span>
                  <span className="block text-sm muted">{fmtDate(s.period_start)} – {fmtDate(s.period_end)} · <span className="num">{s.points_converted}</span> pts</span>
                </span>
                <span className="flex shrink-0 flex-col items-end gap-0.5">
                  <span className="num text-lg font-extrabold text-leaf-text">{euros(s.cents)}</span>
                  {s.capped ? <Badge tone="sun">límite</Badge> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="card p-6 text-center muted">Todavía no hay cierres.</p>
        )}
      </section>

      <Sheet open={closing} onClose={() => setClosing(false)} title={`Cerrar la ${periodName} anterior`}
        footer={<Button className="w-full" loading={settle.isPending} onClick={() => settle.mutate()}>Convertir puntos en dinero</Button>}>
        <p className="muted">Los puntos disponibles de cada hijo se convertirán en euros ({family.rate_points} pts = {euros(family.rate_cents)}){family.cap_cents != null ? `, con un máximo de ${euros(family.cap_cents)} por ${periodName}. Lo que pase del límite se queda en puntos` : ''}. Cada {periodName} solo se puede cerrar una vez.</p>
      </Sheet>
      {sheet?.kind === 'pay' ? <PaySheet child={sheet.child} wallet={sheet.wallet} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'expense' ? <ExpenseSheet child={sheet.child} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'screen' ? <DeductMinutesSheet child={sheet.child} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'screen-adjust' ? <ScreenAdjustSheet child={sheet.child} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'screen-history' ? (
        <Sheet open onClose={() => setSheet(null)} title={`Pantalla de ${sheet.child.display_name}`} subtitle={<>Saldo: <b className="num text-[var(--fg)]">{minutesLabel(sheet.wallet.screen_minutes)}</b></>}><ScreenList userId={sheet.child.id} /></Sheet>
      ) : null}
      {sheet?.kind === 'adjust' ? <AdjustSheet child={sheet.child} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'history' ? (
        <Sheet open onClose={() => setSheet(null)} title={`Extracto de ${sheet.child.display_name}`}><Statement userId={sheet.child.id} loan={sheet.bank?.loan} /></Sheet>
      ) : null}
    </div>
  );
}
