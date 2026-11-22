import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { HeartHandshake, PartyPopper, Gift, Flame } from 'lucide-react';
import { api, newKey, post } from '../lib/api';
import { num, parseEuros, currencySymbol } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import { kinshipText } from '../lib/kinship';
import { Avatar, Button, Empty, Field, Loading, PageHeader, Sheet, useToast } from '../components/ui';
import { GoalBar, GoalVisual, weeksLeftText } from '../components/Goal';
import { LegalLinks } from '../components/LegalLinks';

interface Child {
  id: string; display_name: string; avatar: string; color: string;
  level: { level: number; title: string }; streak: number; week: { points: number; goal: number };
  goals: { id: string; title: string; emoji: string | null; has_photo: boolean; target_cents: number; balance_cents: number; reached: boolean; weeks_left: number | null; pending_request: boolean }[];
}

const QUICK = ['¡Qué orgullo!', '¡Sigue así!', '¡Muy bien, campeón/a!', '¡Estoy muy contento/a contigo!'];

function CheerSheet({ child, onClose }: { child: Child; onClose: () => void }) {
  const [message, setMessage] = useState('');
  const toast = useToast();
  const send = useMutation({
    mutationFn: () => post('/cheers', { toUserId: child.id, message }),
    onSuccess: () => { toast(`Felicitación enviada a ${child.display_name}`); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title={`Felicitar a ${child.display_name}`} subtitle="Le llegará como un aviso en la app." footer={<Button className="w-full" loading={send.isPending} disabled={!message.trim()} onClick={() => send.mutate()}>Enviar felicitación</Button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Frases rápidas">
          {QUICK.map((q) => (
            <button key={q} type="button" onClick={() => setMessage(q)} className="min-h-11 rounded-full border border-[var(--line)] bg-[var(--chip)] px-3.5 text-sm font-bold">{q}</button>
          ))}
        </div>
        <Field label="Tu mensaje" hint={`${message.length} de 140`}>
          {(id) => <textarea id={id} className="field min-h-24" maxLength={140} value={message} onChange={(e) => setMessage(e.target.value)} />}
        </Field>
      </div>
    </Sheet>
  );
}

function GiftSheet({ child, goal, onClose }: { child: Child; goal: Child['goals'][number]; onClose: () => void }) {
  const [amount, setAmount] = useState('');
  const [message, setMessage] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const key = useState(newKey)[0];
  const send = useMutation({
    mutationFn: () => {
      const cents = parseEuros(amount);
      if (!cents) throw new Error('Escribe un importe válido');
      return post(`/goals/${goal.id}/gift`, { cents, message: message.trim() || undefined }, key);
    },
    onSuccess: () => { toast(`Aporte hecho a «${goal.title}»`); invalidate(); onClose(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  return (
    <Sheet open onClose={onClose} title={`Aportar a «${goal.title}»`} subtitle={`Meta de ${child.display_name}`} footer={<Button className="w-full" loading={send.isPending} onClick={() => send.mutate()}>Hacer el aporte</Button>}>
      <div className="space-y-4">
        <p className="muted">Se suma a lo que ya lleva {child.display_name}. Es un regalo para su meta: avisamos a sus padres y a él.</p>
        <Field label={`Importe (${currencySymbol()})`}>{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
        <Field label="Mensaje (opcional)">{(id) => <input id={id} className="field" maxLength={140} value={message} onChange={(e) => setMessage(e.target.value)} />}</Field>
      </div>
    </Sheet>
  );
}

/** Inicio de un pariente (abuelo/a, tío/a…): ve cómo van los niños y los anima. No hay nada que gestionar. */
export default function RelativeHome() {
  const { user } = useSession();
  const { data, isLoading } = useQuery({ queryKey: ['relative-overview'], queryFn: () => api<{ children: Child[] }>('/relative/overview') });
  const [cheer, setCheer] = useState<Child | null>(null);
  const [gift, setGift] = useState<{ child: Child; goal: Child['goals'][number] } | null>(null);
  if (isLoading || !data) return <Loading />;
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title={`Hola, ${user.display_name}`} subtitle={`${kinshipText(user) ? `${kinshipText(user)} · ` : ''}Aquí ves cómo van los niños y puedes animarles.`} />
      {data.children.length ? (
        <ul className="space-y-5">
          {data.children.map((c) => (
            <li key={c.id}>
              <article className="card p-4" aria-label={c.display_name}>
                <div className="flex items-center gap-3">
                  <Avatar name={c.display_name} avatar={c.avatar} colorKey={c.color} size={52} />
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-xl font-extrabold">{c.display_name}</h2>
                    <p className="flex flex-wrap items-center gap-x-3 text-sm muted">
                      <span>Nivel {c.level.level} · {c.level.title}</span>
                      <span className="inline-flex items-center gap-1"><Flame size={14} className={c.streak ? 'text-sun' : ''} aria-hidden /> {c.streak} {c.streak === 1 ? 'día' : 'días'} de racha</span>
                    </p>
                  </div>
                </div>
                <p className="mt-3 text-sm"><span className="num font-bold">{num(c.week.points)}</span> de {num(c.week.goal)} puntos esta semana</p>
                <div className="mt-1 h-2.5 overflow-hidden rounded-full bg-[var(--chip)]" role="progressbar" aria-valuenow={c.week.goal ? Math.min(100, Math.round((c.week.points / c.week.goal) * 100)) : 0} aria-valuemin={0} aria-valuemax={100} aria-label={`Semana de ${c.display_name}`}>
                  <i className="block h-full rounded-full bg-gradient-to-r from-tangerine to-sky" style={{ width: `${c.week.goal ? Math.min(100, (c.week.points / c.week.goal) * 100) : 0}%` }} />
                </div>
                {c.goals.length ? (
                  <ul className="mt-4 space-y-3">
                    {c.goals.map((g) => (
                      <li key={g.id} aria-label={`Meta ${g.title}`} className="rounded-2xl border border-[var(--line)] p-3">
                        <div className="flex items-center gap-3">
                          <GoalVisual goal={g} size={52} />
                          <div className="min-w-0 flex-1">
                            <h3 className="truncate font-bold">{g.title}</h3>
                            <p className="text-sm text-leaf-text dark:text-[#7fe0b2]">{weeksLeftText(g, false) ?? <span className="muted">Ahorrando</span>}</p>
                          </div>
                        </div>
                        <div className="mt-3"><GoalBar goal={g} label={`Meta ${g.title} de ${c.display_name}`} /></div>
                        <Button size="sm" variant="secondary" className="mt-2 w-full" disabled={g.pending_request} onClick={() => setGift({ child: c, goal: g })}>
                          <Gift size={16} aria-hidden /> Aportar a esta meta
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-3 text-sm muted">{c.display_name} aún no tiene una meta de ahorro.</p>}
                <Button className="mt-4 w-full" onClick={() => setCheer(c)}><PartyPopper size={18} aria-hidden /> Felicitar a {c.display_name}</Button>
              </article>
            </li>
          ))}
        </ul>
      ) : (
        <div className="card"><Empty icon={<HeartHandshake />} title="Aún no hay niños">Cuando la familia los añada, los verás aquí.</Empty></div>
      )}
      <p className="mt-6 text-center text-sm muted">Puedes ver y animar. Las tareas, el dinero y los ajustes los gestionan los padres.</p>
      <LegalLinks className="mt-6 justify-center lg:hidden" />
      {cheer ? <CheerSheet child={cheer} onClose={() => setCheer(null)} /> : null}
      {gift ? <GiftSheet child={gift.child} goal={gift.goal} onClose={() => setGift(null)} /> : null}
    </div>
  );
}
