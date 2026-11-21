import { useQuery } from '@tanstack/react-query';
import { CircleCheckBig } from 'lucide-react';
import { api } from '../lib/api';
import { relative } from '../lib/format';
import { useDecideRedemption } from '../lib/hooks';
import type { Redemption } from '../lib/types';
import { Avatar, Button, Empty, Loading, PageHeader, PointsPill, SectionTitle } from '../components/ui';
import { ApprovalCard } from '../components/ApprovalCard';

export default function Approvals() {
  const { data, isLoading } = useQuery({ queryKey: ['dashboard'], queryFn: () => api('/dashboard') });
  const reds = useQuery({ queryKey: ['redemptions', 'requested'], queryFn: () => api<{ redemptions: Redemption[] }>('/redemptions?status=requested') });
  const decide = useDecideRedemption();
  if (isLoading || !data) return <Loading />;
  const list = data.pendingApprovals;
  const requested = reds.data?.redemptions ?? [];

  return (
    <div className="max-w-3xl">
      <PageHeader title="Validar" subtitle="Revisa lo que han hecho. Puedes ajustar los puntos antes de aprobar." />
      <section className="mb-8">
        <SectionTitle>Tareas terminadas</SectionTitle>
        {list.length ? (
          <ul className="space-y-3">{list.map((p: any) => <ApprovalCard key={p.id} p={p} />)}</ul>
        ) : (
          <div className="card"><Empty mascot icon={<CircleCheckBig />} title="Nada por validar">Cuando marquen una tarea, aparecerá aquí.</Empty></div>
        )}
      </section>
      {requested.length ? (
        <section>
          <SectionTitle>Recompensas pedidas</SectionTitle>
          <ul className="space-y-3">
            {requested.map((r) => (
              <li key={r.id} className="card flex flex-wrap items-center gap-3 p-3.5">
                <Avatar name={r.display_name} avatar={r.avatar} colorKey={r.color} size={40} />
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{r.reward_title}</p>
                  <p className="text-sm muted">{r.display_name} · {relative(r.requested_at)}</p>
                </div>
                <PointsPill points={r.cost_points} sign={false} />
                <div className="flex gap-2">
                  <Button size="sm" variant="danger" onClick={() => decide.mutate({ id: r.id, decision: 'rejected' })}>Rechazar</Button>
                  <Button size="sm" variant="success" onClick={() => decide.mutate({ id: r.id, decision: 'approved' })}>Aprobar</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
