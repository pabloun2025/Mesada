import { useState } from 'react';
import { Camera, Check, Clock, Hourglass, RotateCcw, Users } from 'lucide-react';
import type { Instance } from '../lib/types';
import { Avatar, Badge, PointsPill } from './ui';

const STATUS: Record<string, { label: string; tone: 'muted' | 'sky' | 'sun' | 'berry' | 'leaf' }> = {
  pending: { label: 'Por hacer', tone: 'muted' },
  submitted: { label: 'Esperando validación', tone: 'sun' },
  approved: { label: 'Hecha', tone: 'leaf' },
  rejected: { label: 'Necesita repaso', tone: 'berry' },
  expired: { label: 'Vencida', tone: 'berry' },
};

export function TaskRow({
  inst,
  onComplete,
  showAssignee = false,
  canComplete = false,
  busy = false,
  celebrate = true,
}: {
  inst: Instance;
  onComplete?: (inst: Instance) => void;
  showAssignee?: boolean;
  canComplete?: boolean;
  busy?: boolean;
  celebrate?: boolean;
}) {
  const [justDone, setJustDone] = useState(false);
  const doable = canComplete && (inst.status === 'pending' || inst.status === 'rejected');
  const finished = inst.status === 'approved' || inst.status === 'submitted';
  const st = STATUS[inst.status];

  return (
    <li className="card flex items-center gap-3 p-3 pr-3.5">
      <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-[var(--chip)] text-2xl">
        {inst.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`font-bold leading-snug ${inst.status === 'approved' ? 'text-[var(--fg-3)] line-through decoration-2 decoration-leaf/60' : ''}`}>{inst.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
          {inst.status !== 'pending' ? <Badge tone={st.tone}>{st.label}</Badge> : null}
          {showAssignee && inst.assignee_name ? (
            <span className="inline-flex items-center gap-1 muted">
              <Avatar name={inst.assignee_name} avatar={inst.assignee_avatar} colorKey={inst.assignee_color} size={18} />
              {inst.assignee_name}
            </span>
          ) : null}
          {inst.assignment_mode === 'shared' ? (
            <span className="inline-flex items-center gap-1 muted"><Users size={14} aria-hidden /> {inst.completed_by_name ? `Hecha por ${inst.completed_by_name}` : 'Compartida'}</span>
          ) : null}
          {inst.assignment_mode === 'rotation' ? <span className="inline-flex items-center gap-1 muted"><RotateCcw size={14} aria-hidden /> Por turnos</span> : null}
          {inst.due_time ? <span className="inline-flex items-center gap-1 muted"><Clock size={14} aria-hidden /> {inst.due_time.slice(0, 5)}</span> : null}
          {inst.requires_photo ? <span className="inline-flex items-center gap-1 muted"><Camera size={14} aria-hidden /> Con foto</span> : null}
        </div>
        {inst.status === 'rejected' && inst.review_note ? <p className="mt-1.5 text-sm text-berry">«{inst.review_note}»</p> : null}
      </div>
      <div className="relative flex shrink-0 items-center gap-2.5">
        <PointsPill points={inst.points} tone={inst.status === 'approved' ? 'leaf' : 'tangerine'} />
        {justDone && celebrate ? (
          <span aria-hidden className="anim-rise num pointer-events-none absolute -top-2 right-1 font-extrabold text-tangerine">+{inst.points}</span>
        ) : null}
        {doable ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setJustDone(true);
              onComplete?.(inst);
            }}
            aria-label={`Marcar «${inst.title}» como hecha`}
            className="flex size-11 items-center justify-center rounded-full border-2 border-[var(--line)] text-transparent transition hover:border-tangerine hover:text-tangerine/50 active:scale-90 disabled:opacity-50"
          >
            <Check size={22} strokeWidth={3} />
          </button>
        ) : finished ? (
          <span className={`anim-pop flex size-11 items-center justify-center rounded-full text-white ${inst.status === 'approved' ? 'bg-leaf' : 'bg-sun'}`} aria-hidden>
            {inst.status === 'approved' ? <Check size={22} strokeWidth={3} /> : <Hourglass size={18} />}
          </span>
        ) : null}
      </div>
    </li>
  );
}
