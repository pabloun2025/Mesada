import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import type { CatalogProposal } from '../lib/types';
import { Badge, Button, Field, SectionTitle, Sheet, useToast } from './ui';

const MAX = { task: { title: 100, description: 1000, points: 10000, min: 0 }, reward: { title: 80, description: 500, points: 1000000, min: 1 } };
const TITLE = { task: 'Proponer tarea', reward: 'Proponer premio' };
const RESULT = { pending: 'Por revisar', approved: 'Aprobada', rejected: 'Rechazada' } as const;

function PointInput({ kind, value, onChange, optional }: { kind: CatalogProposal['kind']; value: string; onChange: (v: string) => void; optional?: boolean }) {
  const label = kind === 'task' ? 'Puntos de la tarea' : 'Coste en puntos';
  return <Field label={`${label}${optional ? ' (opcional)' : ''}`}>{(id) => (
    <input id={id} className="field" type="number" inputMode="numeric" min={MAX[kind].min} max={MAX[kind].points} step={1} value={value} onChange={(e) => onChange(e.target.value)} />
  )}</Field>;
}

function validPoints(kind: CatalogProposal['kind'], value: string) {
  return /^\d+$/.test(value) && Number(value) >= MAX[kind].min && Number(value) <= MAX[kind].points;
}

