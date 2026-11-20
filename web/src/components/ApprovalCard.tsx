import { useState } from 'react';
import { Check, Image, Minus, Plus, X } from 'lucide-react';
import { useReview } from '../lib/hooks';
import { fmtDate, relative } from '../lib/format';
import { Avatar, Button, Sheet } from './ui';

export interface Pending {
  id: string;
  title: string;
  icon: string;
  points: number;
  due_date: string;
  completed_at: string | null;
  child_note: string | null;
  has_photo: boolean;
  display_name: string | null;
  avatar: string | null;
  color: string | null;
}

export function ApprovalCard({ p, compact = false }: { p: Pending; compact?: boolean }) {
  const review = useReview();
  const [points, setPoints] = useState(p.points);
  const [rejecting, setRejecting] = useState(false);
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState(false);
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
            <button type="button" className="flex size-9 items-center justify-center rounded-full" aria-label="Menos puntos" onClick={() => setPoints((x) => Math.max(0, x - 5))}><Minus size={16} /></button>
            <span className="num w-14 text-center font-bold">{points} pts</span>
            <button type="button" className="flex size-9 items-center justify-center rounded-full" aria-label="Más puntos" onClick={() => setPoints((x) => x + 5)}><Plus size={16} /></button>
          </div>
        ) : null}
        {p.has_photo ? (
          <Button variant="secondary" size="sm" onClick={() => setPhoto(true)}><Image size={16} /> Ver foto</Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button variant="danger" size="sm" disabled={busy} onClick={() => setRejecting(true)} aria-label={`Rechazar «${p.title}» de ${p.display_name}`}><X size={16} /> Repasar</Button>
          <Button variant="success" size="sm" loading={busy} onClick={() => review.mutate({ id: p.id, approve: true, points })} aria-label={`Aprobar «${p.title}» de ${p.display_name}`}>
            <Check size={16} /> Aprobar
          </Button>
        </div>
      </div>
      <Sheet
        open={rejecting}
        onClose={() => setRejecting(false)}
        title="¿Qué falta?"
        footer={
          <Button className="w-full" variant="danger" loading={busy} onClick={() => review.mutate({ id: p.id, approve: false, note: note || undefined }, { onSuccess: () => setRejecting(false) })}>
            Devolver para repasar
          </Button>
        }
      >
        <p className="mb-3 muted">{p.display_name} verá este mensaje y podrá volver a marcarla.</p>
        <textarea className="field min-h-24" placeholder="Por ejemplo: faltan los vasos del salón…" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} aria-label="Motivo" />
      </Sheet>
      <Sheet open={photo} onClose={() => setPhoto(false)} title={p.title}>
        <img src={`/api/instances/${p.id}/photo`} alt={`Foto de ${p.display_name} para «${p.title}»`} loading="lazy" className="w-full rounded-2xl" />
      </Sheet>
    </li>
  );
}
