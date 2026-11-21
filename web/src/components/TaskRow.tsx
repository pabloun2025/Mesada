import { useState } from 'react';
import { Camera, Check, Clock, Hourglass, RotateCcw, ShieldCheck, Users, X } from 'lucide-react';
import type { Instance } from '../lib/types';
import { remaining, useNow } from '../lib/deadline';
import { backLabel } from '../lib/format';
import { Avatar, Badge, PointsPill } from './ui';
import { BonusChip } from './BonusChip';

const STATUS: Record<string, { label: string; tone: 'muted' | 'sky' | 'sun' | 'berry' | 'leaf' }> = {
  pending: { label: 'Por hacer', tone: 'muted' },
  submitted: { label: 'Esperando validación', tone: 'sun' },
  approved: { label: 'Hecha', tone: 'leaf' },
  rejected: { label: 'Necesita repaso', tone: 'berry' },
  expired: { label: 'Vencida', tone: 'berry' },
};

/** Hora límite con cuenta atrás viva; pasada la hora, avisa de que ahora vale menos. */
function Deadline({ inst }: { inst: Instance }) {
  const now = useNow();
  if (!inst.deadline_at || !inst.deadline_time) return null;
  const left = new Date(inst.deadline_at).getTime() - now;
  if (left > 0) {
    const soon = left <= 30 * 60_000;
    return (
      <span className={`inline-flex items-center gap-1 font-bold ${soon ? 'text-berry' : 'muted'}`}>
        <Clock size={14} aria-hidden /> Antes de las {inst.deadline_time}{left < 24 * 3_600_000 ? ` · quedan ${remaining(left)}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 font-bold text-berry">
      <Clock size={14} aria-hidden /> Pasó la hora de las {inst.deadline_time}{inst.late_percent < 100 ? ` · vale el ${inst.late_percent} %` : ''}
    </span>
  );
}

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
  const waiting = !!inst.blocked_until;
  const doable = canComplete && !inst.check_mode && !waiting && (inst.status === 'pending' || inst.status === 'rejected');
  const finished = inst.status === 'approved' || inst.status === 'submitted';
  const st = STATUS[inst.status];
  const now = useNow();
  const open = inst.status === 'pending' || inst.status === 'rejected';
  const isLate = open && !!inst.deadline_at && new Date(inst.deadline_at).getTime() < now && inst.late_points !== inst.points;
  const check = inst.check_mode;
  const checkLabel = !check ? null : inst.check_met === true ? 'Cumplida' : inst.check_met === false ? `No cumplida${inst.penalty_minutes ? ` · −${inst.penalty_minutes} min` : ''}` : 'La marca un adulto';

  return (
    <li className={`card flex items-center gap-3 p-3 pr-3.5 ${waiting ? 'opacity-60 grayscale' : ''}`} aria-disabled={waiting || undefined}>
      <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-[var(--chip)] text-2xl">
        {inst.icon}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`font-bold leading-snug ${inst.status === 'approved' ? 'text-[var(--fg-3)] line-through decoration-2 decoration-leaf/60' : ''}`}>{inst.title}</p>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
          {check ? (
            <Badge tone={inst.check_met === true ? 'leaf' : inst.check_met === false ? 'berry' : 'muted'}>
              {inst.check_met === true ? <Check size={12} aria-hidden /> : inst.check_met === false ? <X size={12} aria-hidden /> : <ShieldCheck size={12} aria-hidden />} {checkLabel}
            </Badge>
          ) : inst.status !== 'pending' ? <Badge tone={st.tone}>{st.label}</Badge> : null}
          {!check && inst.on_time === false && !open ? <Badge tone="sun">Con retraso</Badge> : null}
          {showAssignee && inst.assignee_name ? (
            <span className="inline-flex items-center gap-1 muted">
              <Avatar name={inst.assignee_name} avatar={inst.assignee_avatar} colorKey={inst.assignee_color} size={18} />
              {inst.assignee_name}
            </span>
          ) : null}
          {waiting ? <Badge tone="muted"><Clock size={12} aria-hidden /> {backLabel(inst.blocked_until!, inst.due_date)}</Badge> : null}
          {inst.repeatable && inst.done_count > 0 ? (
            <Badge tone="leaf">{inst.max_per_day ? `Hecha ${inst.done_count} de ${inst.max_per_day} hoy` : `Hecha ${inst.done_count} ${inst.done_count === 1 ? 'vez' : 'veces'} hoy`}</Badge>
          ) : null}
          {inst.recurrence === 'as_needed' && !inst.completed_by_name ? <Badge tone="sky">Cuando haga falta</Badge> : null}
          {inst.assignment_mode === 'shared' ? (
            <span className="inline-flex items-center gap-1 muted"><Users size={14} aria-hidden /> {inst.completed_by_name ? `Hecha por ${inst.completed_by_name}` : 'Compartida'}</span>
          ) : null}
          {inst.assignment_mode === 'rotation' ? <span className="inline-flex items-center gap-1 muted"><RotateCcw size={14} aria-hidden /> Por turnos</span> : null}
          {open && !check ? <Deadline inst={inst} /> : null}
          {check && open && inst.penalty_minutes ? <span className="muted">Si no se cumple: −{inst.penalty_minutes} min de pantalla</span> : null}
          {open || inst.status === 'submitted' ? <BonusChip bonus={inst.bonus} /> : null}
          {inst.requires_photo ? <span className="inline-flex items-center gap-1 muted"><Camera size={14} aria-hidden /> Con foto</span> : null}
        </div>
        {inst.status === 'rejected' && inst.review_note ? <p className="mt-1.5 text-sm text-berry">«{inst.review_note}»</p> : null}
      </div>
      <div className="relative flex shrink-0 items-center gap-2.5">
        {isLate ? (
          <span className="flex items-center gap-1" aria-label={`Ahora vale ${inst.late_points} puntos en vez de ${inst.points}`}>
            <span className="num text-sm font-bold text-[var(--fg-3)] line-through decoration-2">{inst.points}</span>
            <PointsPill points={inst.late_points} />
          </span>
        ) : check && inst.points === 0 ? null : (
          <PointsPill points={inst.points} tone={inst.status === 'approved' ? 'leaf' : 'tangerine'} />
        )}
        {justDone && celebrate ? (
          <span aria-hidden className="anim-rise num pointer-events-none absolute -top-2 right-1 font-extrabold text-tangerine">+{isLate ? inst.late_points : inst.points}</span>
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
