import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, Hammer, Hourglass, Pencil, Plus, Trash2, Undo2 } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { ExtraBoardItem, ExtraCatalogItem } from '../lib/types';
import { Avatar, Badge, Button, Empty, Field, IconButton, Loading, PageHeader, PointsPill, SectionTitle, Sheet, Toggle, useToast } from '../components/ui';
import { BonusChip } from '../components/BonusChip';

const ICONS = ['🧰', '🌿', '🧹', '🧺', '🪟', '🚗', '🧽', '🪴', '🛁', '📦', '🧴', '🐕', '🏡', '🔧', '🛒', '♻️'];

interface Draft {
  id?: string;
  title: string;
  description: string;
  icon: string;
  points: number;
  requiresApproval: boolean;
  requiresPhoto: boolean;
  bonusKind: 'none' | 'points' | 'screen' | 'text';
  bonusPoints: number;
  bonusMinutes: number;
  bonusText: string;
}

const empty = (): Draft => ({ title: '', description: '', icon: '🧰', points: 30, requiresApproval: true, requiresPhoto: false, bonusKind: 'none', bonusPoints: 10, bonusMinutes: 30, bonusText: '' });
const fromCatalog = (c: ExtraCatalogItem): Draft => ({
  id: c.id, title: c.title, description: c.description, icon: c.icon, points: c.points, requiresApproval: c.requires_approval, requiresPhoto: c.requires_photo,
  bonusKind: c.bonus_kind === 'points' || c.bonus_kind === 'screen' || c.bonus_kind === 'text' ? c.bonus_kind : 'none',
  bonusPoints: c.bonus_points ?? 10, bonusMinutes: c.bonus_minutes ?? 30, bonusText: c.bonus_text ?? '',
});

