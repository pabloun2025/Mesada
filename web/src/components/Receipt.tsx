import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Clock, Share2, X } from 'lucide-react';
import { Avatar, Button } from './ui';
import { GoldCoins } from './Coins';

export interface ReceiptData {
  title: string;
  /** Estado del trámite («Pendiente de pago»); si no hay, es una operación ya hecha. */
  badge?: string;
  /** Importe grande con su signo: «−10,00 €». */
  amount: string;
  rows: { label: string; value: string; sub?: string; mono?: boolean }[];
  /** Fila final destacada («Saldo nuevo»). */
  total?: { label: string; value: string };
  /** Recuadro de abajo: a quién avisamos o qué pasa ahora. */
  notice?: { title: string; sub?: string; avatar?: { name: string; avatar?: string | null; color?: string | null } };
  ref: string;
  at: Date;
  /** Monedas de adorno; por defecto, en los recibos con importe en euros. */
  coins?: boolean;
}

const Ctx = createContext<(r: ReceiptData) => void>(() => {});
/** Muestra el recibo de una operación hecha (sustituye al aviso emergente). */
export const useReceipt = () => useContext(Ctx);

const fmtWhen = (d: Date) => ({
  day: new Intl.DateTimeFormat('es-ES', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }).format(d).replace(',', ''),
  time: new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }).format(d),
});

/** Texto plano del recibo, para compartir o copiar. */
export function receiptText(r: ReceiptData) {
  const w = fmtWhen(r.at);
  const lines = [`DiploP · ${r.title}`, r.amount, `${w.day}, ${w.time}`, ...r.rows.map((x) => `${x.label}: ${x.value}`), r.total ? `${r.total.label}: ${r.total.value}` : '', `Ref. ${r.ref}`];
  return lines.filter(Boolean).join('\n');
}

export function ReceiptProvider({ children }: { children: ReactNode }) {
  const [receipt, setReceipt] = useState<ReceiptData | null>(null);
  const show = useCallback((r: ReceiptData) => setReceipt(r), []);
  return (
    <Ctx.Provider value={show}>
      {children}
      {receipt ? <ReceiptView key={receipt.ref + receipt.at.getTime()} r={receipt} onClose={() => setReceipt(null)} /> : null}
    </Ctx.Provider>
  );
}

function ReceiptView({ r, onClose }: { r: ReceiptData; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
  }, []);
  const w = fmtWhen(r.at);

  const share = async () => {
    const text = receiptText(r);
    try {
      if (navigator.share) await navigator.share({ title: `Recibo · ${r.title}`, text });
      else {
        await navigator.clipboard.writeText(text);
        setNote('Recibo copiado');
      }
    } catch (e) {
      // Cerrar el menú de compartir no es un error.
      if ((e as Error).name !== 'AbortError') setNote('No se ha podido compartir');
    }
  };

  return (
    <dialog
      ref={ref}
      onClose={onClose}
      aria-label={`Recibo: ${r.title}`}
      className="receipt-dialog fixed inset-0 m-0 h-dvh max-h-none w-full max-w-none overflow-y-auto bg-[linear-gradient(180deg,#1d5fae_0,#123f7e_55%,#142a5c_100%)] p-0 text-white"
    >
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col px-4 pb-6">
        <div className="relative flex items-center justify-center py-4">
          <b className="font-display">Recibo</b>
          <button type="button" aria-label="Cerrar recibo" onClick={onClose} className="absolute right-0 flex size-11 items-center justify-center rounded-full bg-white/15 transition hover:bg-white/25">
            <X size={20} aria-hidden />
          </button>
        </div>

        <div className="drop-shadow-[0_22px_20px_rgb(20_42_92/0.25)]">
          <article className="receipt-paper relative">
            {r.coins ?? r.amount.includes('€') ? <GoldCoins size={58} className="pointer-events-none absolute top-3 right-3" /> : null}
            <div className="relative mx-auto flex size-[68px] items-center justify-center rounded-full bg-leaf-soft text-leaf-deep before:absolute before:-inset-[7px] before:rounded-full before:border-2 before:border-leaf-soft before:content-['']">
              <Check size={34} strokeWidth={3} aria-hidden className="seal-icon" />
            </div>
            <h1 className="mt-[18px] text-center text-[1.65rem] font-extrabold">{r.title}</h1>
            {r.badge ? (
              <p className="mt-1.5 text-center">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-sun-soft px-3 py-1 text-sm font-bold text-sun-ink"><Clock size={15} aria-hidden /> {r.badge}</span>
              </p>
            ) : null}
            <p className="num mt-2.5 text-center text-5xl leading-[1.1] font-extrabold">{r.amount}</p>

            <dl className="mt-5 border-t-2 border-dashed border-[#e3e8f2] pt-1.5">
              <Row label="Fecha y hora" value={w.day} sub={w.time} />
              {r.rows.map((x) => <Row key={x.label} {...x} />)}
              <Row label="Referencia" value={r.ref} mono />
              {r.total ? (
                <div className="mt-1.5 flex items-baseline justify-between gap-4 border-t-2 border-dashed border-[#e3e8f2] pt-3.5">
                  <dt className="text-[#64738f]">{r.total.label}</dt>
                  <dd className="num text-xl font-bold">{r.total.value}</dd>
                </div>
              ) : null}
            </dl>

            {r.notice ? (
              <div className="mt-3.5 flex items-center gap-3 rounded-2xl bg-sun-soft px-3.5 py-3">
                {r.notice.avatar ? <Avatar name={r.notice.avatar.name} avatar={r.notice.avatar.avatar} colorKey={r.notice.avatar.color} size={40} /> : null}
                <div className="leading-snug">
                  <p className="font-bold">{r.notice.title}</p>
                  {r.notice.sub ? <p className="text-sm text-sun-ink">{r.notice.sub}</p> : null}
                </div>
              </div>
            ) : null}
            <div aria-hidden className="mt-5 flex h-[30px] justify-center gap-0.5 opacity-55">
              {[2, 1, 3, 1, 2, 4, 1, 2, 1, 3, 2, 1, 4, 1, 2, 3, 1, 2, 1, 3, 2, 4, 1, 2, 1, 3, 1, 2, 3, 1, 2, 1, 4, 2, 1, 3, 1, 2, 1].map((n, i) => (
                <i key={i} className="block bg-[#142a5c]" style={{ width: n }} />
              ))}
            </div>
          </article>
        </div>

        <div className="mt-auto grid gap-2.5 pt-6">
          <Button size="lg" className="w-full" onClick={onClose} autoFocus>Cerrar</Button>
          <button type="button" onClick={share} className="inline-flex h-14 items-center justify-center gap-2 rounded-full bg-white/15 text-lg font-bold transition hover:bg-white/25 active:scale-[0.97]">
            <Share2 size={20} aria-hidden /> Compartir
          </button>
          {/* Un aviso emergente quedaría tapado por este diálogo, así que el aviso va aquí. */}
          <p role="status" className="min-h-5 text-center text-sm font-bold text-white/85">{note}</p>
        </div>
      </div>
    </dialog>
  );
}

function Row({ label, value, sub, mono }: { label: string; value: string; sub?: string; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4 py-[9px]">
      <dt className="shrink-0 text-[#64738f]">{label}</dt>
      <dd className={`text-right font-bold ${mono ? 'font-display tracking-[0.08em]' : ''}`}>
        {value}
        {sub ? <small className="block text-[0.8rem] font-normal text-[#64738f]">{sub}</small> : null}
      </dd>
    </div>
  );
}
