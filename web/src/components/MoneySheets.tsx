import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, newKey, post } from '../lib/api';
import { euros, refCode } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { minutesHM, minutesLabel } from '../lib/deadline';
import { PAY_METHODS, SCREEN_CATEGORIES, screenPhrase } from '../lib/screen';
import type { PayMethod, ScreenCategory, ScreenView, User, Wallet } from '../lib/types';
import { Button, Field, Segmented, Sheet, useToast } from '../components/ui';
import { AmountSheet } from './AmountSheet';
import { useReceipt } from './Receipt';

/** Grupo de opciones en fila que salta de línea: cabe en 375 px aunque haya seis categorías. */
function ChipRadio<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string; emoji?: string }[] }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={`inline-flex h-11 items-center gap-1.5 rounded-full border px-3.5 text-sm font-bold transition ${value === o.value ? 'border-sky bg-sky/15 text-[var(--fg)]' : 'border-[var(--line)] bg-[var(--chip)] text-[var(--fg-3)]'}`}
        >
          {o.emoji ? <span aria-hidden>{o.emoji}</span> : null}{o.label}
        </button>
      ))}
    </div>
  );
}

export function MethodPicker({ value, onChange }: { value: PayMethod; onChange: (v: PayMethod) => void }) {
  return (
    <div>
      <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Forma de pago</p>
      <ChipRadio label="Forma de pago" value={value} onChange={onChange} options={PAY_METHODS} />
    </div>
  );
}

export function CategoryPicker({ value, onChange, label = '¿En qué?' }: { value: ScreenCategory; onChange: (v: ScreenCategory) => void; label?: string }) {
  return (
    <div>
      <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">{label}</p>
      <ChipRadio label={label} value={value} onChange={onChange} options={SCREEN_CATEGORIES} />
    </div>
  );
}

/** Minutos escritos por el usuario: entero positivo o null. */
function parseMinutes(s: string, max: number): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) throw new Error('Escribe los minutos');
  if (n > max) throw new Error(`Máximo ${minutesLabel(max)}`);
  return n;
}

function MinutesField({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return <Field label="Minutos">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="numeric" autoFocus={autoFocus} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />}</Field>;
}

function NoteField({ value, onChange, label = 'Nota (opcional)', max = 200 }: { value: string; onChange: (v: string) => void; label?: string; max?: number }) {
  return <Field label={label}>{(id) => <input id={id} className="field" value={value} onChange={(e) => onChange(e.target.value)} maxLength={max} />}</Field>;
}

/** Pagar a un hijo (Panel y Banca familiar): hoja de importe, forma de pago y recibo. Misma clave en reintentos = sin pagos duplicados. */
export function PaySheet({ child, wallet, onClose }: { child: User; wallet: Wallet; onClose: () => void }) {
  const [method, setMethod] = useState<PayMethod>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const showReceipt = useReceipt();
  const pay = useMutation({
    mutationFn: (cents: number) => post('/payments', { userId: child.id, amountCents: cents, method, note: note || undefined }, key),
    onSuccess: (r) => {
      invalidate();
      onClose();
      if (r.payment.duplicate) return toast('Este pago ya estaba registrado');
      showReceipt({
        title: 'Pago registrado', amount: euros(r.payment.amount_cents), at: new Date(r.payment.created_at ?? Date.now()), ref: refCode('PG', r.payment.id),
        rows: [{ label: 'A', value: child.display_name }, { label: 'Forma de pago', value: PAY_METHODS.find((m) => m.value === method)?.label ?? '' }, { label: 'Importe', value: euros(r.payment.amount_cents) }],
        total: { label: 'Le quedan', value: euros(wallet.cents_pending - r.payment.amount_cents) },
        notice: { title: `Avisamos a ${child.display_name}.`, sub: note || undefined, avatar: { name: child.display_name, avatar: child.avatar, color: child.color } },
      });
    },
    onError: (e: Error) => { setError(e.message); toast(e.message, 'error'); },
  });
  return (
    <AmountSheet
      title={`Pagar a ${child.display_name}`} subtitle={<>Saldo pendiente: <b className="text-[var(--fg)]">{euros(wallet.cents_pending)}</b></>}
      unit="eur" max={Math.max(0, wallet.cents_pending)} initial={Math.max(0, wallet.cents_pending)} chips={[500, 1000]} variant="success"
      after={(v) => <>Le quedarán {euros(wallet.cents_pending - v)}</>}
      overReason={(m) => `Solo debes ${euros(m)}`}
      extra={<><MethodPicker value={method} onChange={setMethod} /><NoteField value={note} onChange={setNote} max={300} /></>}
      cta={(v) => (v ? `Pagar ${euros(v)}` : 'Pagar')}
      error={error} loading={pay.isPending} onSubmit={(v) => { setError(''); pay.mutate(v); }} onClose={onClose}
    />
  );
}

/**
 * «Dar pantalla»: hoja de importe con teclado (como el resto del banco). «Dar» gasta minutos del saldo y deja en qué se usaron;
 * «Regalar» suma minutos extra con un motivo. En pausa no se pueden dar minutos.
 */
