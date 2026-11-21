import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { patch } from '../lib/api';
import { euros, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { Button, Field, PageHeader, Segmented, Toggle, useToast } from '../components/ui';

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
        {error ? <p role="alert" className="font-bold text-berry">{error}</p> : null}
        <Button size="lg" loading={save.isPending} onClick={() => save.mutate()}>Guardar ajustes</Button>
      </div>
    </div>
  );
}
