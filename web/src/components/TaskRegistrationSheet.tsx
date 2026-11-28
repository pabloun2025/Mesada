import { useId, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ApiError, api, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import type { Instance, User } from '../lib/types';
import { Button, Field, Sheet, useToast } from './ui';

export function TaskRegistrationSheet({ today, children, onClose }: { today: string; children: User[]; onClose: () => void }) {
  const formId = useId();
  const [day, setDay] = useState(today);
  const [instanceId, setInstanceId] = useState('');
  const [selectedChild, setSelectedChild] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const query = useQuery({
    queryKey: ['instances', 'register', day],
    queryFn: () => api<{ instances: Instance[] }>(`/instances?from=${day}&registration=1`),
    enabled: !!day && day <= today,
  });
  const tasks = (query.data?.instances ?? []).filter((i) => i.registration_children?.length && (i.max_per_day == null || i.done_count < i.max_per_day));
  const submitted = (query.data?.instances ?? []).filter((i) => i.status === 'submitted');
  const task = tasks.find((i) => i.id === instanceId);
  const eligible = children.filter((child) => task?.registration_children?.includes(child.id));
  const childId = task?.assignee_id ?? selectedChild;
  const child = eligible.find((value) => value.id === childId);
  const save = useMutation({
    mutationFn: (value: { instanceId: string; childId: string }) => post(`/instances/${value.instanceId}/register`, {
      childId: value.childId, completedTime: time || undefined, note: note.trim() || undefined,
    }),
    onSuccess: () => {
      toast(`Tarea registrada para ${child?.display_name ?? 'el hijo'}`);
      invalidate();
      onClose();
    },
    onError: () => invalidate(),
  });

  function chooseTask(id: string) {
    setInstanceId(id);
    setSelectedChild('');
    setTime('');
    setNote('');
    save.reset();
  }

  return (
    <Sheet open onClose={onClose} title="Registrar tarea hecha" footer={
      <Button type="submit" form={formId} className="w-full" loading={save.isPending} disabled={!task || !child || (!!(task.deadline_time || task.promotion) && !time) || (task.requires_photo && !note.trim())}>Registrar tarea</Button>
    }>
      <form id={formId} className="space-y-4" onSubmit={(event) => {
        event.preventDefault();
        if (task && child) save.mutate({ instanceId: task.id, childId: child.id });
      }}>
        <fieldset className="space-y-4" disabled={save.isPending}>
          <Field label="Día de la tarea">{(id) => <input id={id} type="date" className="field" required max={today} value={day} onChange={(event) => { setDay(event.target.value); chooseTask(''); }} />}</Field>
          {query.isFetching && !query.data ? <p role="status" className="text-sm muted">Buscando tareas…</p> : query.error ? <p role="alert" className="text-sm text-berry-deep">{query.error.message}</p> : query.data && !tasks.length ? <p className="text-sm muted">No hay tareas pendientes que se puedan registrar en este día.</p> : null}
          {tasks.length ? <Field label="Tarea">{(id) => (
            <select id={id} className="field" value={task?.id ?? ''} onChange={(event) => chooseTask(event.target.value)} required>
              <option value="">Elige una tarea</option>
              {tasks.map((i) => <option key={i.id} value={i.id}>{i.title}{i.assignee_name ? ` · ${i.assignee_name}` : ' · Compartida'}{i.repeat_no > 1 ? ` · ${i.repeat_no}.ª vez` : ''}</option>)}
            </select>
          )}</Field> : null}
          {task && task.assignee_id === null ? <Field label="Quién la hizo">{(id) => (
            <select id={id} className="field" value={selectedChild} onChange={(event) => setSelectedChild(event.target.value)} required>
              <option value="">Elige un hijo</option>
              {eligible.map((value) => <option key={value.id} value={value.id}>{value.display_name}</option>)}
            </select>
          )}</Field> : task && child ? <p className="text-sm">La hizo <strong>{child.display_name}</strong></p> : null}
          {task?.deadline_time ? <Field label="Hora a la que se hizo" hint={`Hora límite de la tarea: ${task.deadline_time}.`}>{(id) => <input id={id} type="time" className="field" required value={time} onChange={(event) => setTime(event.target.value)} />}</Field> : null}
          {task?.promotion && !task.deadline_time ? <Field label="Hora a la que se hizo" hint="La promoción solo se acredita si se hizo después de activarla.">{(id) => <input id={id} type="time" step={1} className="field" required value={time} onChange={(event) => setTime(event.target.value)} />}</Field> : null}
          {task ? <Field label={task.requires_photo ? 'Cómo has comprobado la tarea' : 'Nota (opcional)'}>{(id) => (
            <textarea id={id} className="field" rows={2} maxLength={500} required={task.requires_photo} value={note} onChange={(event) => setNote(event.target.value)} />
          )}</Field> : null}
        </fieldset>
        {save.error ? <p role="alert" className="text-sm font-bold text-berry-deep">{save.error.message}</p> : null}
        {submitted.length || (save.error instanceof ApiError && save.error.code === 'review_required') ? (
          <div className="rounded-2xl bg-[var(--chip)] px-3 py-2 text-sm">
            {submitted.length ? <ul className="space-y-1">{submitted.map((i) => <li key={i.id}>{i.completed_by_name ?? i.assignee_name} envió «{i.title}».</li>)}</ul> : null}
            <Link to="/validar" onClick={onClose} className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-4">Ir a Validar</Link>
          </div>
        ) : null}
      </form>
    </Sheet>
  );
}