export function GiveScreenSheet({ child, minutes, onClose }: { child: User; minutes: number; onClose: () => void }) {
  const [mode, setMode] = useState<'spend' | 'gift'>('spend');
  const [category, setCategory] = useState<ScreenCategory>('videojuegos');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const view = useQuery({ queryKey: ['screen', child.id], queryFn: () => api<ScreenView>(`/screen/${child.id}`) });
  const pause = view.data?.pause ?? null;
  const save = useMutation({
    mutationFn: (n: number) => {
      if (mode === 'spend') return post('/screen/spend', { userId: child.id, minutes: n, category, note });
      if (!note.trim()) throw new Error('Cuéntale por qué se los regalas');
      return post('/screen/adjust', { userId: child.id, delta: n, note });
    },
    onSuccess: (r) => {
      toast(mode === 'spend' && r.applied < r.requested ? `Solo tenía ${r.applied} min. Le quedan 0 min` : `Hecho. Le quedan ${minutesHM(r.balance)}`);
      invalidate();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <AmountSheet
      title={`Dar pantalla a ${child.display_name}`}
      subtitle={<>Le quedan <b className="num text-[var(--fg)]">{minutesHM(minutes)}</b></>}
      unit="min" max={mode === 'spend' ? minutes : 1440} chips={[15, 30, 60]} variant="success"
      blocked={mode === 'spend' && !!pause}
      info={mode === 'spend' && pause ? <span className="font-bold text-berry-deep">{pause.label}: ahora no se pueden dar minutos</span> : undefined}
      after={(v) => (mode === 'spend' ? <>Le quedarán {minutesHM(minutes - v)}</> : <>Tendrá {minutesHM(minutes + v)}</>)}
      overReason={(m) => (mode === 'spend' ? `Solo le quedan ${minutesHM(m)}` : `Como mucho ${minutesHM(m)}`)}
      extra={(
        <>
          <Segmented label="Qué hacer" value={mode} onChange={setMode} options={[{ value: 'spend', label: 'Dar' }, { value: 'gift', label: 'Regalar' }]} />
          {mode === 'spend' ? <CategoryPicker value={category} onChange={setCategory} /> : null}
          <NoteField value={note} onChange={setNote} label={mode === 'spend' ? 'Nota (opcional)' : 'Motivo'} />
        </>
      )}
      cta={(v) => (v ? `${mode === 'spend' ? 'Dar' : 'Regalar'} ${minutesHM(v)}` : mode === 'spend' ? 'Dar minutos' : 'Regalar minutos')}
      error={error} loading={save.isPending} onSubmit={(v) => { setError(''); save.mutate(v); }} onClose={onClose}
    />
  );
}

/** El hijo pide minutos de pantalla para una categoría. */
export function RequestScreenSheet({ balance, onClose }: { balance: number; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [category, setCategory] = useState<ScreenCategory>('videojuegos');
  const [note, setNote] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => post('/payout-requests', { kind: 'screen', minutes: parseMinutes(value, balance), category, note: note || undefined }, key),
    onSuccess: () => { toast('Petición enviada. Un adulto la verá'); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Pedir pantalla" footer={<Button className="w-full" loading={send.isPending} onClick={() => send.mutate()}>Enviar petición</Button>}>
      <div className="space-y-4">
        <p className="muted">Te quedan <strong className="num text-[var(--fg)]">{minutesLabel(balance)}</strong>. Los minutos se restan cuando un adulto lo apruebe.</p>
        <MinutesField value={value} onChange={setValue} />
        <CategoryPicker value={category} onChange={setCategory} />
        <NoteField value={note} onChange={setNote} />
      </div>
    </Sheet>
  );
}

/** El hijo anota lo que ya ha usado: se resta al momento y un adulto lo confirma. */
export function LogScreenSheet({ balance, onClose }: { balance: number; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [category, setCategory] = useState<ScreenCategory>('videojuegos');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => post('/screen-logs', { minutes: parseMinutes(value, 720), category, note: note || undefined }, key),
    onSuccess: (r) => {
      const l = r.log;
      toast(l.overflow_minutes > 0 ? `Anotado. Te pasaste ${l.overflow_minutes} min: hoy no hay puntos de honestidad` : `Anotado: ${screenPhrase(l.minutes, l.category)}. Falta que lo confirme un adulto`, l.overflow_minutes > 0 ? 'error' : 'ok');
      setKey(newKey());
      invalidate();
      onClose();
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Anotar pantalla" footer={<Button className="w-full" loading={send.isPending} onClick={() => send.mutate()}>Anotar</Button>}>
      <div className="space-y-4">
        <p className="muted">Cuenta lo que has usado hoy. Se resta ya de tus <strong className="num text-[var(--fg)]">{minutesLabel(balance)}</strong>. Si un adulto lo confirma, ganas 5 puntos por ser honesto (una vez al día).</p>
        <MinutesField value={value} onChange={setValue} />
        <CategoryPicker value={category} onChange={setCategory} label="¿En qué has usado la pantalla?" />
        <NoteField value={note} onChange={setNote} />
      </div>
    </Sheet>
  );
}
