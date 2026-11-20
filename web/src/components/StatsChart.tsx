import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { fmtDate } from '../lib/format';
import { color, Segmented, Spinner } from './ui';

interface Row { user_id: string; display_name: string; color: string; bucket: string; points: number; tasks: number }

/** Barras agrupadas por semana/mes y por hijo. SVG propio, sin librerías. */
export function StatsChart({ userId }: { userId?: string }) {
  const [range, setRange] = useState<'weeks' | 'months'>('weeks');
  const { data, isLoading } = useQuery({
    queryKey: ['stats', range, userId ?? 'all'],
    queryFn: () => api<{ rows: Row[] }>(`/stats?range=${range}${userId ? `&userId=${userId}` : ''}`),
  });
  const rows = data?.rows ?? [];
  const buckets = [...new Set(rows.map((r) => r.bucket))];
  const kids = [...new Map(rows.map((r) => [r.user_id, r])).values()];
  const max = Math.max(10, ...rows.map((r) => r.points));
  const W = 640, H = 220, padL = 34, padB = 26, padT = 10;
  const gw = (W - padL) / Math.max(1, buckets.length);
  const bw = Math.min(26, (gw - 10) / Math.max(1, kids.length));
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Periodo" value={range} onChange={setRange} options={[{ value: 'weeks', label: 'Semanas' }, { value: 'months', label: 'Meses' }]} />
        {kids.length > 1 ? (
          <ul className="flex gap-3 text-sm">
            {kids.map((k) => (
              <li key={k.user_id} className="flex items-center gap-1.5"><span className="size-3 rounded-sm" style={{ background: color(k.color).bg }} aria-hidden />{k.display_name}</li>
            ))}
          </ul>
        ) : null}
      </div>
      {isLoading ? <div className="flex h-56 items-center justify-center"><Spinner /></div> : (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Puntos por ${range === 'weeks' ? 'semana' : 'mes'}`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeDasharray={t ? '3 4' : undefined} />
              <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--fg-3)">{t}</text>
            </g>
          ))}
          {buckets.map((b, bi) => {
            const x0 = padL + bi * gw + (gw - bw * kids.length) / 2;
            return (
              <g key={b}>
                {kids.map((k, ki) => {
                  const r = rows.find((x) => x.bucket === b && x.user_id === k.user_id);
                  const v = Math.max(0, r?.points ?? 0);
                  return (
                    <rect key={k.user_id} x={x0 + ki * bw + 1} width={bw - 2} y={y(v)} height={Math.max(0, H - padB - y(v))} rx="4" fill={color(k.color).bg}>
                      <title>{`${k.display_name}: ${v} pts, ${r?.tasks ?? 0} tareas`}</title>
                    </rect>
                  );
                })}
                <text x={padL + bi * gw + gw / 2} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--fg-3)">
                  {range === 'weeks' ? fmtDate(b) : fmtDate(b, { month: 'short' })}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
