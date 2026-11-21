import { useState } from 'react';
import { useMutation, useQueries, useQuery } from '@tanstack/react-query';
import { Banknote, CalendarCheck2, History, MonitorSmartphone, SlidersHorizontal } from 'lucide-react';
import { api, newKey, post } from '../lib/api';
import { euros, fmtDate, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { User, Wallet } from '../lib/types';
import { Avatar, Badge, Button, Field, Loading, PageHeader, SectionTitle, Segmented, Sheet, useToast } from '../components/ui';
import { LedgerList, ScreenList } from '../components/Ledger';
import { minutesLabel } from '../lib/deadline';

const METHODS = [{ value: 'cash', label: 'Efectivo' }, { value: 'bizum', label: 'Bizum' }, { value: 'transfer', label: 'Transferencia' }, { value: 'other', label: 'Otro' }] as const;

function PaySheet({ child, wallet, onClose }: { child: User; wallet: Wallet; onClose: () => void }) {
  const [amount, setAmount] = useState(wallet.cents_pending > 0 ? (wallet.cents_pending / 100).toFixed(2).replace('.', ',') : '');
  const [method, setMethod] = useState<(typeof METHODS)[number]['value']>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [key] = useState(newKey); // misma clave en reintentos = sin pagos duplicados
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const pay = useMutation({
    mutationFn: () => {
      const cents = parseEuros(amount);
      if (!cents) throw new Error('Escribe un importe válido, por ejemplo 5,50');
      return post('/payments', { userId: child.id, amountCents: cents, method, note: note || undefined }, key);
    },
    onSuccess: (r) => {
      toast(r.payment.duplicate ? 'Este pago ya estaba registrado' : `Pago de ${euros(r.payment.amount_cents)} registrado`);
      invalidate();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={`Pagar a ${child.display_name}`} footer={<Button className="w-full" variant="success" loading={pay.isPending} onClick={() => pay.mutate()}>Registrar pago</Button>}>
      <p className="mb-4 muted">Saldo pendiente: <strong className="num text-[var(--fg)]">{euros(wallet.cents_pending)}</strong>. Registra aquí el dinero que le das en mano o por Bizum.</p>
      <div className="space-y-4">
        <Field label="Importe (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <div><p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Forma de pago</p><Segmented label="Forma de pago" value={method} onChange={setMethod} options={[...METHODS]} /></div>
        <Field label="Nota (opcional)">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
      </div>
    </Sheet>
  );
}

/** Gastar o ajustar minutos de pantalla: el saldo nunca baja de 0. */
function ScreenSheet({ child, minutes, onClose }: { child: User; minutes: number; onClose: () => void }) {
  const [mode, setMode] = useState<'spend' | 'give' | 'take'>('spend');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) throw new Error('Escribe los minutos');
      if (mode === 'spend') return post('/screen/spend', { userId: child.id, minutes: n, note });
      if (!note.trim()) throw new Error('Indica el motivo');
      return post('/screen/adjust', { userId: child.id, delta: mode === 'give' ? n : -n, note });
    },
    onSuccess: (r) => { toast(`Hecho. Le quedan ${minutesLabel(r.balance)}`); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={`Pantalla de ${child.display_name}`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>{mode === 'spend' ? 'Gastar minutos' : 'Guardar'}</Button>}>
      <div className="space-y-4">
        <p className="muted">Saldo: <strong className="num text-[var(--fg)]">{minutesLabel(minutes)}</strong></p>
        <Segmented label="Qué hacer" value={mode} onChange={setMode} options={[{ value: 'spend', label: 'Gastar' }, { value: 'give', label: 'Dar' }, { value: 'take', label: 'Quitar' }]} />
        <Field label="Minutos">{(id) => <input id={id} className="field num text-xl font-bold" inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        <Field label={mode === 'spend' ? 'Nota (opcional)' : 'Motivo'}>{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder={mode === 'spend' ? 'Consola, tablet…' : ''} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
        <div className="border-t border-[var(--line)] pt-3"><ScreenList userId={child.id} /></div>
      </div>
    </Sheet>
  );
}

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
          <Segmented label="Qué ajustar" value={type} onChange={setType} options={[{ value: 'points', label: 'Puntos' }, { value: 'money', label: 'Euros' }]} />
          <Segmented label="Sentido" value={sign} onChange={setSign} options={[{ value: 'plus', label: 'Sumar' }, { value: 'minus', label: 'Restar' }]} />
        </div>
        <Field label={type === 'points' ? 'Puntos' : 'Importe (€)'}>{(id) => <input id={id} className="field num text-xl font-bold" inputMode={type === 'points' ? 'numeric' : 'decimal'} value={value} onChange={(e) => setValue(e.target.value)} />}</Field>
        <Field label="Motivo" hint="Queda en el historial y lo verá tu hijo/a.">{(id) => <input id={id} className="field" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Gracias por ayudar con la mudanza…" maxLength={300} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
      </div>
    </Sheet>
  );
}

export default function Allowance() {
  const { family } = useSession();
  const fam = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const kids = (fam.data?.members ?? []).filter((m) => m.role === 'child' && m.active);
  const wallets = useQueries({ queries: kids.map((k) => ({ queryKey: ['wallet', k.id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${k.id}`) })) });
  const settlements = useQuery({ queryKey: ['settlements'], queryFn: () => api('/settlements') });
  const [sheet, setSheet] = useState<{ kind: 'pay' | 'adjust' | 'history' | 'screen'; child: User; wallet: Wallet } | null>(null);
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

  return (
    <div>
      <PageHeader
        title="Mesada"
        subtitle={`${family.rate_points} puntos = ${euros(family.rate_cents)} · cierre cada ${periodName}${family.cap_cents != null ? ` · máximo ${euros(family.cap_cents)}` : ''}`}
        action={<Button onClick={() => setClosing(true)}><CalendarCheck2 size={18} /> Cerrar {periodName}</Button>}
      />
      <div className="grid gap-4 md:grid-cols-2">
        {kids.map((k, i) => {
          const w = wallets[i]?.data?.wallet;
          return (
            <article key={k.id} className="panel p-5">
              <div className="mb-4 flex items-center gap-3">
                <Avatar name={k.display_name} avatar={k.avatar} colorKey={k.color} size={44} />
                <h2 className="flex-1 text-xl font-extrabold">{k.display_name}</h2>
              </div>
              {w ? (
                <>
                  <dl className="grid grid-cols-2 gap-3">
                    <div className="rounded-2xl bg-tangerine-soft p-3.5 dark:bg-tangerine/15">
                      <dt className="text-sm font-bold text-tangerine-deep dark:text-[#ffb27f]">Puntos sin convertir</dt>
                      <dd className="num text-2xl font-extrabold">{w.points_available}</dd>
                      <dd className="text-sm muted">≈ {euros(w.points_value_cents)}{w.points_reserved ? ` · ${w.points_reserved} reservados` : ''}</dd>
                    </div>
                    <div className="rounded-2xl bg-leaf-soft p-3.5 dark:bg-leaf/15">
                      <dt className="text-sm font-bold text-leaf-deep dark:text-[#7fe0b2]">Por pagar</dt>
                      <dd className="num text-2xl font-extrabold">{euros(w.cents_pending)}</dd>
                      <dd className="text-sm muted">Hucha: {euros(w.cents_savings)}</dd>
                    </div>
                  </dl>
                  <p className="mt-3 flex items-center gap-2 rounded-2xl bg-[var(--chip)] px-3.5 py-2.5 text-sm"><MonitorSmartphone size={16} aria-hidden /> Pantalla: <strong className="num">{minutesLabel(w.screen_minutes)}</strong></p>
                  <p className="mt-3 text-sm muted">Convertido en total {euros(w.cents_converted_total)} · pagado {euros(w.cents_paid_total)}</p>
                  <div className="mt-4 flex flex-wrap gap-2">
                    <Button variant="success" size="sm" disabled={w.cents_pending <= 0} onClick={() => setSheet({ kind: 'pay', child: k, wallet: w })}><Banknote size={16} /> Registrar pago</Button>
                    <Button variant="secondary" size="sm" onClick={() => setSheet({ kind: 'adjust', child: k, wallet: w })}><SlidersHorizontal size={16} /> Ajustar</Button>
                    <Button variant="secondary" size="sm" onClick={() => setSheet({ kind: 'screen', child: k, wallet: w })}><MonitorSmartphone size={16} /> Pantalla</Button>
                    <Button variant="ghost" size="sm" onClick={() => setSheet({ kind: 'history', child: k, wallet: w })}><History size={16} /> Movimientos</Button>
                  </div>
                </>
              ) : <Loading />}
            </article>
          );
        })}
      </div>

      <section className="mt-8">
        <SectionTitle>Cierres anteriores</SectionTitle>
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[var(--fg-3)]">
              <tr><th className="p-3 font-bold">Periodo</th><th className="p-3 font-bold">Quién</th><th className="p-3 text-right font-bold">Puntos</th><th className="p-3 text-right font-bold">Euros</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {(settlements.data?.settlements ?? []).map((s: any) => (
                <tr key={s.id}>
                  <td className="p-3">{fmtDate(s.period_start)} – {fmtDate(s.period_end)}</td>
                  <td className="p-3 font-bold">{s.display_name}</td>
                  <td className="num p-3 text-right">{s.points_converted}</td>
                  <td className="num p-3 text-right font-bold">{euros(s.cents)} {s.capped ? <Badge tone="sun">límite</Badge> : null}</td>
                </tr>
              ))}
              {!settlements.data?.settlements?.length ? <tr><td colSpan={4} className="p-6 text-center muted">Todavía no hay cierres.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      <Sheet open={closing} onClose={() => setClosing(false)} title={`Cerrar la ${periodName} anterior`}
        footer={<Button className="w-full" loading={settle.isPending} onClick={() => settle.mutate()}>Convertir puntos en euros</Button>}>
        <p className="muted">Los puntos disponibles de cada hijo se convertirán en euros ({family.rate_points} pts = {euros(family.rate_cents)}){family.cap_cents != null ? `, con un máximo de ${euros(family.cap_cents)} por ${periodName}. Lo que pase del límite se queda en puntos` : ''}. Cada {periodName} solo se puede cerrar una vez.</p>
      </Sheet>
      {sheet?.kind === 'pay' ? <PaySheet child={sheet.child} wallet={sheet.wallet} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'screen' ? <ScreenSheet child={sheet.child} minutes={sheet.wallet.screen_minutes} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'adjust' ? <AdjustSheet child={sheet.child} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'history' ? (
        <Sheet open onClose={() => setSheet(null)} title={`Movimientos de ${sheet.child.display_name}`}><LedgerList userId={sheet.child.id} /></Sheet>
      ) : null}
    </div>
  );
}
