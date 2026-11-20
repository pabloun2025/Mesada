import { useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Camera, CalendarCheck, Flame, PartyPopper } from 'lucide-react';
import { api } from '../lib/api';
import { addDays, euros, fmtDate, weekdayLong } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Instance, Progress } from '../lib/types';
import { Button, Empty, Loading, SectionTitle, Sheet, useToast } from '../components/ui';
import { WeekRing } from '../components/Ring';
import { TaskRow } from '../components/TaskRow';

export default function ChildToday() {
  const { user, family } = useSession();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const list = useQuery({ queryKey: ['instances', 'mine', 'today'], queryFn: () => api<{ today: string; instances: Instance[] }>('/instances') });
  const today = list.data?.today;
  const upcoming = useQuery({
    queryKey: ['instances', 'mine', 'upcoming', today],
    queryFn: () => api<{ instances: Instance[] }>(`/instances?from=${addDays(today!, 1)}&to=${addDays(today!, 3)}`),
    enabled: !!today,
  });
  const progress = useQuery({ queryKey: ['progress', user.id], queryFn: () => api<Progress>(`/progress/${user.id}`) });
  const [photoFor, setPhotoFor] = useState<Instance | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const complete = useMutation({
    mutationFn: async ({ inst, photo }: { inst: Instance; photo?: File | null }) => {
      if (photo) {
        const fd = new FormData();
        fd.append('photo', photo);
        return api(`/instances/${inst.id}/complete`, { method: 'POST', form: fd });
      }
      return api(`/instances/${inst.id}/complete`, { method: 'POST', body: {} });
    },
    onSuccess: (r, { inst }) => {
      toast(r.status === 'approved' ? `¡+${r.points} puntos!` : `«${inst.title}» enviada. Falta que la validen.`);
      setPhotoFor(null);
      setFile(null);
      invalidate();
    },
    onError: (e: Error) => {
      toast(e.message, 'error');
      invalidate();
    },
  });

  if (list.isLoading) return <Loading />;
  const items = list.data?.instances ?? [];
  const open = items.filter((i) => i.status === 'pending' || i.status === 'rejected');
  const doneCount = items.filter((i) => i.status === 'approved' || i.status === 'submitted').length;
  const p = progress.data;

  const onComplete = (inst: Instance) => (inst.requires_photo ? setPhotoFor(inst) : complete.mutate({ inst }));

  return (
    <div className="mx-auto max-w-2xl">
      <section className="panel mb-6 flex flex-col items-center gap-5 p-6 sm:flex-row sm:items-center sm:gap-8">
        <WeekRing points={p?.week.points ?? 0} goal={p?.week.goal ?? 0} cents={p?.week.cents ?? 0} />
        <div className="text-center sm:text-left">
          <p className="text-sm font-bold muted first-letter:uppercase">{today ? weekdayLong(today) : ''}</p>
          <h1 className="mt-1 text-3xl font-extrabold">
            {items.length === 0 ? 'Hoy tienes el día libre' : open.length === 0 ? 'Todo hecho por hoy' : `Te quedan ${open.length} ${open.length === 1 ? 'tarea' : 'tareas'}`}
          </h1>
          <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--chip)] px-3 py-1 text-sm font-bold">
              <Flame size={16} className={p?.streak ? 'text-tangerine' : 'text-[var(--fg-3)]'} aria-hidden /> {p?.streak ?? 0} {p?.streak === 1 ? 'día' : 'días'} de racha
            </span>
            {p ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--chip)] px-3 py-1 text-sm font-bold">
                Nivel {p.level.level} · {p.level.title}
              </span>
            ) : null}
          </div>
          {p && p.period.maxPoints > 0 ? (
            <p className="mt-3 text-sm muted">
              Si lo haces todo, est{family.settlement_period === 'week' ? 'a semana' : 'e mes'} puedes ganar <strong className="num text-[var(--fg)]">{euros(p.period.maxCents)}</strong>. Llevas {euros(p.period.earnedCents)}.
            </p>
          ) : null}
        </div>
      </section>

      <section className="mb-8">
        <SectionTitle>Para hoy {items.length ? <span className="num ml-1 text-base muted">{doneCount}/{items.length}</span> : null}</SectionTitle>
        {items.length ? (
          <ul className="space-y-2.5">
            {items.map((i) => (
              <TaskRow key={i.id} inst={i} canComplete onComplete={onComplete} busy={complete.isPending} celebrate={family.celebrations_enabled && !i.requires_approval} />
            ))}
          </ul>
        ) : (
          <div className="card"><Empty icon={<PartyPopper />} title="Nada por aquí">Disfruta del día.</Empty></div>
        )}
      </section>

      {upcoming.data?.instances.length ? (
        <section>
          <SectionTitle>Próximos días</SectionTitle>
          <ul className="space-y-2">
            {upcoming.data.instances.map((i) => (
              <li key={i.id} className="flex items-center gap-3 rounded-2xl px-2 py-1.5">
                <span aria-hidden className="text-xl">{i.icon}</span>
                <span className="flex-1 font-bold">{i.title}</span>
                <span className="text-sm muted">{fmtDate(i.due_date, { weekday: 'short', day: 'numeric' })}</span>
                <span className="num text-sm font-bold text-tangerine">+{i.points}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Sheet
        open={!!photoFor}
        onClose={() => { setPhotoFor(null); setFile(null); }}
        title="Añade una foto"
        footer={<Button className="w-full" disabled={!file} loading={complete.isPending} onClick={() => photoFor && complete.mutate({ inst: photoFor, photo: file })}>Enviar</Button>}
      >
        <p className="mb-4 muted">«{photoFor?.title}» necesita una foto. Solo la verán los adultos de tu familia.</p>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={(e) => setFile(e.target.files?.[0] ?? null)} aria-label="Foto" />
        {file ? (
          <img src={URL.createObjectURL(file)} alt="Vista previa" className="mb-3 max-h-72 w-full rounded-2xl object-cover" />
        ) : null}
        <Button variant="secondary" className="w-full" onClick={() => fileRef.current?.click()}><Camera size={18} /> {file ? 'Hacer otra' : 'Hacer foto'}</Button>
      </Sheet>
      {items.length > 0 && open.length === 0 ? <p className="mt-6 flex items-center justify-center gap-2 text-sm muted"><CalendarCheck size={16} aria-hidden /> Mañana más.</p> : null}
    </div>
  );
}
