import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Archive, Pencil, Plus } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { minutesHM } from '../lib/deadline';
import { currencySymbol, decimalSep, euros, parseEuros } from '../lib/format';
import type { ScreenPlanRow, ScreenReason } from '../lib/types';
import { DAY_LETTERS, DAY_NAMES } from '../lib/screen-state';
import { Avatar, Button, Disclosure, Field, IconButton, Segmented, Sheet, Toggle, useToast } from './ui';
import { reasonEffect } from './ScreenAdjustSheet';

/** Plan de un hijo: minutos por semana, días de uso con tope opcional por día y si hace falta aprobación. */
export function PlanRow({ row, compact = false }: { row: ScreenPlanRow; compact?: boolean }) {
  const [minutes, setMinutes] = useState(String(row.minutes_per_week));
  const [enabled, setEnabled] = useState(row.enabled);
  const [days, setDays] = useState<number[]>(row.allowed_days ?? [1, 2, 3, 4, 5, 6, 7]);
  const [caps, setCaps] = useState<Record<string, string>>(Object.fromEntries(Object.entries(row.day_max ?? {}).map(([k, v]) => [k, String(v)])));
  const [approval, setApproval] = useState(row.require_approval ?? false);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const n = Number(minutes);
  const valid = Number.isInteger(n) && n >= 0 && n <= 10080 && days.length > 0;
  const toggleDay = (d: number) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  const save = useMutation({
    mutationFn: async () => {
      const dayMax: Record<string, number> = {};
      for (const d of days) { const v = Number(caps[String(d)]); if (Number.isInteger(v) && v > 0) dayMax[String(d)] = v; }
      await put(`/screen/plans/${row.user_id}`, { minutesPerWeek: n, enabled });
      await put(`/screen/rules/${row.user_id}`, { allowedDays: days, dayMax, requireApproval: approval });
    },
    onSuccess: () => { toast(`Plan de ${row.display_name} guardado`); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <li className="space-y-1 rounded-2xl border border-[var(--line)] p-3.5">
      {compact ? null : (
        <div className="flex items-center gap-3">
          <Avatar name={row.display_name} avatar={row.avatar} colorKey={row.color} size={36} />
          <h3 className="min-w-0 flex-1 truncate font-bold">{row.display_name}</h3>
        </div>
      )}
      <Toggle checked={enabled} onChange={setEnabled} label="Plan semanal activo" description={enabled ? 'Se carga cada lunes a las 00:00.' : 'Apagado: no recibe minutos del plan.'} />
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Minutos por semana" hint={valid ? `= ${minutesHM(n)} cada semana` : 'Entre 0 y 10 080'}>
          {(id) => <input id={id} className="field num w-32 font-bold" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />}
        </Field>
      </div>
      <div className="pt-2">
        <p className="mb-1.5 text-sm font-bold text-[var(--fg-2)]">Días en que puede usar la pantalla</p>
        <div role="group" aria-label={`Días de uso de ${row.display_name}`} className="grid grid-cols-7 gap-1">
          {DAY_LETTERS.map((l, i) => (
            <button key={l + i} type="button" aria-pressed={days.includes(i + 1)} aria-label={DAY_NAMES[i]} onClick={() => toggleDay(i + 1)}
              className={`h-11 rounded-xl border text-sm font-bold transition ${days.includes(i + 1) ? 'border-sky bg-sky/15' : 'border-[var(--line)] bg-[var(--chip)] text-[var(--fg-3)]'}`}>{l}</button>
          ))}
        </div>
        {days.length === 0 ? <p role="alert" className="mt-1 text-sm font-bold text-berry-deep">Deja al menos un día.</p> : null}
        <Disclosure title="Máximo por día" summary="Opcional: p. ej. 30 min entre semana y 2 h el fin de semana">
          <div className="grid grid-cols-2 gap-x-3">
            {days.map((d) => (
              <Field key={d} label={DAY_NAMES[d - 1]}>
                {(id) => <input id={id} className="field num font-bold" inputMode="numeric" placeholder="Sin tope" value={caps[String(d)] ?? ''} onChange={(e) => setCaps((c) => ({ ...c, [String(d)]: e.target.value.replace(/\D/g, '') }))} />}
              </Field>
            ))}
          </div>
        </Disclosure>
      </div>
      <Toggle checked={approval} onChange={setApproval} label="Un adulto aprueba cada vez" description={approval ? 'Al pulsar «Usar pantalla», espera a que lo apruebes.' : 'Empieza al momento, sin pedir permiso.'} />
      <Button variant="secondary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()} aria-label={`Guardar el plan de ${row.display_name}`}>Guardar</Button>
    </li>
  );
}

/** Minutos de pantalla que recibe cada hijo cada lunes. Lo que no use caduca el lunes siguiente. */
export function PlanSettings() {
  const q = useQuery({ queryKey: ['screen-plans'], queryFn: () => api<{ plans: ScreenPlanRow[] }>('/screen/plans') });
  return (
    <section className="panel space-y-4 p-5" aria-labelledby="screen-plan">
      <div>
        <h2 id="screen-plan" className="text-lg font-bold">Plan semanal de pantalla</h2>
        <p className="text-sm muted">Cada lunes a las 00:00 cada hijo recibe sus minutos. Lo que no use caduca el lunes siguiente, así que vale todo el fin de semana. Los minutos que gana con tareas caducan entre 30 y 36 días después.</p>
      </div>
      {q.data?.plans.length ? <ul className="space-y-3">{q.data.plans.map((r) => <PlanRow key={`${r.user_id}-${r.minutes_per_week}-${r.enabled}-${(r.allowed_days ?? []).join('')}-${JSON.stringify(r.day_max)}-${r.require_approval}`} row={r} />)}</ul> : <p className="muted">Todavía no hay hijos.</p>}
    </section>
  );
}

function ReasonEditor({ initial, onClose }: { initial: Partial<ScreenReason>; onClose: () => void }) {
  const [title, setTitle] = useState(initial.title ?? '');
  const [effect, setEffect] = useState<'minutes' | 'pause'>(initial.effect ?? 'minutes');
  const [minutes, setMinutes] = useState(String(initial.minutes ?? 15));
  const [days, setDays] = useState(String(initial.pause_days ?? 1));
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => {
      const body = { title, effect, minutes: effect === 'minutes' ? Number(minutes) : null, pauseDays: effect === 'pause' ? Number(days) : null };
      return initial.id ? put(`/screen/reasons/${initial.id}`, body) : post('/screen/reasons', body);
    },
    onSuccess: () => { toast('Motivo guardado'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={initial.id ? 'Editar motivo' : 'Nuevo motivo'}
      footer={<div className="space-y-2">{error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}<Button className="w-full" loading={save.isPending} disabled={!title.trim()} onClick={() => save.mutate()}>Guardar motivo</Button></div>}>
      <div className="space-y-5">
        <Field label="¿Qué quieres conseguir?" hint="Escríbelo en positivo: «Llegar a tiempo al cole», «Habitación en orden»…">
          {(id) => <input id={id} className="field" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <div>
          <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Efecto habitual</p>
          <Segmented label="Efecto habitual" value={effect} onChange={setEffect} options={[{ value: 'minutes', label: 'Quitar minutos' }, { value: 'pause', label: 'Pausa' }]} />
        </div>
        {effect === 'minutes' ? (
          <Field label="Minutos">{(id) => <input id={id} className="field num w-28 font-bold" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />}</Field>
        ) : (
          <Field label="Días de pausa">{(id) => <input id={id} className="field num w-28 font-bold" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />}</Field>
        )}
        <p className="text-sm muted">Al aplicarlo podrás cambiar la cantidad.</p>
      </div>
    </Sheet>
  );
}

/** Catálogo de motivos de los «Ajustes de pantalla». Se pueden crear, editar y archivar. */
export function ReasonsSettings() {
  const q = useQuery({ queryKey: ['screen-reasons'], queryFn: () => api<{ reasons: ScreenReason[] }>('/screen/reasons') });
  const [editing, setEditing] = useState<Partial<ScreenReason> | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const archive = useMutation({ mutationFn: (id: string) => del(`/screen/reasons/${id}`), onSuccess: () => { toast('Motivo archivado'); invalidate(); }, onError: (e: Error) => toast(e.message, 'error') });
  return (
    <section className="panel space-y-3 p-5" aria-labelledby="screen-reasons">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 id="screen-reasons" className="text-lg font-bold">Ajustes de pantalla</h2>
          <p className="text-sm muted">Motivos para ajustar la pantalla de un hijo, escritos en positivo. Cada uno trae su efecto habitual (quitar minutos o una pausa de unos días), que cambias al aplicarlo.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setEditing({})}><Plus size={16} /> Nuevo</Button>
      </div>
      <ul className="divide-y divide-[var(--line)]">
        {(q.data?.reasons ?? []).map((r) => (
          <li key={r.id} className="flex items-center gap-2 py-1.5">
            <span className="min-w-0 flex-1"><span className="block font-bold">{r.title}</span><span className="num block text-sm muted">{reasonEffect(r)}</span></span>
            <IconButton label={`Editar «${r.title}»`} onClick={() => setEditing(r)}><Pencil size={17} /></IconButton>
            <IconButton label={`Archivar «${r.title}»`} onClick={() => archive.mutate(r.id)}><Archive size={17} /></IconButton>
          </li>
        ))}
      </ul>
      {editing ? <ReasonEditor initial={editing} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

/** Cuánto cuesta cada 15 minutos de tiempo extra cuando no llegan los minutos: en puntos o en dinero (por familia). */
export function RatesSettings() {
  const q = useQuery({ queryKey: ['screen-rates'], queryFn: () => api<{ pointsPer15: number; centsPer15: number }>('/screen/rates') });
  const [pts, setPts] = useState('');
  const [cents, setCents] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const p = Number(pts === '' ? q.data?.pointsPer15 : pts);
  const c = parseEuros(cents === '' ? euros(q.data?.centsPer15 ?? 0) : cents);
  const valid = Number.isInteger(p) && p >= 1 && p <= 1000 && c != null && c >= 1 && c <= 10000;
  const save = useMutation({
    mutationFn: () => put('/screen/rates', { pointsPer15: p, centsPer15: c }),
    onSuccess: () => { toast('Precio del tiempo extra guardado'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <section className="panel space-y-3 p-5" aria-labelledby="screen-rates">
      <div>
        <h2 id="screen-rates" className="text-lg font-bold">Precio del tiempo extra</h2>
        <p className="text-sm muted">Si a un hijo no le llegan los minutos, puede pagar lo que falta con puntos o con dinero de su banco. Este es el precio de cada 15 minutos.</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="Puntos por cada 15 min">{(id) => <input id={id} className="field num w-28 font-bold" inputMode="numeric" value={pts === '' ? String(q.data?.pointsPer15 ?? '') : pts} onChange={(e) => setPts(e.target.value.replace(/\D/g, '') || '0')} />}</Field>
        <Field label={`Dinero por cada 15 min (${currencySymbol()})`}>{(id) => <input id={id} className="field num w-28 font-bold" inputMode="decimal" value={cents === '' ? (q.data ? (q.data.centsPer15 / 100).toFixed(2).replace('.', decimalSep()) : '') : cents} onChange={(e) => setCents(e.target.value)} />}</Field>
        <Button variant="secondary" loading={save.isPending} disabled={!valid} onClick={() => save.mutate()}>Guardar precio</Button>
      </div>
    </section>
  );
}
