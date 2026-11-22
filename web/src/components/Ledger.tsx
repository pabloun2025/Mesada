import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { Badge, Empty, Loading } from './ui';
import { History } from 'lucide-react';
import { categoryInfo } from '../lib/screen';
import type { ScreenEntry, ScreenPauseRow, ScreenView } from '../lib/types';

const KIND: Record<string, string> = {
  task: 'Tarea', adjustment: 'Ajuste', bonus: 'Extra', redemption: 'Recompensa', refund: 'Devolución', conversion: 'Cierre',
  payment: 'Pago', transfer: 'Ahorro', exchange: 'Canje', advance: 'Adelanto', loan: 'Préstamo', loan_repayment: 'Cuota del préstamo',
  loan_interest: 'Interés del préstamo', interest: 'Interés', interest_forfeit: 'Interés perdido', goal_redeem: 'Meta',
};

export const LEDGER_KIND = KIND;

// Todo lo que resta minutos por decisión de un adulto se llama «Ajuste de pantalla» y va en positivo: sin castigos ni multas.
const SCREEN_KIND: Record<string, string> = {
  bonus: 'Extra', penalty: 'Ajuste de pantalla', spend: 'Gastados', adjustment: 'Ajuste', refund: 'Devolución', task: 'Tarea', usage: 'Anotado',
  plan: 'Plan de la semana', expiry: 'Caducado',
};
const LOG_STATUS: Record<string, { label: string; tone: 'sun' | 'leaf' | 'muted' }> = {
  pending: { label: 'Por confirmar', tone: 'sun' }, confirmed: { label: 'Confirmado', tone: 'leaf' }, voided: { label: 'Anulado', tone: 'muted' },
};

/** Historial de minutos de pantalla: movimientos, ajustes con su motivo y pausas, del más reciente al más antiguo. */
export function ScreenList({ userId }: { userId: string }) {
  const { data, isLoading } = useQuery({ queryKey: ['screen', userId], queryFn: () => api<ScreenView>(`/screen/${userId}`) });
  if (isLoading) return <Loading />;
  type Row = { at: string; key: string; pause?: ScreenPauseRow; entry?: ScreenEntry };
  const rows: Row[] = [
    ...(data?.entries ?? []).map((entry) => ({ at: entry.created_at, key: entry.id, entry })),
    ...(data?.pauses ?? []).map((pause) => ({ at: pause.created_at, key: pause.id, pause })),
  ].sort((a, b) => (a.at < b.at ? 1 : -1));
  if (!rows.length) return <Empty icon={<History />} title="Sin movimientos de pantalla" />;
  return (
    <ul className="divide-y divide-[var(--line)]">
      {rows.map((r) => {
        if (r.pause) {
          const p = r.pause;
          const live = data?.pause?.id === p.id;
          return (
            <li key={r.key} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-bold">Pausa de pantalla · {p.reason_title}</p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs muted">
                  {p.pause_days} {p.pause_days === 1 ? 'día' : 'días'} · {fmtDateTime(p.created_at)}
                  {live ? <Badge tone="sun">En marcha</Badge> : p.status === 'recovered' ? <Badge tone="leaf">Recuperada</Badge> : p.status === 'ended' ? <Badge tone="muted">Terminada</Badge> : null}
                </p>
                {p.note ? <p className="mt-1 text-sm text-[var(--fg-2)]">«{p.note}»</p> : null}
                {live && p.recovery_title ? <p className="mt-1 text-sm text-[var(--fg-2)]">Puedes acortarla con «{p.recovery_title}».</p> : null}
              </div>
            </li>
          );
        }
        const e = r.entry!;
        return (
          <li key={r.key} className="flex items-center gap-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="font-bold">{e.is_adjustment ? `Ajuste de pantalla · ${e.reason}` : e.note || SCREEN_KIND[e.kind]}</p>
              <p className="flex flex-wrap items-center gap-1.5 text-xs muted">
                {SCREEN_KIND[e.kind]}{e.category ? ` · ${categoryInfo(e.category)?.emoji} ${categoryInfo(e.category)?.label}` : ''} · {fmtDateTime(e.created_at)}{e.created_by_name ? ` · ${e.created_by_name}` : ''}
                {e.kind === 'usage' && e.log_status ? <Badge tone={LOG_STATUS[e.log_status].tone}>{LOG_STATUS[e.log_status].label}</Badge> : null}
                {e.kind === 'usage' && (e.log_overflow ?? 0) > 0 ? <Badge tone="berry">Te pasaste {e.log_overflow} min</Badge> : null}
              </p>
              {e.adjustment_note ? <p className="mt-1 text-sm text-[var(--fg-2)]">«{e.adjustment_note}»</p> : null}
              {e.is_adjustment && e.recovery_title && e.adjustment_status === 'active' ? <p className="mt-1 text-sm text-[var(--fg-2)]">Los puedes recuperar con «{e.recovery_title}».</p> : null}
            </div>
            <span className={`num font-extrabold ${e.delta > 0 ? 'text-leaf-text' : 'text-[var(--fg-2)]'}`}>{e.delta > 0 ? '+' : ''}{e.delta} min</span>
          </li>
        );
      })}
    </ul>
  );
}
