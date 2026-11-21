import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { newKey, post } from '../lib/api';
import { euros, parseEuros } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { minutesLabel } from '../lib/deadline';
import { PAY_METHODS, SCREEN_CATEGORIES, screenPhrase } from '../lib/screen';
import type { PayMethod, ScreenCategory, User, Wallet } from '../lib/types';
import { Button, Field, Sheet, useToast } from '../components/ui';

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
          className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm font-bold transition ${value === o.value ? 'border-sky bg-sky/15 text-[var(--fg)]' : 'border-[var(--line)] bg-[var(--chip)] text-[var(--fg-3)]'}`}
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

const eurInput = (c: number) => (c / 100).toFixed(2).replace('.', ',');

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

/** Registrar un pago de dinero (Panel y Mesada). Misma clave en reintentos = sin pagos duplicados. */
export function PaySheet({ child, wallet, onClose }: { child: User; wallet: Wallet; onClose: () => void }) {
  const [amount, setAmount] = useState(wallet.cents_pending > 0 ? eurInput(wallet.cents_pending) : '');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [key] = useState(newKey);
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
      <p className="mb-4 muted">Saldo pendiente: <strong className="num text-[var(--fg)]">{euros(wallet.cents_pending)}</strong>. Anota aquí el dinero que le das.</p>
      <div className="space-y-4">
        <Field label="Importe (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <MethodPicker value={method} onChange={setMethod} />
        <NoteField value={note} onChange={setNote} max={300} />
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
      </div>
    </Sheet>
  );
}

/** «Dar pantalla»: gasta minutos del saldo común y deja en qué se usaron. */
export function GiveScreenSheet({ child, minutes, onClose }: { child: User; minutes: number; onClose: () => void }) {
  const [value, setValue] = useState('');
  const [category, setCategory] = useState<ScreenCategory>('videojuegos');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => post('/screen/spend', { userId: child.id, minutes: parseMinutes(value, 1440), category, note }),
    onSuccess: (r) => {
      toast(r.applied < r.requested ? `Solo tenía ${r.applied} min. Le quedan 0 min` : `Hecho. Le quedan ${minutesLabel(r.balance)}`);
      invalidate();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={`Dar pantalla a ${child.display_name}`} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>Dar minutos</Button>}>
      <div className="space-y-4">
        <p className="muted">Le quedan <strong className="num text-[var(--fg)]">{minutesLabel(minutes)}</strong>. Los minutos salen de su saldo.</p>
        <MinutesField value={value} onChange={setValue} />
        <CategoryPicker value={category} onChange={setCategory} />
        <NoteField value={note} onChange={setNote} />
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
      </div>
    </Sheet>
  );
}

/** El hijo pide su dinero (hasta lo que tiene por cobrar). */
export function RequestMoneySheet({ balanceCents, onClose }: { balanceCents: number; onClose: () => void }) {
  const [amount, setAmount] = useState(eurInput(balanceCents));
  const [note, setNote] = useState('');
  const [key] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => {
      const cents = parseEuros(amount);
      if (!cents) throw new Error('Escribe un importe, por ejemplo 5,50');
      if (cents > balanceCents) throw new Error(`Solo tienes ${euros(balanceCents)} por cobrar`);
      return post('/payout-requests', { kind: 'money', amountCents: cents, note: note || undefined }, key);
    },
    onSuccess: () => { toast('Petición enviada. Un adulto la verá'); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title="Pedir mi dinero" footer={<Button className="w-full" variant="success" loading={send.isPending} onClick={() => send.mutate()}>Enviar petición</Button>}>
      <div className="space-y-4">
        <p className="muted">Tienes <strong className="num text-[var(--fg)]">{euros(balanceCents)}</strong> por cobrar. Pide lo que quieras, hasta esa cantidad.</p>
        <Field label="¿Cuánto quieres? (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <NoteField value={note} onChange={setNote} />
      </div>
    </Sheet>
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
