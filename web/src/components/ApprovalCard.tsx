import { useState } from 'react';
import { Check, CornerUpLeft, Image, ListChecks, Minus, Plus, ThumbsDown, X } from 'lucide-react';
import { useReview } from '../lib/hooks';
import { fmtDate, relative } from '../lib/format';
import { Avatar, Button, Field, Sheet } from './ui';

export interface Pending {
  id: string;
  title: string;
  icon: string;
  points: number;
  due_date: string;
  completed_at: string | null;
  child_note: string | null;
  has_photo: boolean;
  photo_deleted?: boolean;
  display_name: string | null;
  avatar: string | null;
  color: string | null;
}

type Choice = 'partial' | 'return' | 'reject' | 'reject_penalty';
const CHOICES: { value: Choice; label: string; hint: string; icon: typeof Check }[] = [
  { value: 'partial', label: 'Premio parcial', hint: 'Das solo una parte de los puntos.', icon: Minus },
  { value: 'return', label: 'Devolver para que la arregle', hint: 'Vuelve al hijo y puede enviarla otra vez. Cuenta la hora en que la envió la primera vez.', icon: CornerUpLeft },
  { value: 'reject', label: 'Rechazar sin penalidad', hint: 'No gana nada y ya no se puede enviar.', icon: X },
  { value: 'reject_penalty', label: 'Rechazar con penalidad', hint: 'No gana nada y se le restan puntos y/o minutos de pantalla.', icon: ThumbsDown },
];
const REASONS = ['Falta un poco', 'No está hecha', 'Mal hecha', 'Sin foto'];

/** Hoja de revisión: las acciones además de «Aprobar». El motivo es obligatorio y lo ve el hijo. */
function ReviewSheet({ p, open, onClose }: { p: Pending; open: boolean; onClose: () => void }) {
  const review = useReview();
  const [choice, setChoice] = useState<Choice>('partial');
  const [points, setPoints] = useState(Math.round(p.points / 2));
  const [penPoints, setPenPoints] = useState(p.points);
  const [penMinutes, setPenMinutes] = useState(0);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const reason = note.trim();
  const ok = reason.length > 0 && (choice !== 'reject_penalty' || penPoints > 0 || penMinutes > 0);
  const label = { partial: `Dar ${points} puntos`, return: 'Devolver para que la arregle', reject: 'Rechazar', reject_penalty: 'Rechazar y restar' }[choice];
  const submit = () => {
    setError('');
    review.mutate(
      { id: p.id, action: choice, note: reason, points: choice === 'partial' ? points : undefined, penaltyPoints: choice === 'reject_penalty' ? penPoints : undefined, penaltyMinutes: choice === 'reject_penalty' ? penMinutes : undefined },
      { onSuccess: onClose, onError: (e: Error) => setError(e.message) },
    );
  };
  return (
    <Sheet open={open} onClose={onClose} title="Revisar tarea" subtitle={`«${p.title}» · ${p.display_name} · vale ${p.points} pts`}
      footer={
        <div className="space-y-2">
          {error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}
          <Button className="w-full" variant={choice === 'partial' || choice === 'return' ? 'primary' : 'danger'} disabled={!ok} loading={review.isPending} onClick={submit}>{label}</Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div role="radiogroup" aria-label="Qué hacer" className="grid gap-2">
          {CHOICES.map((c) => (
            <button key={c.value} type="button" role="radio" aria-checked={choice === c.value} onClick={() => setChoice(c.value)}
              className={`flex items-start gap-3 rounded-2xl border-2 p-3 text-left transition ${choice === c.value ? 'border-tangerine bg-tangerine-soft dark:bg-tangerine/15' : 'border-[var(--line)]'}`}>
              <c.icon size={20} className="mt-0.5 shrink-0" aria-hidden />
              <span><span className="block font-bold">{c.label}</span><span className="block text-sm muted">{c.hint}</span></span>
            </button>
          ))}
        </div>

        {choice === 'partial' ? (
          <div className="space-y-2">
            <p className="text-sm font-bold text-[var(--fg-2)]">Puntos a dar (sin bono)</p>
            <div className="flex flex-wrap items-center gap-2">
              {[75, 50, 25].map((pc) => (
                <Button key={pc} size="sm" variant={points === Math.round((p.points * pc) / 100) ? 'primary' : 'secondary'} onClick={() => setPoints(Math.round((p.points * pc) / 100))}>{pc} %</Button>
              ))}
              <input className="field num w-24 text-center font-bold" type="number" min={0} max={10000} aria-label="Otra cifra de puntos" value={points} onChange={(e) => setPoints(Math.max(0, Math.floor(Number(e.target.value))))} />
            </div>
          </div>
        ) : null}

        {choice === 'reject_penalty' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Puntos a restar" hint="Pueden dejar el saldo en negativo.">{(id) => <input id={id} className="field num" type="number" min={0} max={10000} value={penPoints} onChange={(e) => setPenPoints(Math.max(0, Math.floor(Number(e.target.value))))} />}</Field>
            <Field label="Minutos de pantalla" hint="Nunca baja de 0.">{(id) => <input id={id} className="field num" type="number" min={0} max={1440} value={penMinutes} onChange={(e) => setPenMinutes(Math.max(0, Math.floor(Number(e.target.value))))} />}</Field>
          </div>
        ) : null}

        <div className="space-y-2">
          <p className="text-sm font-bold text-[var(--fg-2)]">Motivo (obligatorio, lo verá {p.display_name})</p>
          <div className="flex flex-wrap gap-1.5">
            {REASONS.map((r) => (
              <button key={r} type="button" onClick={() => setNote(r)} aria-pressed={note === r}
                className={`min-h-11 rounded-full px-3.5 py-1.5 text-sm font-bold transition ${note === r ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-[var(--chip)]'}`}>{r}</button>
            ))}
          </div>
          <textarea className="field min-h-20" placeholder="O escribe el motivo…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-label="Motivo" />
        </div>
      </div>
    </Sheet>
  );
}

