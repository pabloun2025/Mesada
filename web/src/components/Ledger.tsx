import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { euros, fmtDateTime } from '../lib/format';
import { Empty, Loading, Segmented } from './ui';
import { History } from 'lucide-react';

const KIND: Record<string, string> = {
  task: 'Tarea', adjustment: 'Ajuste', bonus: 'Extra', redemption: 'Recompensa', refund: 'Devolución', conversion: 'Cierre',
  payment: 'Pago', transfer: 'Hucha',
};

export function LedgerList({ userId }: { userId: string }) {
  const [type, setType] = useState<'points' | 'money'>('points');
  const { data, isLoading } = useQuery({ queryKey: ['ledger', userId, type], queryFn: () => api(`/ledger/${userId}?type=${type}`) });
  return (
    <div>
      <Segmented label="Tipo de movimiento" value={type} onChange={setType} options={[{ value: 'points', label: 'Puntos' }, { value: 'money', label: 'Euros' }]} />
      {isLoading ? <Loading /> : data?.entries.length ? (
        <ul className="mt-3 divide-y divide-[var(--line)]">
          {data.entries.map((e: any) => {
            const v = type === 'points' ? e.delta : e.delta_cents;
            return (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold">{e.note || KIND[e.kind]}</p>
                  <p className="text-xs muted">
                    {KIND[e.kind]}{type === 'money' && e.account === 'savings' ? ' · hucha' : ''} · {fmtDateTime(e.created_at)}{e.created_by_name ? ` · ${e.created_by_name}` : ''}
                  </p>
                </div>
                <span className={`num font-extrabold ${v > 0 ? 'text-leaf' : 'text-[var(--fg-2)]'}`}>
                  {v > 0 ? '+' : ''}{type === 'points' ? `${v} pts` : euros(v)}
                </span>
              </li>
            );
          })}
        </ul>
      ) : <Empty icon={<History />} title="Sin movimientos" />}
    </div>
  );
}

const SCREEN_KIND: Record<string, string> = { bonus: 'Bono', penalty: 'Penalización', spend: 'Gastados', adjustment: 'Ajuste', refund: 'Devolución', task: 'Tarea' };

/** Historial de minutos de pantalla. */
export function ScreenList({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['screen', userId], queryFn: () => api<{ balance: number; entries: any[] }>(`/screen/${userId}`) });
  if (isLoading) return <Loading />;
  if (!data?.entries.length) return <Empty icon={<History />} title="Sin movimientos de pantalla" />;
  return (
    <ul className="divide-y divide-[var(--line)]">
      {data.entries.map((e) => (
        <li key={e.id} className="flex items-center gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <p className="truncate font-bold">{e.note || SCREEN_KIND[e.kind]}</p>
            <p className="text-xs muted">{SCREEN_KIND[e.kind]} · {fmtDateTime(e.created_at)}{e.created_by_name ? ` · ${e.created_by_name}` : ''}</p>
          </div>
          <span className={`num font-extrabold ${e.delta > 0 ? 'text-leaf' : 'text-[var(--fg-2)]'}`}>{e.delta > 0 ? '+' : ''}{e.delta} min</span>
        </li>
      ))}
    </ul>
  );
}
