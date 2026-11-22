import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Delete } from 'lucide-react';
import { Button, Sheet } from './ui';
import { euros } from '../lib/format';

/** Unidades: euros (con decimales) o enteros (puntos y minutos). */
export type AmountUnit = 'eur' | 'pts' | 'min';

/** Texto de teclado → cantidad: céntimos para euros, enteros para puntos y minutos. */
export function rawToValue(raw: string, unit: AmountUnit): number {
  const n = Number(raw.replace(',', '.') || '0');
  if (!Number.isFinite(n)) return 0;
  return unit === 'eur' ? Math.round(n * 100) : Math.floor(n);
}

export function valueToRaw(v: number, unit: AmountUnit): string {
  if (unit !== 'eur') return v > 0 ? String(v) : '';
  if (v <= 0) return '';
  return v % 100 === 0 ? String(v / 100) : (v / 100).toFixed(2).replace('.', ',').replace(/0$/, '');
}

/** Aplica una tecla al texto escrito: sin ceros a la izquierda, 2 decimales como mucho y un máximo de 6 cifras enteras. */
export function pressKey(raw: string, key: string, unit: AmountUnit): string {
  if (key === 'back') return raw.slice(0, -1);
  if (key === ',') {
    if (unit !== 'eur' || raw.includes(',')) return raw;
    return `${raw || '0'},`;
  }
  if (!/^\d$/.test(key)) return raw;
  if (raw.includes(',')) return raw.split(',')[1].length >= 2 ? raw : raw + key;
  if (raw === '0') return key;
  return raw.length >= 6 ? raw : raw + key;
}

