import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api, newKey, post } from '../lib/api';
import { euros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useScreenState } from '../lib/screen-state';
import { minutesHM } from '../lib/deadline';
import { unlockAudio } from '../lib/alarm';
import type { ScreenCategory, ScreenState, User } from '../lib/types';
import { Field, Segmented, Sheet, Button, Toggle, useToast } from './ui';
import { AmountSheet } from './AmountSheet';
import { CategoryPicker } from './MoneySheets';

/** Lo que cuestan `m` minutos a razón de `per15` por cada 15 min (redondeo hacia arriba, igual que el servidor). */
const cost = (m: number, per15: number) => Math.ceil((m * per15) / 15);

type PayWith = 'debt' | 'points' | 'money';

function Note({ value, onChange, label = 'Para qué (opcional)', hint }: { value: string; onChange: (v: string) => void; label?: string; hint?: string }) {
  return <Field label={label} hint={hint}>{(id) => <input id={id} className="field" value={value} maxLength={200} placeholder="TikTok, videojuegos…" onChange={(e) => onChange(e.target.value)} />}</Field>;
}

/** El hijo enciende su temporizador (15/30/60 min o a medida). Si la familia exige aprobación, antes lo aprueba un adulto. */
export function UseScreenSheet({ state, userId, onClose }: { state: ScreenState; userId: string; onClose: () => void }) {
  const [category, setCategory] = useState<ScreenCategory>('videojuegos');
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: (minutes: number) => post('/screen/sessions', { minutes, category }, key),
    onSuccess: (r) => {
      toast(r.session.status === 'pending' ? 'Petición enviada. Un adulto tiene que aprobarla' : 'Temporizador en marcha');
      invalidate();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  void userId;
  return (
    <AmountSheet
      title="Usar pantalla" subtitle={<>Puedes usar hasta <b className="num text-[var(--fg)]">{minutesHM(state.max_minutes)}</b> ahora</>}
      unit="min" max={state.max_minutes} chips={[15, 30, 60]} variant="success"
      info={state.plan.require_approval ? <span className="font-bold">Un adulto tiene que aprobarlo antes de empezar.</span> : undefined}
      after={(v) => <>Te quedarán {minutesHM(Math.max(0, state.balance - v))} si lo usas entero</>}
      overReason={(m) => (state.today.cap_left != null && m === state.today.cap_left ? `Hoy solo te quedan ${minutesHM(m)} según tu plan` : `Ahora puedes usar como mucho ${minutesHM(m)}`)}
      extra={<CategoryPicker value={category} onChange={setCategory} label="¿En qué?" />}
      cta={(v) => (v ? `${state.plan.require_approval ? 'Pedir' : 'Empezar'} ${minutesHM(v)}` : 'Usar pantalla')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); unlockAudio(); send.mutate(v); }} onClose={onClose}
    />
  );
}

/** Elige cómo se paga lo que no cubren los minutos: puntos o dinero (hijo) o también deuda de la semana siguiente (adulto). */
function PayChoice({ value, onChange, short, rates, wallet, allowDebt }: { value: PayWith; onChange: (v: PayWith) => void; short: number; rates: ScreenState['rates']; wallet: ScreenState['wallet']; allowDebt: boolean }) {
  if (short <= 0) return null;
  const pts = cost(short, rates.pointsPer15);
  const cents = cost(short, rates.centsPer15);
  const opts: { value: PayWith; label: string }[] = [
    ...(allowDebt ? [{ value: 'debt' as const, label: 'Semana siguiente' }] : []),
    { value: 'points', label: `${pts} puntos` },
    { value: 'money', label: euros(cents) },
  ];
  const afford = value === 'points' ? wallet.points >= pts : value === 'money' ? wallet.cents >= cents : true;
  return (
    <div>
      <p className="mb-1 text-sm font-bold text-[var(--fg-2)]">No llegan los minutos: faltan {short} min. ¿Cómo se cobran?</p>
      <Segmented label="Cobrar con" value={value} onChange={onChange} options={opts} wrap />
      {!afford ? <p role="alert" className="mt-1.5 text-sm font-bold text-berry-deep">{value === 'points' ? `Solo hay ${wallet.points} puntos.` : `Solo hay ${euros(wallet.cents)}.`}</p> : null}
      {value === 'debt' ? <p className="mt-1.5 text-sm muted">Se descuentan de la semana siguiente.</p> : null}
    </div>
  );
}

