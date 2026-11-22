import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import { fmtDate } from '../lib/format';
import { minutesHM } from '../lib/deadline';
import type { ExtraCatalogItem, ScreenReason, User } from '../lib/types';
import { Button, Field, Segmented, Sheet, useToast } from './ui';

/** «−15 min» o «Pausa de 1 día»: el efecto habitual de un motivo. */
export const reasonEffect = (r: Pick<ScreenReason, 'effect' | 'minutes' | 'pause_days'>) =>
  r.effect === 'minutes' ? `−${minutesHM(r.minutes ?? 0)}` : `Pausa de ${r.pause_days} ${r.pause_days === 1 ? 'día' : 'días'}`;

/**
 * «Ajuste de pantalla»: el adulto elige un motivo en positivo (lo que se busca), su efecto (quitar minutos o pausar unos días),
 * una nota amable opcional y, si quiere, un trabajo extra con el que el hijo lo recupera.
 */
export function ScreenAdjustSheet({ child, onClose }: { child: User; onClose: () => void }) {
  const reasons = useQuery({ queryKey: ['screen-reasons'], queryFn: () => api<{ reasons: ScreenReason[] }>('/screen/reasons') });
  const extras = useQuery({ queryKey: ['extras'], queryFn: () => api<{ catalog?: ExtraCatalogItem[] }>('/extras') });
  const [reasonId, setReasonId] = useState('');
  const [effect, setEffect] = useState<'minutes' | 'pause'>('minutes');
  const [minutes, setMinutes] = useState('15');
  const [days, setDays] = useState('1');
  const [note, setNote] = useState('');
  const [recovery, setRecovery] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();

  const pick = (r: ScreenReason) => {
    setReasonId(r.id);
    setEffect(r.effect);
    if (r.minutes) setMinutes(String(r.minutes));
    if (r.pause_days) setDays(String(r.pause_days));
  };
  const apply = useMutation({
    mutationFn: () => {
      if (!reasonId) throw new Error('Elige un motivo');
      const n = Number(effect === 'minutes' ? minutes : days);
      if (!Number.isInteger(n) || n < 1) throw new Error(effect === 'minutes' ? 'Escribe los minutos' : 'Escribe los días');
      return post('/screen/adjustments', {
        userId: child.id, reasonId, effect, note: note.trim() || undefined, recoveryTaskId: recovery || null,
        ...(effect === 'minutes' ? { minutes: n } : { pauseDays: n }),
      });
    },
    onSuccess: (r) => {
      toast(r.effect === 'minutes' ? `Ajuste aplicado: −${r.applied} min${r.applied < r.requested ? ' (era todo lo que tenía)' : ''}` : `Pausa puesta hasta el ${fmtDate(r.until, { weekday: 'long', day: 'numeric', month: 'short' })}`);
      invalidate();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  const list = reasons.data?.reasons ?? [];
  const catalog = extras.data?.catalog ?? [];
  return (
    <Sheet
      open
      onClose={onClose}
      title={`Ajuste de pantalla para ${child.display_name}`}
      subtitle="Elige lo que quieres que mejore. Se lo decimos con buenas palabras."
      footer={
        <>
          {error ? <p role="alert" className="mb-2 text-center text-sm font-bold text-berry-deep">{error}</p> : null}
          <Button size="lg" className="w-full" loading={apply.isPending} disabled={!reasonId} onClick={() => { setError(''); apply.mutate(); }}>Aplicar ajuste</Button>
        </>
      }
    >
      <div className="space-y-5 pt-1">
        <div>
          <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Motivo</p>
          <div role="radiogroup" aria-label="Motivo" className="grid gap-2">
            {list.map((r) => (
              <button
                key={r.id}
                type="button"
                role="radio"
                aria-checked={reasonId === r.id}
                onClick={() => pick(r)}
                className={`flex min-h-12 items-center justify-between gap-3 rounded-2xl border px-4 py-2 text-left transition ${reasonId === r.id ? 'border-sky bg-sky/15' : 'border-[var(--line)] bg-[var(--chip)]'}`}
              >
                <span className="font-bold">{r.title}</span>
                <span className="num shrink-0 text-sm muted">{reasonEffect(r)}</span>
              </button>
            ))}
            {!list.length && !reasons.isLoading ? <p className="muted">Crea motivos en Ajustes.</p> : null}
          </div>
        </div>
        {reasonId ? (
          <>
            <div>
              <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Efecto</p>
              <Segmented label="Efecto" value={effect} onChange={setEffect} options={[{ value: 'minutes', label: 'Quitar minutos' }, { value: 'pause', label: 'Pausa' }]} />
            </div>
            {effect === 'minutes' ? (
              <Field label="Minutos que se quitan" hint="Primero salen los que caducan antes. Nunca baja de 0.">
                {(id) => <input id={id} className="field num w-28 text-xl font-bold" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, ''))} />}
              </Field>
            ) : (
              <Field label="Días de pausa" hint="No puede gastar ni pedir minutos; sus minutos no caducan y sigue ganando.">
                {(id) => <input id={id} className="field num w-28 text-xl font-bold" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />}
              </Field>
            )}
            <Field label="Nota amable (opcional)" hint="La verá en su historial. Cuéntale qué esperas la próxima vez.">
              {(id) => <textarea id={id} className="field min-h-18" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="Mañana lo intentamos juntos…" />}
            </Field>
            <Field label="Forma de recuperar (opcional)" hint={effect === 'minutes' ? 'Al hacer y validar este trabajo extra, recupera los minutos.' : 'Al hacer y validar este trabajo extra, termina la pausa.'}>
              {(id) => (
                <select id={id} className="field" value={recovery} onChange={(e) => setRecovery(e.target.value)}>
                  <option value="">Sin forma de recuperar</option>
                  {catalog.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.title}</option>)}
                </select>
              )}
            </Field>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