/** Importe grande: lo escrito en tinta y los decimales que faltan en gris. */
function AmountDisplay({ raw, unit, over }: { raw: string; unit: AmountUnit; over: boolean }) {
  const [int, dec] = raw.split(',');
  const typedDec = dec ?? '';
  const ink = over ? 'text-berry-deep' : 'text-[var(--fg)]';
  return (
    <p aria-live="polite" className="num flex items-baseline justify-center text-[3.75rem] leading-none font-extrabold">
      <span className="sr-only">{unit === 'eur' ? euros(rawToValue(raw, 'eur')) : `${rawToValue(raw, unit)} ${unit === 'min' ? 'minutos' : 'puntos'}`}</span>
      <span aria-hidden className="inline-flex items-baseline">
        <span className={raw ? ink : 'text-[var(--line)]'}>{int || '0'}</span>
        {unit === 'eur' ? (
          <>
            <span className={dec !== undefined ? ink : 'text-[var(--line)]'}>,</span>
            <span className={ink}>{typedDec}</span>
            <span className="text-[var(--line)]">{'00'.slice(typedDec.length)}</span>
          </>
        ) : null}
        <span className="caret ml-0.5 inline-block h-12 w-[3px] self-center rounded-full bg-tangerine" />
        <span className="ml-2 text-3xl font-bold text-[var(--fg-3)]">{unit === 'eur' ? '€' : unit}</span>
      </span>
    </p>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', ',', '0', 'back'];

export interface AmountSheetProps {
  title: string;
  subtitle?: ReactNode;
  unit: AmountUnit;
  /** Máximo permitido (céntimos o puntos). */
  max: number;
  min?: number;
  initial?: number;
  /** Importe ya fijado: se oculta el teclado (p. ej. al aprobar un retiro). */
  locked?: boolean;
  /** Atajos: «Todo» es el máximo. */
  chips?: number[];
  /** Línea de contexto bajo los atajos («Retiros esta semana: 1 de 2»). */
  info?: ReactNode;
  /** Qué pasará con este importe («Te quedarán 7,50 €»). */
  after?: (value: number) => ReactNode;
  /** Texto del botón principal: dice la acción y el importe. */
  cta: (value: number) => string;
  /** Qué mostrar si el importe pasa del máximo o no llega al mínimo. */
  overReason?: (max: number) => string;
  underReason?: (min: number) => string;
  /** Campos extra (forma de pago, semanas…). */
  extra?: ReactNode;
  /** Bloquea el botón por algo ajeno al importe. */
  blocked?: boolean;
  loading?: boolean;
  error?: string;
  variant?: 'primary' | 'success';
  onSubmit: (value: number) => void;
  onClose: () => void;
}

/**
 * Hoja de importe con teclado numérico grande, para retirar, canjear, adelantar, pedir, ahorrar y pagar.
 * También acepta el teclado físico (cifras, coma o punto, retroceso e Intro).
 */
export function AmountSheet(p: AmountSheetProps) {
  const unit = p.unit;
  const [raw, setRaw] = useState(() => valueToRaw(p.initial ?? 0, unit));
  const value = rawToValue(raw, unit);
  const min = p.min ?? 1;
  const over = value > p.max;
  const under = value > 0 && value < min;
  const ok = value >= min && value <= p.max && !p.blocked;
  const fmt = (n: number) => (unit === 'eur' ? euros(n) : `${n} ${unit === 'min' ? 'min' : 'pts'}`);
  const reason = over ? (p.overReason?.(p.max) ?? `Como mucho ${fmt(p.max)}`) : under ? (p.underReason?.(min) ?? `Como mínimo ${fmt(min)}`) : '';

  useEffect(() => {
    if (p.locked) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select')) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Backspace') { e.preventDefault(); setRaw((r) => pressKey(r, 'back', unit)); }
      else if (e.key === ',' || e.key === '.') { e.preventDefault(); setRaw((r) => pressKey(r, ',', unit)); }
      else if (/^\d$/.test(e.key)) { e.preventDefault(); setRaw((r) => pressKey(r, e.key, unit)); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [p.locked, unit]);

  const chips = useMemo(() => {
    const list = (p.chips ?? []).filter((c) => c <= p.max && c >= min);
    return p.max >= min ? [...list.map((c) => ({ label: fmt(c), value: c })), { label: 'Todo', value: p.max }] : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.chips, p.max, min, unit]);

  return (
    <Sheet
      open
      onClose={p.onClose}
      title={p.title}
      subtitle={p.subtitle}
      footer={
        <>
          {reason ? <p role="alert" className="mb-2 text-center text-sm font-bold text-berry-deep">{reason}</p> : p.error ? <p role="alert" className="mb-2 text-center text-sm font-bold text-berry-deep">{p.error}</p> : null}
          <Button size="lg" variant={p.variant ?? 'primary'} className="w-full" disabled={!ok} loading={p.loading} onClick={() => ok && p.onSubmit(value)}>
            {value > 0 ? p.cta(value) : p.cta(0)}
          </Button>
        </>
      }
    >
      <div className="pt-2 pb-1">
        <AmountDisplay raw={raw} unit={unit} over={over} />
        <div className="mt-2 min-h-6 text-center text-sm text-[var(--fg-2)]" aria-live="polite">{value > 0 && !over ? p.after?.(value) : null}</div>
        {!p.locked && chips.length ? (
          <div className="mt-3 flex justify-center gap-2">
            {chips.map((c) => (
              <button
                key={c.label}
                type="button"
                aria-pressed={value === c.value}
                onClick={() => setRaw(valueToRaw(c.value, unit))}
                className={`num h-11 rounded-full border-[1.5px] px-[1.1rem] font-semibold transition ${value === c.value ? 'border-tangerine bg-tangerine-soft text-tangerine-deep dark:bg-tangerine/20' : 'border-transparent bg-[var(--chip)]'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        ) : null}
        {p.info ? <div className="mt-3 flex items-center justify-center gap-2 text-sm text-[var(--fg-2)]">{p.info}</div> : null}
        {p.extra ? <div className="mt-4 space-y-4">{p.extra}</div> : null}
        {!p.locked ? (
          <div role="group" aria-label="Teclado numérico" className="mt-4 grid grid-cols-3 gap-x-2.5 gap-y-2">
            {KEYS.map((k) => {
              const hidden = k === ',' && unit !== 'eur';
              if (hidden) return <span key={k} />;
              return (
                <button
                  key={k}
                  type="button"
                  aria-label={k === 'back' ? 'Borrar' : k === ',' ? 'Coma' : k}
                  onClick={() => setRaw((r) => pressKey(r, k, unit))}
                  className={`font-display flex h-14 items-center justify-center rounded-2xl text-[1.65rem] font-semibold transition active:scale-[0.96] active:bg-tangerine-soft ${k === ',' || k === 'back' ? 'text-[var(--fg-2)]' : 'bg-[var(--bg)]'}`}
                >
                  {k === 'back' ? <Delete size={24} aria-hidden /> : k}
                </button>
              );
            })}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}

/** Rayas que indican cuántos retiros (o similar) se han usado: «▮▯ Retiros esta semana: 1 de 2». */
export function Pips({ used, total }: { used: number; total: number }) {
  return (
    <span aria-hidden className="flex gap-1">
      {Array.from({ length: Math.min(total, 6) }, (_, i) => (
        <i key={i} className={`h-1.5 w-[18px] rounded-full ${i < used ? 'bg-tangerine' : 'bg-[var(--line)]'}`} />
      ))}
    </span>
  );
}
