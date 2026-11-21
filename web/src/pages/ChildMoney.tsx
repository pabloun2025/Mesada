import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Banknote, MonitorPlay, NotebookPen, PiggyBank, Plus, Target, Trash2 } from 'lucide-react';
import { api, del, newKey, post } from '../lib/api';
import { euros, parseEuros, relative } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { PayoutRequest, Wallet } from '../lib/types';
import { screenPhrase } from '../lib/screen';
import { LogScreenSheet, RequestMoneySheet, RequestScreenSheet } from '../components/MoneySheets';
import { Badge, Button, Field, IconButton, Loading, PageHeader, SectionTitle, Sheet, useToast } from '../components/ui';
import { Bar } from '../components/Ring';
import { LedgerList, ScreenList } from '../components/Ledger';
import { minutesLabel } from '../lib/deadline';

export default function ChildMoney() {
  const { user, family } = useSession();
  const { data, isLoading } = useQuery({ queryKey: ['wallet', user.id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${user.id}`) });
  const goals = useQuery({ queryKey: ['goals', user.id], queryFn: () => api(`/goals/${user.id}`) });
  const requests = useQuery({ queryKey: ['payout-requests', 'mine'], queryFn: () => api<{ requests: PayoutRequest[] }>('/payout-requests') });
  const [sheet, setSheet] = useState<'money' | 'screen' | 'log' | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [goalOpen, setGoalOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [goal, setGoal] = useState({ title: '', target: '' });
  const [key, setKey] = useState(newKey);
  const toast = useToast();
  const invalidate = useInvalidateAll();

  const save = useMutation({
    mutationFn: () => {
      const cents = parseEuros(amount);
      if (!cents) throw new Error('Escribe un importe, por ejemplo 2,50');
      return post('/savings/transfer', { userId: user.id, cents, direction: 'to_savings' }, key);
    },
    onSuccess: () => { toast('Guardado en la hucha'); setSaveOpen(false); setAmount(''); setKey(newKey()); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const addGoal = useMutation({
    mutationFn: () => {
      const cents = parseEuros(goal.target);
      if (!cents || !goal.title.trim()) throw new Error('Pon un nombre y un importe');
      return post('/goals', { userId: user.id, title: goal.title, targetCents: cents });
    },
    onSuccess: () => { setGoalOpen(false); setGoal({ title: '', target: '' }); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/payout-requests/${id}/cancel`),
    onSuccess: () => { toast('Petición cancelada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const removeGoal = useMutation({ mutationFn: (id: string) => del(`/goals/${id}`), onSuccess: invalidate });

  if (isLoading || !data) return <Loading />;
  const w = data.wallet;
  const reqs = (requests.data?.requests ?? []).slice(0, 6);
  const hasPending = (kind: string) => reqs.some((r) => r.kind === kind && r.status === 'pending');
  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Mi dinero" subtitle={`${family.rate_points} puntos = ${euros(family.rate_cents)}`} />
      <section className="panel overflow-hidden">
        <div className="bg-ink p-6 text-white">
          <p className="text-sm font-bold text-white/70">Te deben</p>
          <p className="num mt-1 text-5xl font-extrabold">{euros(w.cents_pending)}</p>
          <p className="mt-2 text-sm text-white/70">Ya cobrado en total: {euros(w.cents_paid_total)}</p>
        </div>
        <dl className="grid grid-cols-2 divide-x divide-[var(--line)]">
          <div className="p-4">
            <dt className="text-sm font-bold muted">Puntos por convertir</dt>
            <dd className="num text-2xl font-extrabold">{w.points_available}</dd>
            <dd className="text-sm muted">≈ {euros(w.points_value_cents)} en el próximo cierre</dd>
          </div>
          <div className="p-4">
            <dt className="text-sm font-bold muted">En la hucha</dt>
            <dd className="num text-2xl font-extrabold text-leaf">{euros(w.cents_savings)}</dd>
            <dd className="text-sm muted">Para tus metas</dd>
          </div>
        </dl>
      </section>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="success" disabled={w.cents_pending <= 0} onClick={() => setSaveOpen(true)}><PiggyBank size={18} /> Guardar en la hucha</Button>
        <Button variant="secondary" disabled={w.cents_pending <= 0 || hasPending('money')} onClick={() => setSheet('money')}><Banknote size={18} /> Pedir mi dinero</Button>
      </div>

      <section className="mt-8">
        <SectionTitle action={<Button size="sm" variant="secondary" onClick={() => setGoalOpen(true)}><Plus size={16} /> Meta</Button>}>Mis metas de ahorro</SectionTitle>
        {goals.data?.goals?.length ? (
          <ul className="space-y-2.5">
            {goals.data.goals.map((g: any) => (
              <li key={g.id} className="card p-4">
                <div className="mb-2 flex items-center gap-2">
                  <Target size={18} className="text-leaf" aria-hidden />
                  <span className="flex-1 font-bold">{g.title}</span>
                  <span className="num text-sm font-bold">{euros(Math.min(w.cents_savings, g.target_cents))} / {euros(g.target_cents)}</span>
                  <IconButton label={`Quitar meta «${g.title}»`} onClick={() => removeGoal.mutate(g.id)}><Trash2 size={16} /></IconButton>
                </div>
                <Bar value={w.cents_savings} max={g.target_cents} tone="leaf" />
              </li>
            ))}
          </ul>
        ) : <p className="muted">Ponte una meta (unos auriculares, un juego…) y ve llenando la hucha.</p>}
      </section>

      {reqs.length ? (
        <section className="mt-8">
          <SectionTitle>Mis peticiones</SectionTitle>
          <ul className="space-y-2.5">
            {reqs.map((r) => (
              <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3.5">
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{r.kind === 'money' ? euros(r.amount_cents!) : screenPhrase(r.minutes!, r.category)}</p>
                  <p className="text-sm muted">{relative(r.created_at)}{r.decision_note ? ` · «${r.decision_note}»` : ''}</p>
                </div>
                {r.status === 'pending' ? (
                  <>
                    <Badge tone="sun">Esperando</Badge>
                    <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)} aria-label={`Cancelar mi petición de ${r.kind === 'money' ? euros(r.amount_cents!) : screenPhrase(r.minutes!, r.category)}`}>Cancelar</Button>
                  </>
                ) : r.status === 'approved' ? (
                  <Badge tone="leaf">Aprobada{r.kind === 'money' && r.granted_cents !== r.amount_cents ? ` (${euros(r.granted_cents ?? 0)})` : r.kind === 'screen' && r.granted_minutes !== r.minutes ? ` (${r.granted_minutes} min)` : ''}</Badge>
                ) : <Badge tone={r.status === 'rejected' ? 'berry' : 'muted'}>{r.status === 'rejected' ? 'Rechazada' : 'Cancelada'}</Badge>}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="mt-8">
        <SectionTitle>Mi tiempo de pantalla</SectionTitle>
        <div className="card p-4">
          <p className="mb-2 text-sm font-bold muted">Te quedan</p>
          <p className="num mb-3 text-3xl font-extrabold">{minutesLabel(w.screen_minutes)}</p>
          <div className="mb-4 flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" disabled={w.screen_minutes <= 0 || hasPending('screen')} onClick={() => setSheet('screen')}><MonitorPlay size={16} /> Pedir pantalla</Button>
            <Button size="sm" variant="secondary" onClick={() => setSheet('log')}><NotebookPen size={16} /> Anotar pantalla</Button>
          </div>
          <ScreenList userId={user.id} />
        </div>
      </section>

      <section className="mt-8">
        <SectionTitle>Movimientos</SectionTitle>
        <div className="card p-4"><LedgerList userId={user.id} /></div>
      </section>

      {sheet === 'money' ? <RequestMoneySheet balanceCents={w.cents_pending} onClose={() => setSheet(null)} /> : null}
      {sheet === 'screen' ? <RequestScreenSheet balance={w.screen_minutes} onClose={() => setSheet(null)} /> : null}
      {sheet === 'log' ? <LogScreenSheet balance={w.screen_minutes} onClose={() => setSheet(null)} /> : null}
      <Sheet open={saveOpen} onClose={() => setSaveOpen(false)} title="Guardar en la hucha" footer={<Button className="w-full" variant="success" loading={save.isPending} onClick={() => save.mutate()}>Guardar</Button>}>
        <p className="mb-4 muted">Para sacar dinero de la hucha tendrás que pedírselo a un adulto.</p>
        <Field label="Importe (€)">{(id) => <input id={id} className="field num text-2xl font-extrabold" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />}</Field>
      </Sheet>
      <Sheet open={goalOpen} onClose={() => setGoalOpen(false)} title="Nueva meta" footer={<Button className="w-full" loading={addGoal.isPending} onClick={() => addGoal.mutate()}>Crear meta</Button>}>
        <div className="space-y-4">
          <Field label="¿Para qué ahorras?">{(id) => <input id={id} className="field" value={goal.title} onChange={(e) => setGoal({ ...goal, title: e.target.value })} maxLength={80} />}</Field>
          <Field label="¿Cuánto cuesta? (€)">{(id) => <input id={id} className="field num" inputMode="decimal" value={goal.target} onChange={(e) => setGoal({ ...goal, target: e.target.value })} />}</Field>
        </div>
      </Sheet>
    </div>
  );
}