function Propose({ kind, onClose }: { kind: CatalogProposal['kind']; onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [points, setPoints] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const send = useMutation({
    mutationFn: () => post('/catalog-proposals', { kind, title, description, points: points ? Number(points) : undefined }),
    onSuccess: () => { toast('Propuesta enviada'); invalidate(); onClose(); },
  });
  return (
    <Sheet open onClose={onClose} title={TITLE[kind]} footer={<Button className="w-full" loading={send.isPending} disabled={!title.trim() || (!!points && !validPoints(kind, points))} onClick={() => send.mutate()}>Enviar propuesta</Button>}>
      <fieldset className="space-y-4" disabled={send.isPending}>
        <Field label="Título">{(id) => <input id={id} className="field" value={title} maxLength={MAX[kind].title} onChange={(e) => setTitle(e.target.value)} />}</Field>
        <Field label="Descripción (opcional)">{(id) => <textarea id={id} className="field" rows={3} value={description} maxLength={MAX[kind].description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <PointInput kind={kind} value={points} onChange={setPoints} optional />
        {send.error ? <p role="alert" className="text-sm font-bold text-berry-deep">{send.error.message}</p> : null}
      </fieldset>
    </Sheet>
  );
}

export function MyCatalogProposals({ kind }: { kind: CatalogProposal['kind'] }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['catalog-proposals', 'mine', kind], queryFn: () => api<{ proposals: CatalogProposal[] }>(`/catalog-proposals?kind=${kind}`) });
  const proposals = q.data?.proposals ?? [];
  return (
    <section className="my-7" aria-label={kind === 'task' ? 'Mis propuestas de tareas' : 'Mis propuestas de premios'}>
      <SectionTitle action={<Button size="sm" variant="secondary" onClick={() => setOpen(true)}>{TITLE[kind]}</Button>}>Mis propuestas</SectionTitle>
      {proposals.length ? <ul className="card divide-y divide-[var(--line)]">
        {proposals.map((p) => (
          <li key={p.id} className="p-3.5 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2"><strong className="wrap-anywhere">{p.title}{p.points != null ? ` · ${p.points} pts` : ''}</strong><Badge tone={p.status === 'approved' ? 'leaf' : p.status === 'rejected' ? 'berry' : 'sun'}>{RESULT[p.status]}</Badge></div>
            {p.description ? <p className="mt-1 muted wrap-anywhere">{p.description}</p> : null}
            {p.status === 'approved' && (p.decision === 'edit' || p.points !== p.result_points) ? <p className="mt-1 font-bold wrap-anywhere">Aprobada como «{p.result_title}» · {p.result_points} pts</p> : null}
            {p.result_description && p.result_description !== p.description ? <p className="mt-1 muted wrap-anywhere">{p.result_description}</p> : null}
            {p.decision_note ? <p className="mt-1 wrap-anywhere">{p.decided_by_name ? `${p.decided_by_name} · ` : ''}{p.decision_note}</p> : null}
          </li>
        ))}
      </ul> : null}
      {open ? <Propose kind={kind} onClose={() => setOpen(false)} /> : null}
    </section>
  );
}

type Decision = 'approve' | 'edit' | 'reject';

function DecideProposal({ p, action, onClose }: { p: CatalogProposal; action: Decision; onClose: () => void }) {
  const [title, setTitle] = useState(p.title);
  const [description, setDescription] = useState(p.description);
  const [points, setPoints] = useState(p.points == null ? '' : String(p.points));
  const [note, setNote] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const decide = useMutation({
    mutationFn: () => post(`/catalog-proposals/${p.id}/decide`, {
      action, note: note.trim() || undefined, title: action === 'edit' ? title : undefined,
      description: action === 'edit' ? description : undefined, points: action === 'reject' ? undefined : Number(points),
    }),
    onSuccess: () => { toast(action === 'reject' ? 'Propuesta rechazada' : 'Propuesta aprobada'); invalidate(); onClose(); },
    onError: () => { invalidate(); },
  });
  const buttonLabel = action === 'edit' ? 'Corregir y aprobar' : action === 'reject' ? 'Rechazar propuesta' : 'Aprobar propuesta';
  const canSend = (action === 'approve' || !!note.trim()) && (action === 'reject' || (!!title.trim() && validPoints(p.kind, points)));
  return (
    <Sheet open onClose={onClose} title={buttonLabel} footer={<Button className="w-full" variant={action === 'reject' ? 'danger' : 'success'} loading={decide.isPending} disabled={!canSend} onClick={() => decide.mutate()}>{buttonLabel}</Button>}>
      <fieldset className="space-y-4" disabled={decide.isPending}>
        <div className="rounded-2xl bg-[var(--chip)] p-3 text-sm">
          <p className="font-bold wrap-anywhere">{p.display_name} propuso «{p.title}»{p.points != null ? ` · ${p.points} pts` : ''}</p>
          {p.description ? <p className="mt-1 muted wrap-anywhere">{p.description}</p> : null}
        </div>
        {action === 'edit' ? <>
          <Field label="Título aprobado">{(id) => <input id={id} className="field" maxLength={MAX[p.kind].title} value={title} onChange={(e) => setTitle(e.target.value)} />}</Field>
          <Field label="Descripción aprobada">{(id) => <textarea id={id} className="field" rows={3} maxLength={MAX[p.kind].description} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        </> : null}
        {action === 'edit' || (action === 'approve' && p.points == null) ? <PointInput kind={p.kind} value={points} onChange={setPoints} /> : null}
        <Field label={action === 'approve' ? 'Nota (opcional)' : 'Motivo'}>{(id) => <textarea id={id} className="field" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        {decide.error ? <p role="alert" className="text-sm font-bold text-berry-deep">{decide.error.message}</p> : null}
      </fieldset>
    </Sheet>
  );
}

export function PendingCatalogProposals() {
  const [review, setReview] = useState<{ p: CatalogProposal; action: Decision } | null>(null);
  const q = useQuery({ queryKey: ['catalog-proposals', 'pending'], queryFn: () => api<{ proposals: CatalogProposal[] }>('/catalog-proposals?status=pending') });
  const proposals = q.data?.proposals ?? [];
  if (!proposals.length && !review) return null;
  return (
    <section className="mb-8" aria-label="Propuestas de tareas y premios">
      <SectionTitle>Propuestas de tareas y premios</SectionTitle>
      <ul className="space-y-3">
        {proposals.map((p) => (
          <li key={p.id} className="card p-3.5 text-sm">
            <p className="font-bold wrap-anywhere">{p.title}{p.points != null ? ` · ${p.points} pts` : ''}</p>
            <p className="muted">{p.display_name} · {p.kind === 'task' ? 'Tarea' : 'Premio'}</p>
            {p.description ? <p className="mt-1 wrap-anywhere">{p.description}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="success" onClick={() => setReview({ p, action: 'approve' })}>Aprobar</Button>
              <Button size="sm" variant="secondary" onClick={() => setReview({ p, action: 'edit' })}>Corregir y aprobar</Button>
              <Button size="sm" variant="ghost" onClick={() => setReview({ p, action: 'reject' })}>Rechazar</Button>
            </div>
          </li>
        ))}
      </ul>
      {review ? <DecideProposal p={review.p} action={review.action} onClose={() => setReview(null)} /> : null}
    </section>
  );
}
