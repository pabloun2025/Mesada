import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Gift, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { relative } from '../lib/format';
import { useDecideRedemption, useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Redemption, Reward, Wallet } from '../lib/types';
import { Avatar, Badge, Button, Empty, Field, IconButton, Loading, PageHeader, PointsPill, SectionTitle, Sheet, useToast } from '../components/ui';
import { Bar } from '../components/Ring';

const ICONS = ['🎁', '🎬', '🎮', '🌙', '🍕', '🍦', '🧗', '🎳', '📱', '🛹', '🎨', '🏊', '📚', '🎟️', '🧁', '⚽'];
const STATUS = { requested: { label: 'Pedida', tone: 'sun' }, approved: { label: 'Aprobada', tone: 'leaf' }, rejected: { label: 'Rechazada', tone: 'berry' }, delivered: { label: 'Entregada', tone: 'muted' } } as const;

function RewardEditor({ initial, onClose }: { initial: Partial<Reward>; onClose: () => void }) {
  const [r, setR] = useState({ title: initial.title ?? '', description: initial.description ?? '', icon: initial.icon ?? '🎁', costPoints: initial.cost_points ?? 50 });
  const [error, setError] = useState('');
  const invalidate = useInvalidateAll();
  const save = useMutation({
    mutationFn: () => (initial.id ? put(`/rewards/${initial.id}`, r) : post('/rewards', r)),
    onSuccess: () => { invalidate(); onClose(); },
    onError: (e: Error) => setError(e.message),
  });
  return (
    <Sheet open onClose={onClose} title={initial.id ? 'Editar recompensa' : 'Nueva recompensa'} footer={<Button className="w-full" loading={save.isPending} onClick={() => save.mutate()}>Guardar</Button>}>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Icono">
          {ICONS.map((i) => (
            <button key={i} type="button" role="radio" aria-checked={r.icon === i} onClick={() => setR({ ...r, icon: i })}
              className={`flex size-10 items-center justify-center rounded-xl text-xl ${r.icon === i ? 'bg-tangerine-soft ring-2 ring-tangerine dark:bg-tangerine/20' : 'bg-[var(--chip)]'}`}>{i}</button>
          ))}
        </div>
        <Field label="Recompensa">{(id) => <input id={id} className="field" value={r.title} onChange={(e) => setR({ ...r, title: e.target.value })} placeholder="Elegir la peli del viernes…" maxLength={80} />}</Field>
        <Field label="Detalles (opcional)">{(id) => <input id={id} className="field" value={r.description} onChange={(e) => setR({ ...r, description: e.target.value })} maxLength={500} />}</Field>
        <Field label="Cuesta (puntos)">{(id) => <input id={id} className="field num w-32 font-bold" type="number" min={1} value={r.costPoints} onChange={(e) => setR({ ...r, costPoints: Number(e.target.value) })} />}</Field>
        {error ? <p role="alert" className="text-sm font-bold text-berry">{error}</p> : null}
      </div>
    </Sheet>
  );
}