function ExtraEditor({ initial, onClose }: { initial: Draft; onClose: () => void }) {
  const [d, setD] = useState(initial);
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const save = useMutation({
    mutationFn: () => {
      const bonus = d.bonusKind === 'none' ? null : {
        kind: d.bonusKind, surprise: false, onTimeOnly: false,
        ...(d.bonusKind === 'points' ? { points: d.bonusPoints } : {}),
        ...(d.bonusKind === 'screen' ? { minutes: d.bonusMinutes } : {}),
        ...(d.bonusKind === 'text' ? { text: d.bonusText } : {}),
      };
      const body = { title: d.title, description: d.description, icon: d.icon, points: d.points, requiresApproval: d.requiresApproval, requiresPhoto: d.requiresPhoto, bonus };
      return d.id ? put(`/extras/${d.id}`, body) : post('/extras', body);
    },
    onSuccess: () => { toast(d.id ? 'Trabajo guardado' : 'Trabajo creado'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={d.id ? 'Editar trabajo extra' : 'Nuevo trabajo extra'}
      footer={<div className="space-y-2">{error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>{d.id ? 'Guardar cambios' : 'Crear trabajo'}</Button></div>}>
      <div className="space-y-5">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icono">
          {ICONS.map((i) => (
            <button key={i} type="button" role="radio" aria-checked={d.icon === i} onClick={() => set('icon', i)}
              className={`flex size-10 items-center justify-center rounded-xl text-xl transition ${d.icon === i ? 'bg-tangerine-soft ring-2 ring-tangerine dark:bg-tangerine/20' : 'bg-[var(--chip)]'}`}>{i}</button>
          ))}
        </div>
        <Field label="Nombre del trabajo">{(id) => <input id={id} className="field" value={d.title} onChange={(e) => set('title', e.target.value)} placeholder="Quitar los hierbajos…" maxLength={100} />}</Field>
        <Field label="Detalles (opcional)">{(id) => <textarea id={id} className="field min-h-18" value={d.description} onChange={(e) => set('description', e.target.value)} maxLength={1000} />}</Field>
        <Field label="Puntos">{(id) => <input id={id} className="field num w-28" type="number" min={0} max={10000} value={d.points} onChange={(e) => set('points', Math.max(0, Number(e.target.value)))} />}</Field>
        <Field label="Bono extra">
          {(id) => (
            <select id={id} className="field" value={d.bonusKind} onChange={(e) => set('bonusKind', e.target.value as Draft['bonusKind'])}>
              <option value="none">Sin bono</option><option value="points">Puntos extra</option><option value="screen">Minutos de pantalla</option><option value="text">Texto libre (lo cumples tú)</option>
            </select>
          )}
        </Field>
        {d.bonusKind === 'points' ? <Field label="Puntos extra">{(id) => <input id={id} className="field num w-28" type="number" min={1} value={d.bonusPoints} onChange={(e) => set('bonusPoints', Math.max(1, Number(e.target.value)))} />}</Field> : null}
        {d.bonusKind === 'screen' ? <Field label="Minutos de pantalla">{(id) => <input id={id} className="field num w-28" type="number" min={1} value={d.bonusMinutes} onChange={(e) => set('bonusMinutes', Math.max(1, Number(e.target.value)))} />}</Field> : null}
        {d.bonusKind === 'text' ? <Field label="¿Qué gana?">{(id) => <input id={id} className="field" value={d.bonusText} onChange={(e) => set('bonusText', e.target.value)} maxLength={200} />}</Field> : null}
        <div className="divide-y divide-[var(--line)] rounded-2xl bg-[var(--chip)]/50 px-4">
          <Toggle checked={d.requiresApproval} onChange={(v) => set('requiresApproval', v)} label="Necesita validación" description="Los puntos se suman cuando un adulto la aprueba." />
          <Toggle checked={d.requiresPhoto} onChange={(v) => set('requiresPhoto', v)} label="Pedir foto como prueba" />
        </div>
      </div>
    </Sheet>
  );
}

function ActivateSheet({ item, onClose }: { item: ExtraCatalogItem; onClose: () => void }) {
  const [deadline, setDeadline] = useState('');
  const [error, setError] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const go = useMutation({
    mutationFn: () => post(`/extras/${item.id}/activate`, { deadline: deadline || null }),
    onSuccess: () => { toast('Puesto en el tablón'); invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title="Poner en el tablón" subtitle={`${item.icon} ${item.title}`}
      footer={<div className="space-y-2">{error ? <p role="alert" className="text-sm font-bold text-berry-deep">{error}</p> : null}<Button className="w-full" loading={go.isPending} onClick={() => go.mutate()}>Poner en el tablón</Button></div>}>
      <Field label="Plazo (opcional)" hint="Hasta ese día inclusive. Si nadie la hace, vuelve al catálogo sin más.">
        {(id) => <input id={id} type="date" className="field" value={deadline} onChange={(e) => setDeadline(e.target.value)} />}
      </Field>
    </Sheet>
  );
}

function BoardCard({ it, adult }: { it: ExtraBoardItem; adult: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const fileRef = useRef<HTMLInputElement>(null);
  const onErr = (e: Error) => { toast(e.message, 'error'); invalidate(); };
  const claim = useMutation({ mutationFn: () => post(`/extra-instances/${it.id}/claim`), onSuccess: () => { toast('¡Es tuya!'); invalidate(); }, onError: onErr });
  const release = useMutation({ mutationFn: () => post(`/extra-instances/${it.id}/release`), onSuccess: () => { toast('Liberada'); invalidate(); }, onError: onErr });
  const remove = useMutation({ mutationFn: () => del(`/extra-instances/${it.id}`), onSuccess: () => { toast('Quitada del tablón'); invalidate(); }, onError: onErr });
  const complete = useMutation({
    mutationFn: (photo?: File) => {
      if (photo) { const fd = new FormData(); fd.append('photo', photo); return api(`/instances/${it.id}/complete`, { method: 'POST', form: fd }); }
      return post(`/instances/${it.id}/complete`);
    },
    onSuccess: (r: any) => { toast(r.status === 'approved' ? `¡+${r.points} puntos!` : 'Enviada. Falta que la validen.'); invalidate(); },
    onError: onErr,
  });
  const free = !it.assignee_id && it.status === 'pending';
  const working = it.status === 'pending' || it.status === 'rejected';
  return (
    <li className="card p-3.5" data-testid="extra-card">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-[var(--chip)] text-2xl">{it.icon}</span>
        <div className="min-w-0 flex-1">
          <p className="font-bold leading-snug">{it.title}</p>
          {it.description ? <p className="text-sm muted">{it.description}</p> : null}
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-sm">
            {it.extra_deadline ? <Badge tone="sky">Antes del {fmtDate(it.extra_deadline, { weekday: 'long', day: 'numeric', month: 'short' })}</Badge> : null}
            {!free && it.holder_name ? (
              <span className="inline-flex items-center gap-1 font-bold muted"><Avatar name={it.holder_name} avatar={it.holder_avatar} size={18} /> {it.mine && !adult ? 'La tienes tú' : `La tiene ${it.holder_name}`}</span>
            ) : null}
            {it.status === 'submitted' ? <Badge tone="sun"><Hourglass size={12} aria-hidden /> Esperando validación</Badge> : null}
            {it.status === 'rejected' ? <Badge tone="berry">Necesita repaso</Badge> : null}
            <BonusChip bonus={it.bonus} />
          </div>
          {it.status === 'rejected' && it.review_note ? <p className="mt-1 text-sm text-berry-deep">«{it.review_note}»</p> : null}
        </div>
        <PointsPill points={it.points} />
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        {!adult && free ? <Button size="sm" loading={claim.isPending} onClick={() => claim.mutate()}>Me la pido</Button> : null}
        {!adult && it.mine && working && it.assignee_id ? (
          <>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" aria-label="Foto" onChange={(e) => { const f = e.target.files?.[0]; if (f) complete.mutate(f); }} />
            <Button size="sm" loading={complete.isPending} onClick={() => (it.requires_photo ? fileRef.current?.click() : complete.mutate(undefined))}>
              {it.requires_photo ? <><Camera size={16} /> Hecha, con foto</> : 'Ya la hice'}
            </Button>
          </>
        ) : null}
        {adult && it.assignee_id && working ? <Button size="sm" variant="secondary" loading={release.isPending} onClick={() => release.mutate()}><Undo2 size={16} /> Soltar</Button> : null}
        {adult && working ? <Button size="sm" variant="ghost" loading={remove.isPending} onClick={() => confirm(`¿Quitar «${it.title}» del tablón?`) && remove.mutate()}>Quitar</Button> : null}
      </div>
    </li>
  );
}

export default function Extras() {
  const { user } = useSession();
  const adult = user.role === 'adult';
  const q = useQuery({ queryKey: ['extras'], queryFn: () => api<{ board: ExtraBoardItem[]; catalog?: ExtraCatalogItem[] }>('/extras'), refetchInterval: 30_000 });
  const invalidate = useInvalidateAll();
  const toast = useToast();
  const [editing, setEditing] = useState<Draft | null>(null);
  const [activating, setActivating] = useState<ExtraCatalogItem | null>(null);
  const archive = useMutation({ mutationFn: (id: string) => del(`/extras/${id}`), onSuccess: () => { toast('Trabajo archivado'); invalidate(); } });
  if (q.isLoading) return <Loading />;
  const board = q.data?.board ?? [];
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Trabajos extra" subtitle={adult ? 'Trabajos sin fecha: actívalos cuando hagan falta.' : 'Gana puntos extra. El primero que se la pide, se la queda.'} />
      <section className="mb-8">
        <SectionTitle>En el tablón</SectionTitle>
        {board.length ? (
          <ul className="space-y-2.5">{board.map((it) => <BoardCard key={it.id} it={it} adult={adult} />)}</ul>
        ) : (
          <div className="card"><Empty icon={<Hammer />} title="Ahora no hay trabajos extra">{adult ? 'Activa uno del catálogo para que aparezca aquí.' : 'Cuando haya uno nuevo te avisamos.'}</Empty></div>
        )}
      </section>
      {adult ? (
        <section>
          <SectionTitle action={<Button size="sm" onClick={() => setEditing(empty())}><Plus size={16} /> Nuevo</Button>}>Catálogo</SectionTitle>
          {q.data?.catalog?.length ? (
            <ul className="space-y-2.5">
              {q.data.catalog.map((c) => (
                <li key={c.id} className="card flex items-center gap-3 p-3.5" data-testid="extra-catalog-item">
                  <span aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-[var(--radius-tile)] bg-[var(--chip)] text-2xl">{c.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-bold">{c.title}</p>
                    <div className="mt-1 flex flex-wrap gap-1"><BonusChip bonus={c.bonus} />{c.open_instance_id ? <Badge tone="sky">En el tablón</Badge> : null}</div>
                  </div>
                  <PointsPill points={c.points} />
                  <div className="flex flex-col items-end gap-1">
                    <Button size="sm" variant="secondary" disabled={!!c.open_instance_id} onClick={() => setActivating(c)}>Activar</Button>
                    <div className="flex">
                      <IconButton label={`Editar «${c.title}»`} onClick={() => setEditing(fromCatalog(c))}><Pencil size={17} /></IconButton>
                      <IconButton label={`Archivar «${c.title}»`} onClick={() => confirm(`¿Archivar «${c.title}»?`) && archive.mutate(c.id)}><Trash2 size={17} /></IconButton>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <div className="card"><Empty icon={<Hammer />} title="El catálogo está vacío">Guarda aquí trabajos como «Quitar hierbajos» o «Limpiar el patio» para activarlos cuando haga falta.</Empty></div>
          )}
        </section>
      ) : null}
      {editing ? <ExtraEditor initial={editing} onClose={() => setEditing(null)} /> : null}
      {activating ? <ActivateSheet item={activating} onClose={() => setActivating(null)} /> : null}
    </div>
  );
}
