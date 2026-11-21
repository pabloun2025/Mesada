import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MonitorPlay, NotebookPen, Plus } from 'lucide-react';
import { api, del, post } from '../lib/api';
import { euros, relative } from '../lib/format';
import { useInvalidateAll } from '../lib/hooks';
import { useSession } from '../lib/session';
import type { Bank, Goal, PayoutRequest, Wallet } from '../lib/types';
import { screenPhrase } from '../lib/screen';
import { LogScreenSheet, RequestScreenSheet } from '../components/MoneySheets';
import { AccountRail, AdvanceSheet, AtmButtons, BalanceTrend, ExchangeSheet, GoalProduct, LoanProduct, LoanSheet, NewGoalSheet, SaveSheet, Statement, WithdrawSheet, type AtmKey } from '../components/Bank';
import { Badge, Button, Loading, PageHeader, SectionTitle, useToast } from '../components/ui';
import { ScreenList } from '../components/Ledger';
import { minutesLabel } from '../lib/deadline';

/** «Mi banco»: tarjetas de cuenta, acciones redondas, gráfica del saldo, productos (préstamo y ahorros) y extracto. */
export default function ChildMoney() {
  const { user, family } = useSession();
  const bankQ = useQuery({ queryKey: ['bank', user.id], queryFn: () => api<{ bank: Bank }>(`/bank/${user.id}`) });
  const walletQ = useQuery({ queryKey: ['wallet', user.id], queryFn: () => api<{ wallet: Wallet }>(`/wallet/${user.id}`) });
  const goalsQ = useQuery({ queryKey: ['goals', user.id], queryFn: () => api<{ goals: Goal[] }>(`/goals/${user.id}`) });
  const requests = useQuery({ queryKey: ['payout-requests', 'mine'], queryFn: () => api<{ requests: PayoutRequest[] }>('/payout-requests') });
  const [sheet, setSheet] = useState<AtmKey | 'screen' | 'log' | 'goal' | null>(null);
  const [depositGoal, setDepositGoal] = useState<string | undefined>();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const cancel = useMutation({
    mutationFn: (id: string) => post(`/payout-requests/${id}/cancel`),
    onSuccess: () => { toast('Petición cancelada'); invalidate(); },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const removeGoal = useMutation({ mutationFn: (id: string) => del(`/goals/${id}`), onSuccess: invalidate, onError: (e: Error) => toast(e.message, 'error') });

  if (bankQ.isLoading || walletQ.isLoading || !bankQ.data || !walletQ.data) return <Loading />;
  const bank = bankQ.data.bank;
  const w = walletQ.data.wallet;
  const goals = goalsQ.data?.goals ?? [];
  const activeGoals = goals.filter((g) => g.status === 'active');
  const doneGoals = goals.filter((g) => g.status !== 'active');
  const reqs = (requests.data?.requests ?? []).slice(0, 6);
  const hasPending = (kind: string) => reqs.some((r) => r.kind === kind && r.status === 'pending');
  const negative = bank.money_cents < 0;

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Mi banco" subtitle={`${family.rate_points} puntos = ${euros(family.rate_cents)}`} />

      <AccountRail bank={bank} wallet={w} />
      {negative ? (
        <p role="status" className="mt-3 rounded-2xl bg-berry-soft p-3 text-sm font-bold text-berry dark:bg-berry/20">
          Tu cuenta de dinero está en negativo. Lo próximo que ganes la irá devolviendo; mientras tanto no puedes retirar ni pedir otro préstamo.
        </p>
      ) : null}
      {bank.points < 0 ? (
        <p role="status" className="mt-3 rounded-2xl bg-sun-soft p-3 text-sm font-bold dark:bg-sun/15">Tienes {bank.points} puntos: los próximos que ganes pagarán primero esa deuda.</p>
      ) : null}

      <div className="mt-4">
        <AtmButtons bank={bank} onPick={(k) => setSheet(k)} />
      </div>

      <section className="mt-6" aria-label="Tu saldo">
        <BalanceTrend history={bank.history} />
        <p className="mt-2 px-1 text-sm muted">Ya cobrado en total: {euros(w.cents_paid_total)}</p>
      </section>

      {reqs.length ? (
        <section className="mt-7">
          <SectionTitle>Mis peticiones</SectionTitle>
          <ul className="space-y-2.5">
            {reqs.map((r) => (
              <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3.5">
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{r.kind === 'money' ? `Retiro de ${euros(r.amount_cents!)}` : screenPhrase(r.minutes!, r.category)}</p>
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

      <section className="mt-7">
        <SectionTitle action={<Button size="sm" variant="ghost" onClick={() => setSheet('goal')}><Plus size={16} /> Nueva meta</Button>}>Mis productos</SectionTitle>
        <div className="space-y-3">
          {bank.loan ? <LoanProduct loan={bank.loan} mine /> : null}
          {activeGoals.length ? (
            <ul className="space-y-3">
              {activeGoals.map((g) => (
                <GoalProduct key={g.id} goal={g} mine onDeposit={(x) => { setDepositGoal(x.id); setSheet('save'); }} onRemove={(x) => removeGoal.mutate(x.id)} />
              ))}
            </ul>
          ) : !bank.loan ? <p className="muted">Ponte una meta (unos auriculares, un vinilo…) y mete dinero cada semana: gana interés.</p> : null}
          {doneGoals.length ? <ul className="space-y-3">{doneGoals.map((g) => <GoalProduct key={g.id} goal={g} mine={false} />)}</ul> : null}
        </div>
      </section>

      <section className="mt-7">
        <SectionTitle>Extracto</SectionTitle>
        <Statement userId={user.id} loan={bank.loan} />
      </section>

      <section className="mt-7">
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

      {sheet === 'withdraw' ? <WithdrawSheet bank={bank} onClose={() => setSheet(null)} /> : null}
      {sheet === 'exchange' ? <ExchangeSheet bank={bank} onClose={() => setSheet(null)} /> : null}
      {sheet === 'advance' ? <AdvanceSheet bank={bank} onClose={() => setSheet(null)} /> : null}
      {sheet === 'loan' ? <LoanSheet bank={bank} onClose={() => setSheet(null)} /> : null}
      {sheet === 'save' ? <SaveSheet bank={bank} goals={goals} initialGoal={depositGoal} onClose={() => { setSheet(null); setDepositGoal(undefined); }} /> : null}
      {sheet === 'goal' ? <NewGoalSheet userId={user.id} onClose={() => setSheet(null)} /> : null}
      {sheet === 'screen' ? <RequestScreenSheet balance={w.screen_minutes} onClose={() => setSheet(null)} /> : null}
      {sheet === 'log' ? <LogScreenSheet balance={w.screen_minutes} onClose={() => setSheet(null)} /> : null}
    </div>
  );
}
