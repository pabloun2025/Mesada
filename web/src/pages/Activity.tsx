import { useInfiniteQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { describeAction } from '../lib/activity';
import { Button, Loading, PageHeader } from '../components/ui';

export default function Activity() {
  const q = useInfiniteQuery({
    queryKey: ['activity'],
    queryFn: ({ pageParam }) => api(`/activity${pageParam ? `?before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last: any) => (last.entries.length === 100 ? last.entries[last.entries.length - 1].id : undefined),
  });
  if (q.isLoading) return <Loading />;
  const entries = q.data?.pages.flatMap((p: any) => p.entries) ?? [];
  return (
    <div className="max-w-3xl">
      <PageHeader title="Historial" subtitle="Registro de todo lo que ha pasado: tareas, puntos, cierres, pagos y cambios de ajustes. No se puede borrar." />
      <ol className="card divide-y divide-[var(--line)]">
        {entries.map((a: any) => (
          <li key={a.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 p-3.5 text-sm">
            <span className="num w-32 shrink-0 muted">{fmtDateTime(a.created_at)}</span>
            <span className="min-w-0 flex-1"><span className="font-bold">{a.actor_name ?? 'Sistema'}</span> {describeAction(a)}</span>
          </li>
        ))}
      </ol>
      {q.hasNextPage ? <div className="mt-4 flex justify-center"><Button variant="secondary" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Ver más</Button></div> : null}
    </div>
  );
}
