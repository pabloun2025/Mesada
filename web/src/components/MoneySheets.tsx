import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { newKey, post } from '../lib/api';
import { euros, refCode } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { PAY_METHODS, SCREEN_CATEGORIES } from '../lib/screen';
import type { PayMethod, ScreenCategory, User, Wallet } from '../lib/types';
import { Field, useToast } from '../components/ui';
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
