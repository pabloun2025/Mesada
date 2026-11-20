import { useQuery } from '@tanstack/react-query';
import { Flame, Trophy } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { useSession } from '../lib/session';
import type { Progress } from '../lib/types';
import { Avatar, Loading, PageHeader, SectionTitle } from '../components/ui';
import { Bar } from '../components/Ring';
import { StatsChart } from '../components/StatsChart';

export default function ChildProgress() {
  const { user, family } = useSession();
  const { data: p, isLoading } = useQuery({ queryKey: ['progress', user.id], queryFn: () => api<Progress>(`/progress/${user.id}`) });
  const board = useQuery({ queryKey: ['leaderboard'], queryFn: () => api('/leaderboard'), enabled: family.leaderboard_enabled });
  if (isLoading || !p) return <Loading />;
  const earned = p.badges.filter((b) => b.awardedAt).length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="Tu progreso" subtitle={`${p.lifetimePoints} puntos ganados desde el principio`} />
      <div className="grid gap-4 sm:grid-cols-2">
        <section className="panel p-5">
          <p className="text-sm font-bold muted">Nivel</p>
          <p className="mt-1 flex items-baseline gap-2"><span className="num text-5xl font-extrabold">{p.level.level}</span><span className="font-display text-xl font-bold">{p.level.title}</span></p>
          <div className="mt-4"><Bar value={p.level.current} max={p.level.needed} /></div>
          <p className="mt-2 text-sm muted">Te faltan {p.level.needed - p.level.current} puntos para el nivel {p.level.level + 1}.</p>
        </section>
        <section className="panel p-5">
          <p className="text-sm font-bold muted">Racha</p>
          <p className="mt-1 flex items-center gap-2"><Flame className="text-tangerine" size={36} aria-hidden /><span className="num text-5xl font-extrabold">{p.streak}</span><span className="font-display text-xl font-bold">{p.streak === 1 ? 'día' : 'días'}</span></p>
          <p className="mt-4 text-sm muted">Los días sin tareas no rompen la racha.</p>
        </section>
        <section className="panel p-5 sm:col-span-2">
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-bold muted">Objetivo de la semana</p>
              <p className="num mt-1 text-3xl font-extrabold">{p.week.points} <span className="text-lg muted">/ {p.week.goal || '—'} pts</span></p>
            </div>
            {p.week.goal > 0 && p.week.points >= p.week.goal ? <span className="rounded-full bg-leaf-soft px-3 py-1 font-bold text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]">¡Conseguido!</span> : null}
          </div>
          <div className="mt-3"><Bar value={p.week.points} max={p.week.goal || 1} tone="leaf" /></div>
          <p className="mt-2 text-sm muted">
            Este {p.period.type === 'week' ? 'periodo' : 'mes'}: {p.period.earnedPoints} pts conseguidos, {p.period.waitingPoints} esperando validación{p.period.missedPoints ? `, ${p.period.missedPoints} perdidos` : ''}.
          </p>
        </section>
      </div>

      <section className="mt-8">
        <SectionTitle>Insignias <span className="num ml-1 text-base muted">{earned}/{p.badges.length}</span></SectionTitle>
        <ul className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 md:grid-cols-5">
          {p.badges.map((b) => (
            <li key={b.key} className={`card flex flex-col items-center p-4 text-center ${b.awardedAt ? '' : 'opacity-45 grayscale'}`}>
              <span className="text-3xl" aria-hidden>{b.icon}</span>
              <span className="mt-2 font-bold leading-tight">{b.title}</span>
              <span className="mt-1 text-xs muted">{b.awardedAt ? fmtDate(b.awardedAt) : b.description}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <SectionTitle>Tus últimas semanas</SectionTitle>
        <div className="card p-4"><StatsChart userId={user.id} /></div>
      </section>

      {family.leaderboard_enabled && board.data?.entries?.length > 1 ? (
        <section className="mt-8">
          <SectionTitle>Esta semana en casa</SectionTitle>
          <ol className="card divide-y divide-[var(--line)]">
            {board.data.entries.map((e: any, i: number) => (
              <li key={e.id} className={`flex items-center gap-3 p-3.5 ${e.id === user.id ? 'bg-tangerine-soft/50 dark:bg-tangerine/10' : ''}`}>
                <span className="num w-6 text-center font-extrabold muted">{i + 1}</span>
                <Avatar name={e.display_name} avatar={e.avatar} colorKey={e.color} size={34} />
                <span className="flex-1 font-bold">{e.display_name}</span>
                {i === 0 && e.points > 0 ? <Trophy size={18} className="text-sun" aria-label="En cabeza" /> : null}
                <span className="num font-extrabold">{e.points} pts</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}
