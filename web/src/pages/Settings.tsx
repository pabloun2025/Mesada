import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { euros, fmtDate, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Button, Field, IconButton, PageHeader, Segmented, Toggle, useToast } from '../components/ui';

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
        <Holidays />
        {error ? <p role="alert" className="font-bold text-berry">{error}</p> : null}
        <Button size="lg" loading={save.isPending} onClick={() => save.mutate()}>Guardar ajustes</Button>
      </div>
    </div>
  );
}
