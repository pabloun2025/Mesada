import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Badge, Empty, Loading } from './ui';
import { History } from 'lucide-react';
import { categoryInfo } from '../lib/screen';

const KIND: Record<string, string> = {
  task: 'Tarea', adjustment: 'Ajuste', bonus: 'Extra', redemption: 'Recompensa', refund: 'Devolución', conversion: 'Cierre',
  payment: 'Pago', transfer: 'Ahorro', exchange: 'Canje', advance: 'Adelanto', loan: 'Préstamo', loan_repayment: 'Cuota del préstamo',
  loan_interest: 'Interés del préstamo', interest: 'Interés', interest_forfeit: 'Interés perdido', goal_redeem: 'Meta',
};

export const LEDGER_KIND = KIND;

const SCREEN_KIND: Record<string, string> = { bonus: 'Bono', penalty: 'Penalización', spend: 'Gastados', adjustment: 'Ajuste', refund: 'Devolución', task: 'Tarea', usage: 'Anotado' };
const LOG_STATUS: Record<string, { label: string; tone: 'sun' | 'leaf' | 'muted' }> = {
  pending: { label: 'Por confirmar', tone: 'sun' }, confirmed: { label: 'Confirmado', tone: 'leaf' }, voided: { label: 'Anulado', tone: 'muted' },
};

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
            <p className="flex flex-wrap items-center gap-1.5 text-xs muted">
              {SCREEN_KIND[e.kind]}{e.category ? ` · ${categoryInfo(e.category)?.emoji} ${categoryInfo(e.category)?.label}` : ''} · {fmtDateTime(e.created_at)}{e.created_by_name ? ` · ${e.created_by_name}` : ''}
              {e.kind === 'usage' && e.log_status ? <Badge tone={LOG_STATUS[e.log_status].tone}>{LOG_STATUS[e.log_status].label}</Badge> : null}
              {e.kind === 'usage' && e.log_overflow > 0 ? <Badge tone="berry">Te pasaste {e.log_overflow} min</Badge> : null}
            </p>
          </div>
          <span className={`num font-extrabold ${e.delta > 0 ? 'text-leaf-text' : 'text-[var(--fg-2)]'}`}>{e.delta > 0 ? '+' : ''}{e.delta} min</span>
        </li>
      ))}
    </ul>
  );
}