export function ApprovalCard({ p, compact = false }: { p: Pending; compact?: boolean }) {
  const review = useReview();
  const [points, setPoints] = useState(p.points);
  const [rejecting, setRejecting] = useState(false);
  const [photo, setPhoto] = useState(false);
  const [gone, setGone] = useState(!!p.photo_deleted);
  const busy = review.isPending;

  return (
    <li className="card p-3.5">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-[var(--chip)] text-2xl">{p.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="font-bold">{p.title}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-sm muted">
            <Avatar name={p.display_name ?? '?'} avatar={p.avatar} colorKey={p.color} size={18} />
            <span>{p.display_name}</span>
            <span aria-hidden>·</span>
            <span>{p.completed_at ? relative(p.completed_at) : fmtDate(p.due_date)}</span>
          </p>
          {p.child_note ? <p className="mt-1.5 rounded-xl bg-[var(--chip)] px-3 py-1.5 text-sm">«{p.child_note}»</p> : null}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!compact ? (
          <div className="flex items-center rounded-full bg-[var(--chip)]" aria-label="Puntos a conceder">
            <button type="button" className="flex size-11 items-center justify-center rounded-full" aria-label="Menos puntos" onClick={() => setPoints((x) => Math.max(0, x - 5))}><Minus size={16} /></button>
            <span className="num w-14 text-center font-bold">{points} pts</span>
            <button type="button" className="flex size-11 items-center justify-center rounded-full" aria-label="Más puntos" onClick={() => setPoints((x) => x + 5)}><Plus size={16} /></button>
          </div>
        ) : null}
        {p.has_photo || p.photo_deleted ? (
          <Button variant="secondary" size="sm" onClick={() => setPhoto(true)}><Image size={16} /> Ver foto</Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="secondary" size="sm" disabled={busy} onClick={() => setRejecting(true)} aria-label={`Revisar «${p.title}» de ${p.display_name}`}><ListChecks size={16} /> Otras opciones</Button>
          <Button variant="success" size="sm" loading={busy} onClick={() => review.mutate({ id: p.id, action: 'approve', points })} aria-label={`Aprobar «${p.title}» de ${p.display_name}`}>
            <Check size={16} /> Aprobar
          </Button>
        </div>
      </div>
      <ReviewSheet p={p} open={rejecting} onClose={() => setRejecting(false)} />
      <Sheet open={photo} onClose={() => setPhoto(false)} title={p.title}>
        {gone ? (
          <p role="status" className="rounded-2xl bg-[var(--chip)] p-4 text-center font-bold">Foto ya borrada</p>
        ) : (
          <img src={`/api/instances/${p.id}/photo`} alt={`Foto de ${p.display_name} para «${p.title}»`} loading="lazy" className="w-full rounded-2xl" onError={() => setGone(true)} />
        )}
      </Sheet>
    </li>
  );
}
