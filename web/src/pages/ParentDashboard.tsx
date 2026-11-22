import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Banknote, CircleCheckBig, MessageCircle, MonitorSmartphone, Flame, Gift, Hourglass, PartyPopper, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { euros, relative, weekdayLong } from '../lib/format';
import { minutesLabel } from '../lib/deadline';
import { describeEntry } from '../lib/activity';
import type { Instance, User, Wallet } from '../lib/types';
import { Avatar, Button, Empty, Loading, PageHeader, SectionTitle, color } from '../components/ui';
import { Bar, WeekRing } from '../components/Ring';
import { ApprovalCard } from '../components/ApprovalCard';
import { TaskRow } from '../components/TaskRow';
import { GiveScreenSheet, PaySheet } from '../components/MoneySheets';

export default function ParentDashboard() {
  const { user } = useSession();
  const [sheet, setSheet] = useState<{ kind: 'pay' | 'screen'; child: User; wallet: Wallet } | null>(null);
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/dashboard') });
  const today = useQuery({
    queryKey: ['instances', 'today-all'],
    queryFn: () => api<{ instances: Instance[] }>('/instances'),
  });
  if (isLoading || !data) return <Loading />;

  const pending = data.pendingApprovals.length;
  const toDo = pending + data.pendingChecks + data.pendingGrants + data.pendingRequests + data.pendingUsage;
  return (
    <div>
      <PageHeader title="Panel familiar" subtitle={<span className="inline-block first-letter:uppercase">{weekdayLong(data.today)}</span>} />

      {!user.phone || !user.whatsapp_consent_at ? (
        <Link to="/perfil" className="card mb-5 flex items-center gap-3 border-sun/60 bg-sun-soft/70 p-3.5 dark:bg-sun/10">
          <MessageCircle size={22} className="shrink-0 text-sun-ink dark:text-sun" aria-hidden />
          <span className="text-sm"><strong>Recibe por WhatsApp lo que hay que validar.</strong> Añade tu número en Mi perfil.</span>
        </Link>
      ) : null}

      {/* Resumen: tres cifras que importan */}
      <section className="mb-6 grid grid-cols-3 gap-2.5 sm:gap-4">
        <Link to="/validar" className={`card flex flex-col p-3.5 sm:p-5 ${toDo ? 'border-tangerine/50 bg-tangerine-soft/60 dark:bg-tangerine/10' : ''}`}>
          <span className="text-sm font-bold text-[var(--fg-2)]">Por validar</span>
          <span className="num mt-auto pt-2 text-3xl font-extrabold sm:text-4xl">{toDo + data.pendingRedemptions}</span>
        </Link>
        <div className="card flex flex-col p-3.5 sm:p-5">
          <span className="text-sm font-bold text-[var(--fg-2)]">Esta semana</span>
          <span className="num mt-auto pt-2 text-2xl font-extrabold text-leaf-text sm:text-4xl">{euros(data.totals.weekCents)}</span>
        </div>
        <Link to="/mesada" className="card flex flex-col p-3.5 sm:p-5">
          <span className="text-sm font-bold text-[var(--fg-2)]">Pendiente de pagar</span>
          <span className="num mt-auto pt-2 text-2xl font-extrabold sm:text-4xl">{euros(data.totals.pendingCents)}</span>
        </Link>
      </section>

      {/* Hijos */}
      <section className="mb-8">
        <SectionTitle>Cómo va cada uno</SectionTitle>
        {data.kids.length ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {data.kids.map((k: any) => {
              const c = color(k.color);
              const doneToday = k.today.approved + k.today.submitted;
              return (
                <article key={k.id} className="panel overflow-hidden">
                  <div className="flex items-center gap-4 p-5" style={{ background: `linear-gradient(135deg, ${c.soft}66, transparent 70%)` }}>
                    <WeekRing points={k.weekPoints} goal={k.weekly_goal_points} cents={k.weekCents} size={112} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Avatar name={k.display_name} avatar={k.avatar} colorKey={k.color} size={30} />
                        <h3 className="truncate text-xl font-extrabold">{k.display_name}</h3>
                      </div>
                      <p className="mt-2 flex items-center gap-1.5 text-sm font-bold">
                        <Flame size={16} className={k.streak ? 'text-tangerine' : 'text-[var(--fg-3)]'} aria-hidden />
                        {k.streak ? `${k.streak} ${k.streak === 1 ? 'día' : 'días'} de racha` : 'Sin racha todavía'}
                      </p>
                      <div className="mt-3">
                        <div className="mb-1 flex justify-between text-sm">
                          <span className="muted">Hoy</span>
                          <span className="num font-bold">{doneToday}/{k.today.total}</span>
                        </div>
                        <Bar value={doneToday} max={k.today.total} tone="leaf" />
                      </div>
                    </div>
                  </div>
                  <dl className="grid grid-cols-4 divide-x divide-[var(--line)] border-t border-[var(--line)] text-center">
                    <div className="p-3">
                      <dt className="text-xs muted">Puntos</dt>
                      <dd className="num text-lg font-extrabold">{k.wallet.points_available}</dd>
                    </div>
                    <div className="p-3">
                      <dt className="text-xs muted">Por pagar</dt>
                      <dd className="num text-lg font-extrabold">{euros(k.wallet.cents_pending)}</dd>
                    </div>
                    <div className="p-3">
                      <dt className="text-xs muted">Ahorros</dt>
                      <dd className="num text-lg font-extrabold">{euros(k.wallet.cents_savings)}</dd>
                    </div>
                    <div className="p-3">
                      <dt className="text-xs muted">Pantalla</dt>
                      <dd className="num text-lg font-extrabold">{minutesLabel(k.wallet.screen_minutes)}</dd>
                    </div>
                  </dl>
                  <div className="flex gap-2 border-t border-[var(--line)] p-3">
                    <Button variant="success" size="sm" className="flex-1" disabled={k.wallet.cents_pending <= 0} onClick={() => setSheet({ kind: 'pay', child: k, wallet: k.wallet })}><Banknote size={16} aria-hidden /> Pagar</Button>
                    <Button variant="secondary" size="sm" className="flex-1" disabled={k.wallet.screen_minutes <= 0} onClick={() => setSheet({ kind: 'screen', child: k, wallet: k.wallet })}><MonitorSmartphone size={16} aria-hidden /> Dar pantalla</Button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="card"><Empty mascot icon={<PartyPopper />} title="Añade a tus hijos">Ve a <Link to="/familia" className="inline-flex min-h-11 items-center font-bold text-tangerine-deep underline underline-offset-2">Familia</Link> para crear sus perfiles.</Empty></div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-[1.2fr_1fr]">
        <section>
          <SectionTitle action={pending > 3 ? <Link to="/validar" className="inline-flex min-h-11 items-center text-sm font-bold text-tangerine-deep underline underline-offset-2">Ver las {pending}</Link> : undefined}>Para validar</SectionTitle>
          {pending ? (
            <ul className="space-y-2.5">
              {data.pendingApprovals.slice(0, 3).map((p: any) => <ApprovalCard key={p.id} p={p} compact />)}
            </ul>
          ) : (
            <div className="card"><Empty mascot icon={<CircleCheckBig />} title="Todo validado">Cuando terminen una tarea, aparecerá aquí.</Empty></div>
          )}
          {data.pendingChecks || data.pendingGrants || data.pendingRequests || data.pendingUsage ? (
            <Link to="/validar" className="card mt-3 flex items-center gap-3 p-4 font-bold">
              <CircleCheckBig className="text-leaf" size={22} aria-hidden />
              {[
                data.pendingChecks ? `${data.pendingChecks} por comprobar` : '',
                data.pendingGrants ? `${data.pendingGrants} ${data.pendingGrants === 1 ? 'premio' : 'premios'} por cumplir` : '',
                data.pendingRequests ? `${data.pendingRequests} ${data.pendingRequests === 1 ? 'petición' : 'peticiones'}` : '',
                data.pendingUsage ? `${data.pendingUsage} de pantalla por confirmar` : '',
              ].filter(Boolean).join(' · ')}
            </Link>
          ) : null}
          {data.pendingRedemptions ? (
            <Link to="/premios" className="card mt-3 flex items-center gap-3 p-4 font-bold">
              <Gift className="text-tangerine" size={22} aria-hidden />
              {data.pendingRedemptions === 1 ? '1 recompensa pedida' : `${data.pendingRedemptions} recompensas pedidas`}
            </Link>
          ) : null}
          {data.overdueLastWeek ? (
            <p className="mt-3 flex items-center gap-2 text-sm muted"><TriangleAlert size={16} className="text-sun" aria-hidden /> {data.overdueLastWeek} tareas vencidas en los últimos 7 días</p>
          ) : null}

          <div className="mt-8">
            <SectionTitle>Tareas de hoy</SectionTitle>
            {today.data?.instances.length ? (
              <ul className="space-y-2">
                {today.data.instances.map((i) => <TaskRow key={i.id} inst={i} showAssignee />)}
              </ul>
            ) : (
              <div className="card"><Empty icon={<Hourglass />} title="Hoy no hay tareas">Crea tareas en la sección Tareas.</Empty></div>
            )}
          </div>
        </section>

        <section>
          <SectionTitle action={<Link to="/actividad" className="inline-flex min-h-11 items-center text-sm font-bold text-tangerine-deep underline underline-offset-2">Historial</Link>}>Actividad reciente</SectionTitle>
          <ol className="card divide-y divide-[var(--line)]">
            {data.activity.slice(0, 8).map((a: any) => (
              <li key={a.id} className="flex items-start gap-3 p-3.5">
                <Avatar name={a.actor_name ?? '·'} avatar={a.actor_avatar} colorKey={a.actor_color} size={30} />
                <p className="min-w-0 flex-1 text-sm"><span className="font-bold">{a.actor_name ?? 'Sistema'}</span> {describeEntry(a)}</p>
                <span className="shrink-0 text-xs muted">{relative(a.created_at)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {sheet?.kind === 'pay' ? <PaySheet child={sheet.child} wallet={sheet.wallet} onClose={() => setSheet(null)} /> : null}
      {sheet?.kind === 'screen' ? <GiveScreenSheet child={sheet.child} minutes={sheet.wallet.screen_minutes} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
