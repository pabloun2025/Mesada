import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { euros, fmtDate, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Button, Field, IconButton, PageHeader, Segmented, Toggle, useToast } from '../components/ui';
import type { Family } from '../lib/types';

/** Festivos y vacaciones: esos días rige la hora límite de fin de semana. */
function Holidays() {
  const [day, setDay] = useState('');
  const [label, setLabel] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const list = useQuery({ queryKey: ['holidays'], queryFn: () => api<{ holidays: { day: string; label: string }[] }>('/holidays') });
  const add = useMutation({
    mutationFn: () => post('/holidays', { day, label }),
    onSuccess: () => { setDay(''); setLabel(''); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const remove = useMutation({ mutationFn: (d: string) => del(`/holidays/${d}`), onSuccess: () => invalidate() });
  return (
    <section className="panel space-y-4 p-5">
      <div>
        <h2 className="text-lg font-bold">Festivos y vacaciones</h2>
        <p className="text-sm muted">Esos días, las tareas con hora límite usan la hora del fin de semana.</p>
      </div>
      <form className="grid grid-cols-[auto_1fr_auto] items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (day) add.mutate(); }}>
        <Field label="Día">{(id) => <input id={id} type="date" className="field" value={day} onChange={(e) => setDay(e.target.value)} required />}</Field>
        <Field label="Nombre">{(id) => <input id={id} className="field" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="Puente de diciembre" />}</Field>
        <Button type="submit" variant="secondary" loading={add.isPending} disabled={!day}>Añadir</Button>
      </form>
      {list.data?.holidays.length ? (
        <ul className="divide-y divide-[var(--line)]">
          {list.data.holidays.map((h) => (
            <li key={h.day} className="flex items-center gap-3 py-2">
              <span className="flex-1"><span className="font-bold">{fmtDate(h.day, { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })}</span>{h.label ? <span className="muted"> · {h.label}</span> : null}</span>
              <IconButton label={`Quitar ${h.day}`} onClick={() => remove.mutate(h.day)}><Trash2 size={17} /></IconButton>
            </li>
          ))}
        </ul>
      ) : <p className="text-sm muted">Todavía no has marcado ninguno.</p>}
    </section>
  );
}

/** Número entero en un campo con etiqueta y unidad; vacío = no válido. */
function NumField({ label, value, onChange, unit, hint, step = 1 }: { label: string; value: number | string; onChange: (v: number) => void; unit?: string; hint?: string; step?: number }) {
  return (
    <Field label={label} hint={hint}>
      {(id) => (
        <span className="flex items-center gap-2">
          <input id={id} className="field num w-28 font-bold" type="number" min={0} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
          {unit ? <span className="muted">{unit}</span> : null}
        </span>
      )}
    </Field>
  );
}

type BankForm = Pick<Family, 'bank_exchange_enabled' | 'bank_exchange_min_points' | 'bank_withdraw_enabled' | 'bank_withdraw_per_week' | 'bank_advance_enabled' | 'bank_advance_percent' | 'bank_loan_enabled' | 'bank_loan_max_percent' | 'bank_loan_max_weeks' | 'bank_loan_interest_points' | 'bank_savings_enabled' | 'bank_savings_rate_percent'>;

/** Reglas del banco de los hijos: cada opción se puede apagar y todos los números se cambian aquí. */
function BankSettings({ capOn }: { capOn: boolean }) {
  const { family } = useSession();
  const [b, setB] = useState<BankForm>({
    bank_exchange_enabled: family.bank_exchange_enabled, bank_exchange_min_points: family.bank_exchange_min_points,
    bank_withdraw_enabled: family.bank_withdraw_enabled, bank_withdraw_per_week: family.bank_withdraw_per_week,
    bank_advance_enabled: family.bank_advance_enabled, bank_advance_percent: family.bank_advance_percent,
    bank_loan_enabled: family.bank_loan_enabled, bank_loan_max_percent: family.bank_loan_max_percent,
    bank_loan_max_weeks: family.bank_loan_max_weeks, bank_loan_interest_points: family.bank_loan_interest_points,
    bank_savings_enabled: family.bank_savings_enabled, bank_savings_rate_percent: family.bank_savings_rate_percent,
  });
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => patch('/family', {
      bankExchangeEnabled: b.bank_exchange_enabled, bankExchangeMinPoints: b.bank_exchange_min_points,
      bankWithdrawEnabled: b.bank_withdraw_enabled, bankWithdrawPerWeek: b.bank_withdraw_per_week,
      bankAdvanceEnabled: b.bank_advance_enabled, bankAdvancePercent: b.bank_advance_percent,
      bankLoanEnabled: b.bank_loan_enabled, bankLoanMaxPercent: b.bank_loan_max_percent,
      bankLoanMaxWeeks: b.bank_loan_max_weeks, bankLoanInterestPoints: b.bank_loan_interest_points,
      bankSavingsEnabled: b.bank_savings_enabled, bankSavingsRatePercent: Number(b.bank_savings_rate_percent),
    }),
    onSuccess: () => { toast('Ajustes del banco guardados'); setError(''); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <section className="panel space-y-3 p-5" aria-labelledby="bank-settings">
      <div>
        <h2 id="bank-settings" className="text-lg font-bold">Banco de los hijos</h2>
        <p className="text-sm muted">El «tope semanal» es el límite por periodo de arriba (si el cierre es mensual, se reparte en semanas).{capOn ? '' : ' Ahora no hay tope: el adelanto y el préstamo no estarán disponibles hasta que pongas uno.'}</p>
      </div>
      <Toggle checked={b.bank_exchange_enabled} onChange={(v) => setB({ ...b, bank_exchange_enabled: v })} label="Canjear puntos por dinero" description="El hijo cambia puntos por euros cuando quiere. Cuenta para el tope de la semana." />
      {b.bank_exchange_enabled ? <NumField label="Mínimo por canje" unit="puntos" value={b.bank_exchange_min_points} onChange={(v) => setB({ ...b, bank_exchange_min_points: v })} /> : null}
      <Toggle checked={b.bank_withdraw_enabled} onChange={(v) => setB({ ...b, bank_withdraw_enabled: v })} label="Retirar dinero" description="El hijo pide su saldo y un adulto se lo paga." />
      {b.bank_withdraw_enabled ? <NumField label="Retiros por semana" unit="(de lunes a domingo)" value={b.bank_withdraw_per_week} onChange={(v) => setB({ ...b, bank_withdraw_per_week: v })} /> : null}
      <Toggle checked={b.bank_advance_enabled} onChange={(v) => setB({ ...b, bank_advance_enabled: v })} label="Adelanto" description="Cambia puntos ya ganados por encima del tope de esta semana; se resta del tope de la siguiente. Sin aprobación." />
      {b.bank_advance_enabled ? <NumField label="Máximo adelantable" unit="% del tope de la semana siguiente" value={b.bank_advance_percent} onChange={(v) => setB({ ...b, bank_advance_percent: v })} /> : null}
      <Toggle checked={b.bank_loan_enabled} onChange={(v) => setB({ ...b, bank_loan_enabled: v })} label="Préstamo" description="Lo apruebas tú en Validar. Cada lunes se descuenta la cuota y el interés en puntos. Solo uno a la vez." />
      {b.bank_loan_enabled ? (
        <div className="flex flex-wrap gap-4">
          <NumField label="Máximo" unit="% del tope semanal" value={b.bank_loan_max_percent} onChange={(v) => setB({ ...b, bank_loan_max_percent: v })} />
          <NumField label="Semanas como mucho" value={b.bank_loan_max_weeks} onChange={(v) => setB({ ...b, bank_loan_max_weeks: v })} />
          <NumField label="Interés por semana" unit="puntos" value={b.bank_loan_interest_points} onChange={(v) => setB({ ...b, bank_loan_interest_points: v })} />
        </div>
      ) : null}
      <Toggle checked={b.bank_savings_enabled} onChange={(v) => setB({ ...b, bank_savings_enabled: v })} label="Interés del ahorro" description="Cada lunes las metas con dinero ganan interés, que pagáis vosotros. Se redondea al euro de arriba, con 1 € como mínimo." />
      {b.bank_savings_enabled ? <NumField label="Interés semanal" unit="%" step={0.1} value={b.bank_savings_rate_percent} onChange={(v) => setB({ ...b, bank_savings_rate_percent: v })} /> : null}
      {error ? <p role="alert" className="font-bold text-berry">{error}</p> : null}
      <Button variant="secondary" loading={save.isPending} onClick={() => save.mutate()}>Guardar ajustes del banco</Button>
    </section>
  );
}

export default function Settings() {
  const { family } = useSession();
  const [f, setF] = useState({
    name: family.name,
    ratePoints: family.rate_points,
    rateEuros: (family.rate_cents / 100).toFixed(2).replace('.', ','),
    settlementPeriod: family.settlement_period,
    capOn: family.cap_cents != null,
    capEuros: family.cap_cents != null ? (family.cap_cents / 100).toFixed(2).replace('.', ',') : '10,00',
    leaderboardEnabled: family.leaderboard_enabled,
    celebrationsEnabled: family.celebrations_enabled,
  });
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => {
      const rateCents = parseEuros(f.rateEuros);
      const capCents = f.capOn ? parseEuros(f.capEuros) : null;
      if (rateCents == null) throw new Error('El valor en euros no es válido');
      if (f.capOn && capCents == null) throw new Error('El límite no es válido');
      return patch('/family', {
        name: f.name, ratePoints: f.ratePoints, rateCents, settlementPeriod: f.settlementPeriod, capCents,
        leaderboardEnabled: f.leaderboardEnabled, celebrationsEnabled: f.celebrationsEnabled,
      });
    },
    onSuccess: () => { toast('Ajustes guardados'); setError(''); invalidate(); },
    onError: (e: Error) => setError(e.message),
  });
  const preview = parseEuros(f.rateEuros);
  return (
    <div className="max-w-2xl">
      <PageHeader title="Ajustes" subtitle="Reglas de la mesada y de la familia." />
      <div className="space-y-6">
        <section className="panel space-y-4 p-5">
          <h2 className="text-lg font-bold">Familia</h2>
          <Field label="Nombre">{(id) => <input id={id} className="field" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
        </section>
        <section className="panel space-y-4 p-5">
          <h2 className="text-lg font-bold">Puntos y euros</h2>
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Puntos">{(id) => <input id={id} className="field num w-28 font-bold" type="number" min={1} value={f.ratePoints} onChange={(e) => setF({ ...f, ratePoints: Number(e.target.value) })} />}</Field>
            <span className="pb-3 font-bold">=</span>
            <Field label="Euros">{(id) => <input id={id} className="field num w-28 font-bold" inputMode="decimal" value={f.rateEuros} onChange={(e) => setF({ ...f, rateEuros: e.target.value })} />}</Field>
          </div>
          {preview != null && f.ratePoints > 0 ? <p className="text-sm muted">Una tarea de 20 puntos vale {euros(Math.floor((20 * preview) / f.ratePoints))}.</p> : null}
          <div>
            <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Cierre y conversión</p>
            <Segmented label="Periodo de cierre" value={f.settlementPeriod} onChange={(v) => setF({ ...f, settlementPeriod: v })} options={[{ value: 'week', label: 'Semanal' }, { value: 'month', label: 'Mensual' }]} />
          </div>
          <Toggle checked={f.capOn} onChange={(v) => setF({ ...f, capOn: v })} label="Límite por periodo" description="Máximo que se puede convertir en cada cierre. El resto se queda en puntos." />
          {f.capOn ? <Field label="Límite (€)">{(id) => <input id={id} className="field num w-32 font-bold" inputMode="decimal" value={f.capEuros} onChange={(e) => setF({ ...f, capEuros: e.target.value })} />}</Field> : null}
        </section>
        <section className="panel p-5">
          <h2 className="mb-2 text-lg font-bold">Motivación</h2>
          <Toggle checked={f.leaderboardEnabled} onChange={(v) => setF({ ...f, leaderboardEnabled: v })} label="Clasificación entre hermanos" description="Si la desactivas, cada uno solo ve su progreso frente a su objetivo." />
          <Toggle checked={f.celebrationsEnabled} onChange={(v) => setF({ ...f, celebrationsEnabled: v })} label="Celebraciones" description="Pequeña animación al completar tareas." />
        </section>
        <BankSettings capOn={f.capOn} />
        <Holidays />
        {error ? <p role="alert" className="font-bold text-berry">{error}</p> : null}
        <Button size="lg" loading={save.isPending} onClick={() => save.mutate()}>Guardar ajustes</Button>
      </div>
    </div>
  );
}