/** El hijo pide tiempo extra: se descuenta de su saldo (y, si le faltan minutos, de puntos o dinero) cuando un adulto lo aprueba. No hay temporizador. */
export function ExtraSheet({ state, onClose }: { state: ScreenState; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [payWith, setPayWith] = useState<PayWith>('points');
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const [value, setValue] = useState(0);
  const send = useMutation({
    mutationFn: (minutes: number) => post('/screen/sessions', { minutes, extra: true, note: note || undefined, payWith: minutes > state.balance ? payWith : undefined }, key),
    onSuccess: () => { toast('Petición enviada. Un adulto la verá'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  const short = Math.max(0, value - state.balance);
  return (
    <AmountSheet
      title="Pedir tiempo extra" subtitle={<>Tienes <b className="num text-[var(--fg)]">{minutesHM(state.balance)}</b>. Se descuentan cuando un adulto lo apruebe.</>}
      unit="min" max={240} chips={[15, 30]} variant="success"
      after={(v) => { return v <= state.balance ? <>Te quedarían {minutesHM(state.balance - v)}</> : <>Te faltarían {v - state.balance} min</>; }}
      extra={(
        <>
          <Note value={note} onChange={setNote} />
          <PayChoice value={payWith === 'debt' ? 'points' : payWith} onChange={setPayWith} short={short} rates={state.rates} wallet={state.wallet} allowDebt={false} />
        </>
      )}
      cta={(v) => { if (v !== value) queueMicrotask(() => setValue(v)); return v ? `Pedir ${minutesHM(v)} más` : 'Pedir tiempo extra'; }}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

/** «Dar minutos» (adulto): descuenta al instante del saldo del hijo, sin temporizador. Si no le llegan, cobra en puntos, dinero o deuda. */
export function GiveMinutesSheet({ child, onClose }: { child: User; onClose: () => void }) {
  const q = useScreenStateFor(child.id);
  const [note, setNote] = useState('');
  const [payWith, setPayWith] = useState<PayWith>('debt');
  const [value, setValue] = useState(0);
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const s = q.data;
  const balance = s?.balance ?? 0;
  const send = useMutation({
    mutationFn: (minutes: number) => post('/screen/sessions', { userId: child.id, minutes, mode: 'charge', note: note || undefined, payWith: minutes > balance ? payWith : undefined }, undefined),
    onSuccess: (r) => {
      const x = r.session;
      toast(`Hecho: ${x.used_minutes} min${x.paid_points ? ` (${x.paid_points} puntos)` : x.paid_cents ? ` (${euros(x.paid_cents)})` : ''} para ${child.display_name}`);
      invalidate();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  const short = Math.max(0, value - balance);
  return (
    <AmountSheet
      title={`Dar minutos a ${child.display_name}`} subtitle={<>Le quedan <b className="num text-[var(--fg)]">{minutesHM(balance)}</b>. Se descuentan ya, sin temporizador.</>}
      unit="min" max={720} chips={[15, 30, 60]} variant="success"
      after={(v) => { return v <= balance ? <>Le quedarán {minutesHM(balance - v)}</> : <>Le faltan {v - balance} min</>; }}
      extra={(
        <>
          <Note value={note} onChange={setNote} hint="Quedará en su historial." />
          {s ? <PayChoice value={payWith} onChange={setPayWith} short={short} rates={s.rates} wallet={s.wallet} allowDebt /> : null}
        </>
      )}
      cta={(v) => { if (v !== value) queueMicrotask(() => setValue(v)); return v ? `Dar ${minutesHM(v)}` : 'Dar minutos'; }}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

const useScreenStateFor = (userId: string) => useScreenState(userId, true, true);

/** «Encender temporizador» (adulto): cuenta atrás en el móvil del hijo y en el del adulto; se cobra lo usado al parar o al acabar. */
export function TimerSheet({ child, onClose }: { child: User; onClose: () => void }) {
  const q = useScreenStateFor(child.id);
  const [category, setCategory] = useState<ScreenCategory>('videojuegos');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: (minutes: number) => post('/screen/sessions', { userId: child.id, minutes, category, note: note || undefined }),
    onSuccess: () => { toast(`Temporizador encendido para ${child.display_name}`); unlockAudio(); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  const s = q.data;
  return (
    <AmountSheet
      title={`Encender temporizador de ${child.display_name}`} subtitle={s ? <>Le quedan <b className="num text-[var(--fg)]">{minutesHM(s.balance)}</b>. Se cobra lo que use de verdad.</> : undefined}
      unit="min" max={720} chips={[15, 30, 60]} variant="success"
      blocked={!!s && !!s.session}
      info={s?.session ? <span className="font-bold">Ya tiene un temporizador abierto.</span> : s && !s.can_start && s.reason_code === 'blocked' ? <span className="font-bold text-berry-deep">{s.reason}</span> : undefined}
      extra={<><CategoryPicker value={category} onChange={setCategory} label="¿En qué?" /><Note value={note} onChange={setNote} /></>}
      cta={(v) => (v ? `Encender ${minutesHM(v)}` : 'Encender temporizador')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

/** Regalar o quitar minutos a mano (ajuste manual, con motivo). */
export function ManualMinutesSheet({ child, onClose }: { child: User; onClose: () => void }) {
  const [mode, setMode] = useState<'gift' | 'take'>('gift');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: (n: number) => {
      if (!note.trim()) throw new Error('Cuéntale por qué');
      return post('/screen/adjust', { userId: child.id, delta: mode === 'gift' ? n : -n, note });
    },
    onSuccess: (r) => { toast(`Hecho. Le quedan ${minutesHM(r.balance)}`); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <AmountSheet
      title={`Ajuste manual para ${child.display_name}`} unit="min" max={1440} chips={[15, 30, 60]} variant="success"
      extra={(
        <>
          <Segmented label="Qué hacer" value={mode} onChange={setMode} options={[{ value: 'gift', label: 'Regalar' }, { value: 'take', label: 'Quitar' }]} />
          <Field label="Motivo">{(id) => <input id={id} className="field" value={note} maxLength={200} onChange={(e) => setNote(e.target.value)} />}</Field>
        </>
      )}
      cta={(v) => (v ? `${mode === 'gift' ? 'Regalar' : 'Quitar'} ${minutesHM(v)}` : 'Ajustar')}
      error={error} loading={send.isPending} onSubmit={(v) => { setError(''); send.mutate(v); }} onClose={onClose}
    />
  );
}

const todayPlus = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Castigo: bloquea días enteros o una franja horaria, con motivo y fin; opcionalmente con un reto que lo levanta o lo acorta. */
export function BlockSheet({ child, onClose }: { child: User; onClose: () => void }) {
  const [kind, setKind] = useState<'days' | 'window'>('days');
  const [endsOn, setEndsOn] = useState(todayPlus(2));
  const [from, setFrom] = useState('20:00');
  const [to, setTo] = useState('22:00');
  const [reason, setReason] = useState('');
  const [withChallenge, setWithChallenge] = useState(false);
  const [text, setText] = useState('');
  const [photo, setPhoto] = useState(false);
  const [effect, setEffect] = useState<'lift' | 'shorten'>('lift');
  const [days, setDays] = useState('1');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => post('/screen/blocks', {
      userId: child.id, kind, reason, endsOn, ...(kind === 'window' ? { windowStart: from, windowEnd: to } : {}),
      challenge: withChallenge && text.trim() ? { text, photo, effect, ...(effect === 'shorten' ? { days: Number(days) } : {}) } : null,
    }),
    onSuccess: (r) => { toast(r.label); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet
      open onClose={onClose} title={`Bloquear pantalla a ${child.display_name}`} subtitle="Se verá en su app con el motivo y cuándo termina."
      footer={<>{error ? <p role="alert" className="mb-2 text-center text-sm font-bold text-berry-deep">{error}</p> : null}<Button size="lg" className="w-full" loading={save.isPending} disabled={!reason.trim() || (withChallenge && !text.trim())} onClick={() => { setError(''); save.mutate(); }}>Poner el bloqueo</Button></>}
    >
      <div className="space-y-5 pt-1">
        <Segmented label="Tipo de bloqueo" value={kind} onChange={setKind} options={[{ value: 'days', label: 'Días enteros' }, { value: 'window', label: 'Una franja' }]} />
        {kind === 'window' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Desde">{(id) => <input id={id} type="time" className="field num" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
            <Field label="Hasta">{(id) => <input id={id} type="time" className="field num" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          </div>
        ) : null}
        <Field label="Último día de bloqueo (incluido)" hint={kind === 'window' ? 'La franja se repite cada día hasta esa fecha.' : undefined}>
          {(id) => <input id={id} type="date" className="field" min={todayPlus(0)} value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />}
        </Field>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Atajos de fecha">
          {[['Solo hoy', 0], ['Hasta mañana', 1], ['3 días', 2], ['Una semana', 6]].map(([l, n]) => (
            <button key={l} type="button" onClick={() => setEndsOn(todayPlus(n as number))} className={`h-11 rounded-full border px-3.5 text-sm font-bold ${endsOn === todayPlus(n as number) ? 'border-sky bg-sky/15' : 'border-[var(--line)] bg-[var(--chip)] text-[var(--fg-3)]'}`}>{l}</button>
          ))}
        </div>
        <Field label="Motivo">{(id) => <input id={id} className="field" value={reason} maxLength={200} placeholder="Notas del cole, gritos…" onChange={(e) => setReason(e.target.value)} />}</Field>
        <Toggle checked={withChallenge} onChange={setWithChallenge} label="Añadir un reto" description="Si lo cumple y lo validas, el bloqueo se levanta o se acorta." />
        {withChallenge ? (
          <div className="space-y-4 rounded-2xl border border-[var(--line)] p-3.5">
            <Field label="El reto">{(id) => <input id={id} className="field" value={text} maxLength={300} placeholder="Lee 20 min, ordena tu cuarto…" onChange={(e) => setText(e.target.value)} />}</Field>
            <Toggle checked={photo} onChange={setPhoto} label="Pedir una foto como prueba" />
            <div>
              <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Al validarlo</p>
              <Segmented label="Al validarlo" value={effect} onChange={setEffect} options={[{ value: 'lift', label: 'Se levanta' }, { value: 'shorten', label: 'Se acorta' }]} />
            </div>
            {effect === 'shorten' ? <Field label="Días que se acortan">{(id) => <input id={id} className="field num w-24 font-bold" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))} />}</Field> : null}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/** El hijo cumple su reto: nota y, si hace falta, foto. */
export function ChallengeDoneSheet({ blockId, text, photoRequired, onClose }: { blockId: string; text: string; photoRequired: boolean; onClose: () => void }) {
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => {
      if (photoRequired && !file) throw new Error('Haz una foto como prueba');
      const form = new FormData();
      if (note) form.set('note', note);
      if (file) form.set('photo', file);
      return api(`/screen/blocks/${blockId}/challenge/done`, { method: 'POST', form });
    },
    onSuccess: () => { toast('Enviado. Un adulto lo validará'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title="Reto cumplido" subtitle={`«${text}»`}
      footer={<>{error ? <p role="alert" className="mb-2 text-center text-sm font-bold text-berry-deep">{error}</p> : null}<Button size="lg" className="w-full" loading={send.isPending} onClick={() => { setError(''); send.mutate(); }}>Enviar a un adulto</Button></>}>
      <div className="space-y-4 pt-1">
        <Field label="Cuéntalo (opcional)">{(id) => <input id={id} className="field" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />}</Field>
        <Field label={photoRequired ? 'Foto de prueba (obligatoria)' : 'Foto (opcional)'}>
          {(id) => <input id={id} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="field" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />}
        </Field>
      </div>
    </Sheet>
  );
}
