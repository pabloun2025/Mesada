import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useInvalidateAll } from '../lib/hooks';
import type { BonusGrant, Reward } from '../lib/types';
import { Button, Sheet, useToast } from './ui';

type Alternatives = { original_title: string; cost_points: number; alternatives: Pick<Reward, 'id' | 'title' | 'description' | 'icon'>[] };

export function SwapBonusSheet({ grant, onClose }: { grant: BonusGrant; onClose: () => void }) {
  const [selected, setSelected] = useState('');
  const toast = useToast();
  const invalidate = useInvalidateAll();
  const url = `/bonus-grants/${grant.id}`;
  const q = useQuery({ queryKey: ['bonus-grants', grant.id, 'alternatives'], queryFn: () => api<Alternatives>(`${url}/alternatives`), retry: false });
  const swap = useMutation({
    mutationFn: (rewardId: string) => post(`${url}/swap`, { rewardId }),
    onSuccess: () => { toast('Sorpresa cambiada'); invalidate(); onClose(); },
    onError: () => { invalidate(); },
  });
  const eligible = q.data?.alternatives ?? [];
  return (
    <Sheet open onClose={onClose} title="Cambiar premio" footer={
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={swap.isPending} onClick={onClose}>Quedarme con el original</Button>
        {eligible.length ? <Button variant="success" className="flex-1" loading={swap.isPending} disabled={!eligible.some((r) => r.id === selected)} onClick={() => swap.mutate(selected)}>Confirmar cambio</Button> : null}
      </div>
    }>
      <div className="space-y-3">
        {q.data ? <p className="text-sm wrap-anywhere">Tu premio es <strong>«{q.data.original_title}»</strong> · vale {q.data.cost_points} puntos.</p> : <p className="font-bold wrap-anywhere">{grant.label}</p>}
        {q.isLoading ? <p role="status" className="text-sm muted">Buscando premios…</p> : q.data && !eligible.length ? <p className="text-sm muted">No hay otros premios disponibles del mismo valor.</p> : null}
        {eligible.length ? <fieldset className="space-y-2" disabled={swap.isPending}>
          <legend className="mb-1 text-sm font-bold">Elige un premio del mismo valor</legend>
          {eligible.map((r) => <label key={r.id} className="flex min-h-11 items-center gap-3 rounded-xl border border-[var(--line)] px-3 py-2 text-sm">
            <input type="radio" name={`reward-${grant.id}`} value={r.id} checked={selected === r.id} onChange={() => setSelected(r.id)} />
            <span className="min-w-0"><strong className="wrap-anywhere">{r.icon} {r.title}</strong>{r.description ? <span className="block muted wrap-anywhere">{r.description}</span> : null}</span>
          </label>)}
        </fieldset> : null}
        {swap.error || q.error ? <p role="alert" className="text-sm font-bold text-berry-deep">{swap.error?.message ?? q.error?.message}</p> : null}
      </div>
    </Sheet>
  );
}
