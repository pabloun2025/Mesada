import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift } from 'lucide-react';
import { api, post } from '../lib/api';
import type { BonusGrant } from '../lib/types';
import { Button } from './ui';
import { SwapBonusSheet } from './SwapBonusSheet';

const CONFETTI = ['#FFB800', '#1D5FAE', '#1E9E6A', '#D6336C', '#F26B1D'];

/**
 * Sorpresa ganada: se muestra una sola vez, la próxima vez que el hijo abre la app.
 * La confetti es solo CSS y se anula con prefers-reduced-motion (ver styles.css).
 */
export function RevealModal() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['bonus-grants', 'unrevealed'], queryFn: () => api<{ grants: BonusGrant[] }>('/bonus-grants/unrevealed'), refetchOnWindowFocus: true });
  const [seen, setSeen] = useState<string[]>([]);
  const [changing, setChanging] = useState<BonusGrant | null>(null);
  const grant = changing ? undefined : data?.grants.find((g) => !seen.includes(g.id));
  const ref = useRef<HTMLDialogElement>(null);
  const reveal = useMutation({
    mutationFn: ({ g }: { g: BonusGrant; change?: boolean }) => post(`/bonus-grants/${g.id}/reveal`),
    onSuccess: (_r, { g, change }) => {
      setSeen((ids) => [...ids, g.id]);
      if (change) {
        ref.current?.close();
        setChanging(g);
      }
      qc.invalidateQueries({ queryKey: ['bonus-grants'] });
    },
  });
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (grant && !d.open) d.showModal();
    if (!grant && d.open) d.close();
  }, [grant]);

  return (
    <>
    <dialog ref={ref} aria-label="Sorpresa" onCancel={(e) => e.preventDefault()} className="m-auto w-[min(92vw,24rem)] overflow-visible bg-transparent p-0 backdrop:bg-[#0c1428]/70">
      {grant ? (
        <div className="reveal-card relative overflow-hidden rounded-[var(--radius-panel)] bg-[var(--card)] p-7 text-center text-[var(--fg)]">
          <div aria-hidden className="pointer-events-none absolute inset-0">
            {Array.from({ length: 18 }, (_, i) => (
              <span key={i} className="confetti" style={{ left: `${(i * 37) % 100}%`, background: CONFETTI[i % CONFETTI.length], animationDelay: `${(i % 6) * 0.12}s` }} />
            ))}
          </div>
          <p className="reveal-gift flex justify-center text-sun-ink dark:text-sun" aria-hidden><Gift size={64} strokeWidth={1.75} /></p>
          <p className="mt-3 font-display text-sm font-bold uppercase tracking-wide text-sun-ink dark:text-sun">¡Sorpresa!</p>
          <h2 className="mt-1 text-2xl font-extrabold">{grant.label}</h2>
          <p className="mt-2 muted">Por «{grant.task_title}».{grant.kind === 'text' || grant.kind === 'reward' ? ' Un adulto te lo dará.' : ''}</p>
          <Button className="mt-5 w-full" loading={reveal.isPending} onClick={() => reveal.mutate({ g: grant })}>{grant.can_swap ? 'Quedarme con mi premio' : '¡Genial!'}</Button>
          {grant.can_swap ? <Button className="mt-2 w-full" variant="secondary" disabled={reveal.isPending} onClick={() => reveal.mutate({ g: grant, change: true })}>Cambiar premio</Button> : null}
          {reveal.error ? <p role="alert" className="mt-2 text-sm text-berry-deep">{reveal.error.message}</p> : null}
        </div>
      ) : null}
    </dialog>
    {changing ? <SwapBonusSheet grant={changing} onClose={() => setChanging(null)} /> : null}
    </>
  );
}
