import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Camera, CalendarCheck, Check, ChevronRight, Database, Flame, Hammer, Hourglass, PartyPopper, Star } from 'lucide-react';
import { api } from '../lib/api';
import { addDays, euros, fmtDate, weekdayLong } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { ExtraBoardItem, Instance, Progress, Wallet, BonusGrant } from '../lib/types';
import { minutesLabel } from '../lib/deadline';
import { Button, Empty, Loading, SectionTitle, Sheet, useToast } from '../components/ui';
import { LogScreenSheet } from '../components/MoneySheets';
import { WeekRing } from '../components/Ring';
import { GoldCoins } from '../components/Coins';
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
  const wallet = useQuery({ queryKey: ['wallet', user.id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${user.id}`) });
  const grants = useQuery({ queryKey: ['bonus-grants', 'mine'], queryFn: () => api<{ grants: BonusGrant[] }>('/bonus-grants') });
  const progress = useQuery({ queryKey: ['progress', user.id], queryFn: () => api<Progress>(`/progress/${user.id}`) });
  const extras = useQuery({ queryKey: ['extras'], queryFn: () => api<{ board: ExtraBoardItem[] }>('/extras') });
  const [logOpen, setLogOpen] = useState(false);
  const [photoFor, setPhotoFor] = useState<Instance | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

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
      toast(r.status === 'approved' ? `¡+${r.points} puntos!` : r.onTime === false ? `«${inst.title}» enviada, con retraso. Falta que la validen.` : `«${inst.title}» enviada. Falta que la validen.`);
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
  const raw = list.data?.instances ?? [];
  // Tareas repetibles: de cada grupo se muestra la abierta o, si ya no queda, la última hecha («Hecha 2 de 3 hoy»).
  const shown = new Map<string, Instance>();
  for (const i of [...raw].sort((a, b) => a.repeat_no - b.repeat_no)) {
    const k = `${i.task_id}|${i.assignee_id}|${i.due_date}`;
    const cur = shown.get(k);
    const isOpen = i.status === 'pending' || i.status === 'rejected';
    if (!cur || isOpen || !(cur.status === 'pending' || cur.status === 'rejected')) shown.set(k, i);
  }
  const all = raw.filter((i) => shown.get(`${i.task_id}|${i.assignee_id}|${i.due_date}`) === i);
  // «Cuando haga falta» va aparte: es opcional y no cuenta en lo que te queda.
  const optional = all.filter((i) => i.recurrence === 'as_needed');
  const items = all.filter((i) => i.recurrence !== 'as_needed');
  const firsts = raw.filter((i) => i.repeat_no === 1 && i.recurrence !== 'as_needed'); // el día cuenta una vez, repita o no
  const boardCount = extras.data?.board.length ?? 0;
  const hasOptional = optional.length > 0 || boardCount > 0; // «Cuando haga falta» o trabajos extra a la vista
  const freeExtras = (extras.data?.board ?? []).filter((e) => !e.assignee_id && e.status === 'pending').length;
  const open = items.filter((i) => (i.status === 'pending' || i.status === 'rejected') && !i.check_mode && i.repeat_no === 1);
  const doneCount = firsts.filter((i) => i.status === 'approved' || i.status === 'submitted').length;
  const screenMin = wallet.data?.wallet.screen_minutes;
  const pendingGrants = grants.data?.grants ?? [];
  const p = progress.data;

  const onComplete = (inst: Instance) => (inst.requires_photo ? setPhotoFor(inst) : complete.mutate({ inst }));

  return (
    <div className="mx-auto max-w-2xl">
      {/* Franja de marca: el osito de DiploP se asoma por el borde inferior, como en el banner. */}
      <section className="relative mb-6 flex flex-col items-center gap-5 overflow-hidden rounded-[var(--radius-panel)] bg-[#0b5a97] p-6 pb-28 text-white shadow-[0_18px_40px_-24px_rgb(11_90_151/0.9)] [--card:#0b5a97] [--chip:#1b6bab] [--line:#2c79b5] [--fg:#fff] [--fg-3:#cfe1f3] sm:flex-row sm:items-center sm:gap-8 sm:pr-48 sm:pb-6">
        <img src="/brand/peek.png" alt="" width={230} height={113} className="pointer-events-none absolute right-2 bottom-0 w-44 [mask-image:linear-gradient(to_right,transparent,black_22%,black_85%,transparent)] sm:w-52" />
        <WeekRing points={p?.week.points ?? 0} goal={p?.week.goal ?? 0} cents={p?.week.cents ?? 0} />
        <div className="text-center sm:text-left">
          <p className="text-sm font-bold muted first-letter:uppercase">{today ? weekdayLong(today) : ''}</p>
          <h1 className="mt-1 text-3xl font-extrabold">
            {firsts.length === 0 ? (hasOptional ? 'Sin tareas fijas hoy' : 'Hoy tienes el día libre') : open.length === 0 ? 'Todo hecho por hoy' : open.length === 1 ? 'Te queda 1 tarea' : `Te quedan ${open.length} tareas`}
          </h1>
          <div className="mt-3 flex flex-wrap justify-center gap-2 sm:justify-start">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--chip)] px-3 py-1 text-sm font-bold">
              <Flame size={16} className={p?.streak ? 'text-sun' : 'text-[var(--fg-3)]'} aria-hidden /> {p?.streak ?? 0} {p?.streak === 1 ? 'día' : 'días'} de racha
            </span>
            {screenMin != null ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--chip)] px-3 py-1 text-sm font-bold">
                <span aria-hidden>📱</span> {minutesLabel(screenMin)} de pantalla
              </span>
            ) : null}
            {screenMin != null ? (
              <button type="button" onClick={() => setLogOpen(true)} className="inline-flex items-center gap-1.5 rounded-full bg-[var(--chip)] px-3 py-1 text-sm font-bold underline decoration-dotted underline-offset-4">
                Anotar pantalla
              </button>
            ) : null}
            {p ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--chip)] px-3 py-1 text-sm font-bold">
                Nivel {p.level.level} · {p.level.title}
              </span>
            ) : null}
          </div>
          {firsts.length === 0 && hasOptional ? (
            <p className="mt-2 text-sm muted">Mira abajo: hay {optional.length ? 'tareas «Cuando haga falta»' : 'trabajos extra'} por si quieres ayudar.</p>
          ) : null}
          {p && p.period.maxPoints > 0 ? (
            <p className="mt-3 text-sm muted">
              Si lo haces todo, est{family.settlement_period === 'week' ? 'a semana' : 'e mes'} puedes ganar <strong className="num text-[var(--fg)]">{euros(p.period.maxCents)}</strong>. Llevas {euros(p.period.earnedCents)}.
            </p>
          ) : null}
        </div>
      </section>

      <MiMesada points={wallet.data?.wallet.points_available} cents={wallet.data?.wallet.points_value_cents} />

      {firsts.length === 0 && hasOptional ? null : <section id="para-hoy" className="mb-8 scroll-mt-20">
        <SectionTitle>Para hoy {firsts.length ? <span className="num ml-1 text-base muted">{doneCount}/{firsts.length}</span> : null}</SectionTitle>
        {items.length ? (
          <ul className="space-y-2.5">
            {items.map((i) => (
              <TaskRow key={i.id} inst={i} canComplete onComplete={onComplete} busy={complete.isPending} celebrate={family.celebrations_enabled && !i.requires_approval} />
            ))}
          </ul>
        ) : (
          <div className="card"><Empty mascot icon={<PartyPopper />} title="Nada por aquí">Disfruta del día.</Empty></div>
        )}
      </section>}

      {optional.length ? (
        <section className="mb-8">
          <SectionTitle>Cuando haga falta</SectionTitle>
          <ul className="space-y-2.5">
            {optional.map((i) => (
              <TaskRow key={i.id} inst={i} canComplete onComplete={onComplete} busy={complete.isPending} celebrate={family.celebrations_enabled && !i.requires_approval} />
            ))}
          </ul>
        </section>
      ) : null}

      {extras.data?.board.length ? (
        <section className="mb-8">
          <Link to="/extras" className="card flex items-center gap-3 p-3.5 font-bold">
            <Hammer size={22} className="text-tangerine" aria-hidden />
            <span className="flex-1">Trabajos extra{freeExtras ? ` · ${freeExtras} libre${freeExtras === 1 ? '' : 's'}` : ''}</span>
            <span className="muted" aria-hidden>›</span>
          </Link>
        </section>
      ) : null}

      {pendingGrants.length ? (
        <section className="mb-8">
          <SectionTitle>Premios por llegar</SectionTitle>
          <ul className="space-y-2">
            {pendingGrants.map((g) => (
              <li key={g.id} className="card flex items-center gap-3 p-3.5">
                <Hourglass size={18} className="shrink-0 text-sun-ink" aria-hidden />
                <span className="min-w-0 flex-1"><span className="block font-bold">{g.label}</span><span className="block text-sm muted">Por «{g.task_title}». Un adulto te lo dará.</span></span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

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
        {preview ? (
          <img src={preview} alt="Vista previa" className="mb-3 max-h-72 w-full rounded-2xl object-cover" />
        ) : null}
        <Button variant="secondary" className="w-full" onClick={() => fileRef.current?.click()}><Camera size={18} /> {file ? 'Hacer otra' : 'Hacer foto'}</Button>
      </Sheet>
      {logOpen && screenMin != null ? <LogScreenSheet balance={screenMin} onClose={() => setLogOpen(false)} /> : null}
      {firsts.length > 0 && open.length === 0 ? <p className="mt-6 flex items-center justify-center gap-2 text-sm muted"><CalendarCheck size={16} aria-hidden /> Mañana más.</p> : null}
    </div>
  );
}

/** Tarjeta «Mi mesada» (como en la imagen de marca): puntos → euros y tres accesos grandes con ✓ verde. */
function MiMesada({ points, cents }: { points?: number; cents?: number }) {
  const links = [
    { href: '#para-hoy', label: 'Mis tareas', anchor: true },
    { to: '/progreso', label: 'Mis puntos' },
    { to: '/premios', label: 'Mis recompensas' },
  ] as const;
  return (
    <section aria-label="Mi mesada" className="mb-8 overflow-hidden rounded-[var(--radius-panel)] border border-[var(--line)] bg-[var(--card)] shadow-[var(--shadow-lift)]">
      <div className="flex items-center gap-2.5 bg-[#17356b] px-4 py-2.5 text-white">
        <Database size={22} aria-hidden />
        <h2 className="text-xl font-extrabold">Mi mesada</h2>
      </div>
      <div className="relative p-3.5">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-[var(--chip)] px-3.5 py-3" aria-label={`${points ?? 0} puntos equivalen a ${euros(cents ?? 0)}`}>
          <span className="num inline-flex items-center gap-1.5 text-2xl font-extrabold"><Star size={24} className="fill-sun text-sun" aria-hidden />{points ?? 0}</span>
          <span aria-hidden className="text-xl muted">→</span>
          <span className="num rounded-xl bg-sun-soft px-3 py-0.5 text-2xl font-extrabold text-ink dark:bg-sun/20 dark:text-[#ffd979]">{euros(cents ?? 0)}</span>
        </p>
        <GoldCoins size={52} className="pointer-events-none absolute -top-5 right-2 hidden min-[400px]:block" />
        <ul className="mt-3 grid gap-2">
          {links.map((l) => {
            const inner = (
              <>
                <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-lg border-2 border-leaf text-leaf"><Check size={22} strokeWidth={3.5} /></span>
                <span className="flex-1 text-lg font-bold">{l.label}</span>
                <ChevronRight size={20} className="muted" aria-hidden />
              </>
            );
            const cls = 'flex min-h-14 items-center gap-3 rounded-2xl border border-[var(--line)] bg-[var(--card)] px-3 transition active:scale-[0.98] hover:bg-[var(--chip)]';
            return (
              <li key={l.label}>
                {'anchor' in l ? <a href={l.href} className={cls}>{inner}</a> : <Link to={l.to} className={cls}>{inner}</Link>}
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
