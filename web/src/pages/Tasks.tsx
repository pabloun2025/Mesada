import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { CalendarDays, ListChecks, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { addDays, fmtDate, WEEKDAYS, WEEKDAYS_LONG } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import type { Instance, Reward, Task, User } from '../lib/types';
import { minutesLabel } from '../lib/deadline';
import { Avatar, Badge, Button, Disclosure, Empty, Field, IconButton, Loading, PageHeader, PointsPill, Segmented, Sheet, Toggle, useToast } from '../components/ui';
import { BonusChip } from '../components/BonusChip';
import { TaskRow } from '../components/TaskRow';

const ICONS = ['🛏️', '🍽️', '🗑️', '🧹', '🧺', '🐈', '🐕', '🛁', '🪴', '🛒', '👕', '📚', '🚗', '🧽', '🍳', '🎒', '🪥', '♻️', '🧸', '✅'];
const DIFF_POINTS = { easy: 10, medium: 20, hard: 40 } as const;

export function describeRecurrence(t: Pick<Task, 'recurrence' | 'weekdays' | 'month_day' | 'start_date'>) {
  const days = (ws: number[]) => (ws.length === 7 ? 'todos los días' : ws.map((w) => WEEKDAYS_LONG[w - 1]).join(', '));
  switch (t.recurrence) {
    case 'once': return `El ${fmtDate(t.start_date, { day: 'numeric', month: 'long' })}`;
    case 'daily': return t.weekdays.length ? `Cada ${days(t.weekdays)}` : 'Cada día';
    case 'weekly': return `Cada semana: ${days(t.weekdays)}`;
    case 'monthly': return `El día ${t.month_day ?? Number(t.start_date.slice(8))} de cada mes`;
    case 'as_needed': return 'Cuando haga falta';
  }
}

const MODE_LABEL = { individual: 'Cada uno la suya', shared: 'Compartida', rotation: 'Por turnos' };

interface Draft {
  id?: string;
  title: string;
  description: string;
  icon: string;
  difficulty: 'easy' | 'medium' | 'hard';
  points: number;
  recurrence: Task['recurrence'];
  weekdays: number[];
  monthDay: number | null;
  startDate: string;
  endDate: string;
  dueTime: string;
  dueTimeWeekend: string;
  latePercent: number;
  checkMode: boolean;
  penaltyMinutes: number;
  successMinutes: number;
  bonusKind: 'none' | 'points' | 'screen' | 'text' | 'reward';
  bonusPoints: number;
  bonusMinutes: number;
  bonusText: string;
  bonusRewardId: string;
  bonusSurprise: boolean;
  bonusOnTimeOnly: boolean;
  assignmentMode: Task['assignment_mode'];
  assignees: string[];
  requiresApproval: boolean;
  requiresPhoto: boolean;
  repeatable: boolean;
  unlimited: boolean;
  maxPerDay: number;
  cooldownDays: string;
}

function toDraft(t: Task | null, today: string): Draft {
  if (!t) {
    return {
      title: '', description: '', icon: '✅', difficulty: 'medium', points: 20, recurrence: 'daily', weekdays: [], monthDay: null,
      startDate: today, endDate: '', dueTime: '', dueTimeWeekend: '', latePercent: 100, checkMode: false, penaltyMinutes: 15, successMinutes: 0,
      bonusKind: 'none', bonusPoints: 10, bonusMinutes: 30, bonusText: '', bonusRewardId: '', bonusSurprise: false, bonusOnTimeOnly: false, assignmentMode: 'individual', assignees: [], requiresApproval: true, requiresPhoto: false,
      repeatable: false, unlimited: false, maxPerDay: 2, cooldownDays: '',
    };
  }
  return {
    id: t.id, title: t.title, description: t.description, icon: t.icon, difficulty: t.difficulty, points: t.points, recurrence: t.recurrence,
    weekdays: t.weekdays, monthDay: t.month_day, startDate: t.start_date, endDate: t.end_date ?? '', dueTime: t.due_time?.slice(0, 5) ?? '',
    dueTimeWeekend: t.due_time_weekend?.slice(0, 5) ?? '', latePercent: t.late_percent, checkMode: t.check_mode, penaltyMinutes: t.penalty_minutes || 15, successMinutes: t.success_minutes,
    bonusKind: t.bonus_kind ?? 'none', bonusPoints: t.bonus_points ?? 10, bonusMinutes: t.bonus_minutes ?? 30, bonusText: t.bonus_text ?? '', bonusRewardId: t.bonus_reward_id ?? '',
    bonusSurprise: t.bonus_surprise ?? false, bonusOnTimeOnly: t.bonus_on_time_only ?? false,
    assignmentMode: t.assignment_mode, assignees: t.assignees.map((a) => a.id), requiresApproval: t.requires_approval, requiresPhoto: t.requires_photo,
    repeatable: !!t.repeatable, unlimited: !!t.repeatable && t.max_per_day == null, maxPerDay: t.max_per_day ?? 2, cooldownDays: t.cooldown_days ? String(t.cooldown_days) : '',
  };
}

function TaskEditor({ open, onClose, initial, members }: { open: boolean; onClose: () => void; initial: Draft; members: User[] }) {
  const [d, setD] = useState(initial);
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const rewards = useQuery({ queryKey: ['rewards'], queryFn: () => api<{ rewards: Reward[] }>('/rewards') });
  const kids = members.filter((m) => m.role === 'child' && m.active);
  const adults = members.filter((m) => m.role === 'adult' && m.active);

  const save = useMutation({
    mutationFn: () => {
      const bonus = d.bonusKind === 'none' ? null : {
        kind: d.bonusKind, surprise: d.bonusSurprise, onTimeOnly: d.bonusOnTimeOnly && !d.checkMode,
        ...(d.bonusKind === 'points' ? { points: d.bonusPoints } : {}),
        ...(d.bonusKind === 'screen' ? { minutes: d.bonusMinutes } : {}),
        ...(d.bonusKind === 'text' ? { text: d.bonusText } : {}),
        ...(d.bonusKind === 'reward' ? { rewardId: d.bonusRewardId || undefined } : {}),
      };
      const body = {
        title: d.title, description: d.description, icon: d.icon, difficulty: d.difficulty, points: d.points, recurrence: d.recurrence, weekdays: d.weekdays,
        startDate: d.startDate, assignmentMode: d.assignmentMode, assignees: d.assignees, requiresApproval: d.requiresApproval, requiresPhoto: d.requiresPhoto,
        endDate: d.endDate || null, dueTime: d.dueTime || null, dueTimeWeekend: d.dueTimeWeekend || null, latePercent: d.latePercent,
        repeatable: d.repeatable && !d.checkMode, maxPerDay: d.repeatable && !d.unlimited ? Math.max(2, d.maxPerDay) : null,
        cooldownDays: d.recurrence === 'as_needed' && d.cooldownDays ? Math.max(1, Number(d.cooldownDays)) : null,
        checkMode: d.checkMode, penaltyMinutes: d.penaltyMinutes, successMinutes: d.successMinutes, bonus,
        monthDay: d.recurrence === 'monthly' ? d.monthDay ?? Number(d.startDate.slice(8)) : null,
      };
      if (d.recurrence === 'as_needed') Object.assign(body, { assignmentMode: 'shared', dueTime: null, dueTimeWeekend: null, latePercent: 100, checkMode: false });
      return d.id ? put(`/tasks/${d.id}`, body) : post('/tasks', body);
    },
    onSuccess: () => {
      toast(d.id ? 'Tarea guardada' : 'Tarea creada');
      invalidate();
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleIn = (arr: number[] | string[], v: any) => ((arr as any[]).includes(v) ? (arr as any[]).filter((x) => x !== v) : [...arr, v]);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={d.id ? 'Editar tarea' : 'Nueva tarea'}
      footer={
        <div className="space-y-2">
          {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
          <Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>{d.id ? 'Guardar cambios' : 'Crear tarea'}</Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div>
          <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Icono</p>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icono">
            {ICONS.map((i) => (
              <button key={i} type="button" role="radio" aria-checked={d.icon === i} onClick={() => set('icon', i)}
                className={`flex size-10 items-center justify-center rounded-xl text-xl transition ${d.icon === i ? 'bg-tangerine-soft ring-2 ring-tangerine dark:bg-tangerine/20' : 'bg-[var(--chip)]'}`}>
                {i}
              </button>
            ))}
          </div>
        </div>
        <Field label="Nombre de la tarea">{(id) => <input id={id} className="field" value={d.title} onChange={(e) => set('title', e.target.value)} placeholder="Poner el lavavajillas…" maxLength={100} />}</Field>
        <Field label="Detalles (opcional)">{(id) => <textarea id={id} className="field min-h-18" value={d.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} />}</Field>

        <div className="grid grid-cols-[1fr_auto] items-end gap-3">
          <div>
            <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">Dificultad</p>
            <Segmented label="Dificultad" value={d.difficulty} onChange={(v) => setD((x) => ({ ...x, difficulty: v, points: DIFF_POINTS[v] }))}
              options={[{ value: 'easy', label: 'Fácil' }, { value: 'medium', label: 'Media' }, { value: 'hard', label: 'Difícil' }]} />
          </div>
          <Field label="Puntos">{(id) => <input id={id} className="field num w-24 text-center font-bold" type="number" min={0} max={10000} value={d.points} onChange={(e) => set('points', Math.max(0, Number(e.target.value)))} />}</Field>
        </div>

        <div>
          <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">¿Cuándo?</p>
          <Segmented label="Repetición" value={d.recurrence} onChange={(v) => setD((x) => ({ ...x, recurrence: v, ...(v === 'as_needed' ? { checkMode: false, assignmentMode: 'shared' as const } : {}) }))}
            options={[{ value: 'once', label: 'Una vez' }, { value: 'daily', label: 'Diaria' }, { value: 'weekly', label: 'Semanal' }, { value: 'monthly', label: 'Mensual' }, { value: 'as_needed', label: 'Cuando haga falta' }]} />
          {d.recurrence === 'as_needed' ? <p className="mt-2 text-sm muted">Siempre disponible, una vez al día. La hace quien llegue primero y, si nadie la hace, no pasa nada: no cuenta como fallo.</p> : null}
        </div>
        {d.recurrence === 'daily' || d.recurrence === 'weekly' ? (
          <div>
            <p className="mb-2 text-sm muted">{d.recurrence === 'daily' ? 'Días (vacío = todos)' : 'Días de la semana'}</p>
            <div className="flex gap-1.5">
              {WEEKDAYS.map((w, i) => (
                <button key={w} type="button" aria-pressed={d.weekdays.includes(i + 1)} aria-label={WEEKDAYS_LONG[i]} onClick={() => set('weekdays', (toggleIn(d.weekdays, i + 1) as number[]).sort())}
                  className={`num size-10 rounded-full font-bold transition ${d.weekdays.includes(i + 1) ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-[var(--chip)] text-[var(--fg-2)]'}`}>
                  {w}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <Field label={d.recurrence === 'once' ? 'Fecha' : 'Desde'}>{(id) => <input id={id} type="date" className="field" value={d.startDate} onChange={(e) => set('startDate', e.target.value)} />}</Field>
          {d.recurrence === 'monthly' ? (
            <Field label="Día del mes">{(id) => <input id={id} type="number" min={1} max={31} className="field" value={d.monthDay ?? Number(d.startDate.slice(8))} onChange={(e) => set('monthDay', Number(e.target.value))} />}</Field>
          ) : d.recurrence !== 'once' ? (
            <Field label="Hasta (opcional)">{(id) => <input id={id} type="date" className="field" value={d.endDate} onChange={(e) => set('endDate', e.target.value)} />}</Field>
          ) : <div />}
        </div>

        <div>
          <p className="mb-2 text-sm font-bold text-[var(--fg-2)]">¿Quién?</p>
          <div className="flex flex-wrap gap-2">
            {[...kids, ...adults].map((m) => {
              const on = d.assignees.includes(m.id);
              return (
                <button key={m.id} type="button" aria-pressed={on} onClick={() => set('assignees', toggleIn(d.assignees, m.id) as string[])}
                  className={`flex items-center gap-2 rounded-full py-1 pr-3.5 pl-1 font-bold transition ${on ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-[var(--chip)]'}`}>
                  <Avatar name={m.display_name} avatar={m.avatar} colorKey={m.color} size={30} />
                  {m.display_name}
                </button>
              );
            })}
          </div>
        </div>
        {d.assignees.length > 1 && d.recurrence !== 'as_needed' ? (
          <div>
            <Segmented label="Reparto" value={d.assignmentMode} onChange={(v) => set('assignmentMode', v)}
              options={[{ value: 'individual', label: MODE_LABEL.individual }, ...(d.checkMode ? [] : [{ value: 'shared' as const, label: MODE_LABEL.shared }]), { value: 'rotation', label: MODE_LABEL.rotation }]} />
            <p className="mt-2 text-sm muted">
              {{ individual: 'Cada persona tiene que hacerla.', shared: 'La primera persona en hacerla se lleva los puntos.', rotation: 'Se turnan en el orden en que los has elegido.' }[d.assignmentMode]}
            </p>
          </div>
        ) : null}
        <div className="divide-y divide-[var(--line)] rounded-2xl bg-[var(--chip)]/50 px-4">
          {d.recurrence !== 'as_needed' ? <Toggle checked={d.checkMode} onChange={(v) => setD((x) => ({ ...x, checkMode: v, assignmentMode: v && x.assignmentMode === 'shared' ? 'individual' : x.assignmentMode }))}
            label="La marca un adulto" description="Tu hijo no la reporta: tú marcas «Cumplida» o «No cumplida». Ej.: estar en el coche a la hora de salida." /> : null}
          {!d.checkMode ? (
            <>
              <Toggle checked={d.requiresApproval} onChange={(v) => set('requiresApproval', v)} label="Necesita validación" description="Los puntos se suman cuando un adulto la aprueba." />
              <Toggle checked={d.requiresPhoto} onChange={(v) => set('requiresPhoto', v)} label="Pedir foto como prueba" description="Solo la ven los adultos de la familia." />
              <Toggle checked={d.repeatable} onChange={(v) => set('repeatable', v)} label="Se puede repetir en el día" description="Cada vez da los puntos completos. Si no, solo una vez al día." />
            </>
          ) : null}
        </div>
        {d.repeatable && !d.checkMode ? (
          <div className="space-y-3 rounded-2xl border border-[var(--line)] p-4">
            <Toggle checked={d.unlimited} onChange={(v) => set('unlimited', v)} label="Sin límite" description={d.assignees.length > 1 && d.assignmentMode === 'shared' ? 'Compartida: el máximo cuenta entre todos.' : 'Cada hijo tiene su propio máximo.'} />
            {!d.unlimited ? <Field label="Máximo de veces al día">{(id) => <input id={id} className="field num w-28" type="number" min={2} max={50} value={d.maxPerDay} onChange={(e) => set('maxPerDay', Math.max(2, Number(e.target.value)))} />}</Field> : null}
          </div>
        ) : null}
        {d.recurrence === 'as_needed' ? (
          <Field label="Después de hacerla, vuelve en (días)" hint="Vacío = sin espera. Mientras espera, los hijos la ven en gris y no la pueden marcar.">
            {(id) => <input id={id} className="field num w-28" type="number" min={1} max={365} value={d.cooldownDays} onChange={(e) => set('cooldownDays', e.target.value)} placeholder="Sin espera" />}
          </Field>
        ) : null}

        {d.recurrence === 'as_needed' ? null : d.checkMode ? (
          <div className="space-y-3 rounded-2xl border border-[var(--line)] p-4">
            <p className="text-sm muted">Los puntos de arriba (pueden ser 0) se dan solo si la marcas como cumplida.</p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Si no se cumple (min)" hint="Se restan de su pantalla. Nunca baja de 0.">{(id) => <input id={id} className="field num" type="number" min={0} max={1440} value={d.penaltyMinutes} onChange={(e) => set('penaltyMinutes', Math.max(0, Number(e.target.value)))} />}</Field>
              <Field label="Si se cumple (min)" hint="Minutos de pantalla de premio.">{(id) => <input id={id} className="field num" type="number" min={0} max={1440} value={d.successMinutes} onChange={(e) => set('successMinutes', Math.max(0, Number(e.target.value)))} />}</Field>
            </div>
          </div>
        ) : (
          <Disclosure title="Hora límite" summary={d.dueTime || d.dueTimeWeekend ? `${d.dueTime ? `L–V ${d.dueTime}` : ''}${d.dueTime && d.dueTimeWeekend ? ' · ' : ''}${d.dueTimeWeekend ? `S–D ${d.dueTimeWeekend}` : ''}${d.latePercent < 100 ? ` · tarde ${d.latePercent} %` : ''}` : 'Sin hora límite'} defaultOpen={!!(d.dueTime || d.dueTimeWeekend)}>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Lunes a viernes">{(id) => <input id={id} type="time" className="field" value={d.dueTime} onChange={(e) => set('dueTime', e.target.value)} />}</Field>
              <Field label="Fin de semana y festivos">{(id) => <input id={id} type="time" className="field" value={d.dueTimeWeekend} onChange={(e) => set('dueTimeWeekend', e.target.value)} />}</Field>
            </div>
            <p className="text-sm muted">Si dejas vacío el fin de semana, se usa la hora de lunes a viernes. Los festivos se marcan en Ajustes.</p>
            <Field label="Valor si llega tarde (%)" hint="100 = sin cambio. Cuenta cuando tu hijo pulsa «Hecha». Puede hacerla hasta las 23:59.">
              {(id) => <input id={id} className="field num w-28" type="number" min={0} max={100} value={d.latePercent} onChange={(e) => set('latePercent', Math.min(100, Math.max(0, Number(e.target.value))))} />}
            </Field>
          </Disclosure>
        )}

        <Disclosure title="Bono extra" summary={d.bonusKind === 'none' ? 'Sin bono' : d.bonusSurprise ? '🎁 Sorpresa' : 'Bono visible'} defaultOpen={d.bonusKind !== 'none'}>
          <Field label="Tipo de bono">
            {(id) => (
              <select id={id} className="field" value={d.bonusKind} onChange={(e) => set('bonusKind', e.target.value as Draft['bonusKind'])}>
                <option value="none">Sin bono</option>
                <option value="points">Puntos extra</option>
                <option value="screen">Minutos de pantalla</option>
                <option value="text">Texto libre (lo cumples tú)</option>
                <option value="reward">Recompensa del catálogo</option>
              </select>
            )}
          </Field>
          {d.bonusKind === 'points' ? <Field label="Puntos extra">{(id) => <input id={id} className="field num w-28" type="number" min={1} max={10000} value={d.bonusPoints} onChange={(e) => set('bonusPoints', Math.max(1, Number(e.target.value)))} />}</Field> : null}
          {d.bonusKind === 'screen' ? <Field label="Minutos de pantalla">{(id) => <input id={id} className="field num w-28" type="number" min={1} max={1440} value={d.bonusMinutes} onChange={(e) => set('bonusMinutes', Math.max(1, Number(e.target.value)))} />}</Field> : null}
          {d.bonusKind === 'text' ? <Field label="¿Qué gana?" hint="Lo cumples tú a mano y lo marcas en Validar.">{(id) => <input id={id} className="field" value={d.bonusText} onChange={(e) => set('bonusText', e.target.value)} maxLength={200} placeholder="Helado el sábado" />}</Field> : null}
          {d.bonusKind === 'reward' ? (
            <Field label="Recompensa gratis" hint="Del catálogo de Premios. No gasta puntos.">
              {(id) => (
                <select id={id} className="field" value={d.bonusRewardId} onChange={(e) => set('bonusRewardId', e.target.value)}>
                  <option value="">Elige una…</option>
                  {(rewards.data?.rewards ?? []).map((r) => <option key={r.id} value={r.id}>{r.icon} {r.title}</option>)}
                </select>
              )}
            </Field>
          ) : null}
          {d.bonusKind !== 'none' ? (
            <div className="divide-y divide-[var(--line)] rounded-2xl bg-[var(--chip)]/50 px-4">
              <Toggle checked={d.bonusSurprise} onChange={(v) => set('bonusSurprise', v)} label="Sorpresa" description="Tu hijo ve «🎁 Sorpresa» sin saber qué es. La gana una sola vez, la primera que la haga." />
              {!d.checkMode ? <Toggle checked={d.bonusOnTimeOnly} onChange={(v) => set('bonusOnTimeOnly', v)} label="Solo si llega a tiempo" description="Si es tarde, no hay bono. Si no, se gana siempre." /> : null}
            </div>
          ) : null}
        </Disclosure>
      </div>
    </Sheet>
  );
}

function WeekView({ today }: { today: string }) {
  const [offset, setOffset] = useState(0);
  const monday = addDays(today, offset * 7 - ((new Date(`${today}T12:00:00`).getDay() + 6) % 7));
  const [day, setDay] = useState(today);
  const days = Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  const { data } = useQuery({
    queryKey: ['instances', 'week', monday],
    queryFn: () => api<{ instances: Instance[] }>(`/instances?from=${monday}&to=${addDays(monday, 6)}`),
  });
  const byDay = new Map<string, Instance[]>();
  for (const i of data?.instances ?? []) byDay.set(i.due_date, [...(byDay.get(i.due_date) ?? []), i]);
  const list = byDay.get(day) ?? [];
  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <Button variant="ghost" size="sm" onClick={() => setOffset((o) => o - 1)}>‹ Anterior</Button>
        <span className="font-bold">{fmtDate(monday)} – {fmtDate(addDays(monday, 6))}</span>
        <Button variant="ghost" size="sm" onClick={() => setOffset((o) => o + 1)}>Siguiente ›</Button>
      </div>
      <div className="mb-5 grid grid-cols-7 gap-1.5">
        {days.map((dd, i) => {
          const items = byDay.get(dd) ?? [];
          const done = items.filter((x) => x.status === 'approved').length;
          const sel = dd === day;
          return (
            <button key={dd} type="button" onClick={() => setDay(dd)} aria-pressed={sel}
              className={`flex flex-col items-center gap-0.5 rounded-2xl py-2.5 transition ${sel ? 'bg-ink text-white dark:bg-white dark:text-ink' : 'bg-[var(--card)] border border-[var(--line)]'}`}>
              <span className="text-xs font-bold opacity-70">{WEEKDAYS[i]}</span>
              <span className={`num text-lg font-extrabold ${dd === today && !sel ? 'text-tangerine' : ''}`}>{Number(dd.slice(8))}</span>
              <span className="num text-[11px] opacity-70">{items.length ? `${done}/${items.length}` : '–'}</span>
            </button>
          );
        })}
      </div>
      {list.length ? <ul className="space-y-2">{list.map((i) => <TaskRow key={i.id} inst={i} showAssignee />)}</ul> : <div className="card"><Empty icon={<CalendarDays />} title="Día libre">No hay tareas este día.</Empty></div>}
    </div>
  );
}

export default function Tasks() {
  const [view, setView] = useState<'list' | 'week'>('list');
  const [editing, setEditing] = useState<{ draft: Draft; key: number } | null>(null);
  const tasks = useQuery({ queryKey: ['tasks'], queryFn: () => api<{ tasks: Task[] }>('/tasks') });
  const fam = useQuery({ queryKey: ['family'], queryFn: () => api<{ members: User[] }>('/family') });
  const today = useQuery({ queryKey: ['instances', 'today-all'], queryFn: () => api<{ today: string; instances: Instance[] }>('/instances') });
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const remove = useMutation({ mutationFn: (id: string) => del(`/tasks/${id}`), onSuccess: () => { toast('Tarea archivada'); invalidate(); } });
  const todayStr = today.data?.today ?? new Date().toISOString().slice(0, 10);

  const open = (t: Task | null) => setEditing({ draft: toDraft(t, todayStr), key: Date.now() });

  return (
    <div>
      <PageHeader title="Tareas" subtitle="Crea, reparte y programa las tareas de casa." action={<Button onClick={() => open(null)}><Plus size={18} /> Nueva</Button>} />
      <div className="mb-5">
        <Segmented label="Vista" value={view} onChange={setView} options={[{ value: 'list', label: 'Todas' }, { value: 'week', label: 'Calendario' }]} />
      </div>
      {view === 'week' ? (
        <WeekView today={todayStr} />
      ) : tasks.isLoading ? (
        <Loading />
      ) : tasks.data?.tasks.length ? (
        <ul className="grid gap-2.5 md:grid-cols-2">
          {tasks.data.tasks.map((t) => (
            <li key={t.id} className="card flex items-center gap-3 p-3.5">
              <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-[var(--chip)] text-2xl">{t.icon}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{t.title}</p>
                <p className="truncate text-sm muted">{describeRecurrence(t)} · {t.assignees.length > 1 ? MODE_LABEL[t.assignment_mode] : t.assignees[0]?.display_name}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {t.check_mode ? <Badge tone="sky">La marca un adulto{t.penalty_minutes ? ` · −${minutesLabel(t.penalty_minutes)}` : ''}</Badge> : null}
                  {t.due_time || t.due_time_weekend ? <Badge>⏰ {t.due_time?.slice(0, 5) ?? '—'}{t.due_time_weekend ? ` / ${t.due_time_weekend.slice(0, 5)}` : ''}{t.late_percent < 100 ? ` · ${t.late_percent} %` : ''}</Badge> : null}
                  <BonusChip bonus={t.bonus} />
                </div>
                <div className="mt-1.5 flex -space-x-1.5">
                  {t.assignees.map((a) => <Avatar key={a.id} name={a.display_name} avatar={a.avatar} colorKey={a.color} size={22} ring />)}
                </div>
              </div>
              <PointsPill points={t.points} />
              <div className="flex flex-col">
                <IconButton label={`Editar «${t.title}»`} onClick={() => open(t)}><Pencil size={17} /></IconButton>
                <IconButton label={`Archivar «${t.title}»`} onClick={() => confirm(`¿Archivar «${t.title}»? Se quitarán sus próximas apariciones.`) && remove.mutate(t.id)}><Trash2 size={17} /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="card">
          <Empty icon={<ListChecks />} title="Aún no hay tareas">Empieza por algo diario y sencillo, como hacer la cama.</Empty>
          <div className="flex justify-center pb-8"><Button onClick={() => open(null)}><Plus size={18} /> Crear la primera</Button></div>
        </div>
      )}
      {editing && fam.data ? <TaskEditor key={editing.key} open onClose={() => setEditing(null)} initial={editing.draft} members={fam.data.members} /> : null}
    </div>
  );
}
