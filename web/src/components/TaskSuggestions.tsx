import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import type { TaskSuggestion } from '../lib/types';
import { Badge, Button, SectionTitle, useToast } from './ui';

export function useTaskSuggestions() {
  return useQuery({ queryKey: ['task-suggestions'], queryFn: () => api<{ suggestions: TaskSuggestion[] }>('/task-suggestions') });
}

export function ParentTaskSuggestions() {
  const query = useTaskSuggestions();
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const activate = useMutation({
    mutationFn: (p: { taskId: string; percentage: 30 | 50 }) => post(`/tasks/${p.taskId}/promotion`, { percentage: p.percentage }),
    onSuccess: () => { toast('Promoción activada para hoy'); invalidate(); },
    onError: (e: Error) => { toast(e.message, 'error'); invalidate(); },
  });
  const tasks = (query.data?.suggestions ?? []).filter((task) => task.base_points > 0 && (task.can_promote || task.promotion));
  if (!tasks.length) return null;
  return (
    <section className="mt-6" aria-label="Sugerencias de tareas">
      <SectionTitle>Sugerencias de tareas</SectionTitle>
      <ul className="card divide-y divide-[var(--line)]">
        {tasks.map((t) => (
          <li key={t.instance_id} className="flex flex-wrap items-center gap-2 p-3.5">
            <div className="min-w-0 flex-1"><p className="font-bold wrap-anywhere">{t.icon} {t.title}</p><p className="text-sm muted">{t.base_points} pts habituales</p></div>
            {t.promotion ? <Badge tone="leaf">+{t.promotion.extra_points} pts · solo hoy · un uso</Badge> : (
              <div role="group" aria-label={`Promoción para ${t.title}`} className="flex flex-wrap gap-1">
                {([30, 50] as const).filter((n) => Math.round(t.base_points * n / 100) > 0).map((percentage) => (
                  <Button key={percentage} size="sm" variant="secondary" disabled={activate.isPending} onClick={() => activate.mutate({ taskId: t.task_id, percentage })}>+{percentage} %</Button>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