export default function Rewards() {
  const { user } = useSession();
  const isAdult = user.role === 'adult';
  const rewards = useQuery({ queryKey: ['rewards'], queryFn: () => api<{ rewards: Reward[] }>('/rewards') });
  const reds = useQuery({ queryKey: ['redemptions'], queryFn: () => api<{ redemptions: Redemption[] }>('/redemptions') });
  const wallet = useQuery({ queryKey: ['wallet', user.id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${user.id}`), enabled: !isAdult });
  const [editing, setEditing] = useState<Partial<Reward> | null>(null);
  const [confirming, setConfirming] = useState<Reward | null>(null);
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const decide = useDecideRedemption();
  const redeem = useMutation({
    mutationFn: (id: string) => post(`/rewards/${id}/redeem`),
    onSuccess: () => { toast('¡Pedida! Un adulto tiene que aprobarla.'); setConfirming(null); invalidate(); },
    onError: (e: Error) => { toast(e.message, 'error'); setConfirming(null); },
  });
  const archive = useMutation({ mutationFn: (id: string) => del(`/rewards/${id}`), onSuccess: invalidate });
  if (rewards.isLoading) return <Loading />;
  const balance = wallet.data?.wallet.points_available ?? 0;
  const list = rewards.data?.rewards ?? [];
  const history = reds.data?.redemptions ?? [];

  return (
    <div>
      <PageHeader
        title={isAdult ? 'Recompensas' : 'Premios'}
        subtitle={isAdult ? 'Premios que se pueden canjear con puntos, sin dinero de por medio.' : <>Tienes <strong className="num text-[var(--fg)]">{balance} puntos</strong> para canjear.</>}
        action={isAdult ? <Button onClick={() => setEditing({})}><Plus size={18} /> Nueva</Button> : undefined}
      />
      {list.length ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((r) => {
            const missing = r.cost_points - balance;
            return (
              <li key={r.id} className="panel flex flex-col p-5">
                <div className="flex items-start gap-3">
                  <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-[var(--chip)] text-3xl">{r.icon}</span>
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-lg leading-tight font-bold">{r.title}</p>
                    {r.description ? <p className="mt-0.5 text-sm muted">{r.description}</p> : null}
                  </div>
                  <PointsPill points={r.cost_points} sign={false} />
                </div>
                <div className="mt-auto pt-4">
                  {isAdult ? (
                    <div className="flex justify-end gap-1">
                      <IconButton label={`Editar «${r.title}»`} onClick={() => setEditing(r)}><Pencil size={17} /></IconButton>
                      <IconButton label={`Retirar «${r.title}»`} onClick={() => confirm(`¿Retirar «${r.title}»?`) && archive.mutate(r.id)}><Trash2 size={17} /></IconButton>
                    </div>
                  ) : missing > 0 ? (
                    <div>
                      <Bar value={balance} max={r.cost_points} />
                      <p className="mt-1.5 text-sm muted">Te faltan {missing} puntos</p>
                    </div>
                  ) : (
                    <Button className="w-full" onClick={() => setConfirming(r)}>Canjear</Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="card"><Empty icon={<Gift />} title="Sin recompensas todavía">{isAdult ? 'Elegidlas en familia: elegir la peli, acostarse más tarde, una cena especial…' : 'Pide a tus padres que añadan alguna.'}</Empty></div>
      )}

      {history.length ? (
        <section className="mt-8">
          <SectionTitle>{isAdult ? 'Peticiones' : 'Mis peticiones'}</SectionTitle>
          <ul className="card divide-y divide-[var(--line)]">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-center gap-3 p-3.5">
                {isAdult ? <Avatar name={h.display_name} avatar={h.avatar} colorKey={h.color} size={32} /> : null}
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{h.reward_title}</p>
                  <p className="text-sm muted">{isAdult ? `${h.display_name} · ` : ''}{relative(h.requested_at)} · {h.cost_points} pts</p>
                </div>
                <Badge tone={STATUS[h.status].tone}>{STATUS[h.status].label}</Badge>
                {isAdult && h.status === 'requested' ? (
                  <div className="flex gap-2">
                    <Button size="sm" variant="danger" onClick={() => decide.mutate({ id: h.id, decision: 'rejected' })}>Rechazar</Button>
                    <Button size="sm" variant="success" onClick={() => decide.mutate({ id: h.id, decision: 'approved' })}>Aprobar</Button>
                  </div>
                ) : isAdult && h.status === 'approved' ? (
                  <Button size="sm" variant="secondary" onClick={() => decide.mutate({ id: h.id, decision: 'delivered' })}>Marcar entregada</Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {editing ? <RewardEditor initial={editing} onClose={() => setEditing(null)} /> : null}
      <Sheet open={!!confirming} onClose={() => setConfirming(null)} title="¿Canjear?" footer={<Button className="w-full" loading={redeem.isPending} onClick={() => confirming && redeem.mutate(confirming.id)}>Sí, canjear {confirming?.cost_points} puntos</Button>}>
        <p className="muted">Pedirás «{confirming?.title}». Los puntos se reservan ahora y, si no la aprueban, te los devolvemos.</p>
      </Sheet>
    </div>
  );
}
