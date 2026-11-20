import { euros } from '../lib/format';

/**
 * Anillo de la semana: una "moneda" con canto estriado que se llena con los puntos frente al objetivo.
 */
export function WeekRing({ points, goal, cents, size = 196, label = 'esta semana' }: { points: number; goal: number; cents: number; size?: number; label?: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const pct = goal > 0 ? Math.min(1, Math.max(0, points / goal)) : points > 0 ? 1 : 0;
  const done = goal > 0 && points >= goal;
  const ticks = Array.from({ length: 60 }, (_, i) => i);
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90" aria-hidden>
        {ticks.map((i) => {
          const a = (i / 60) * 2 * Math.PI;
          const on = i / 60 < pct;
          return (
            <line
              key={i}
              x1={50 + 47.5 * Math.cos(a)} y1={50 + 47.5 * Math.sin(a)}
              x2={50 + 49.5 * Math.cos(a)} y2={50 + 49.5 * Math.sin(a)}
              stroke={on ? (done ? '#1E9E6A' : '#F26B1D') : 'var(--line)'}
              strokeWidth="0.9" strokeLinecap="round"
            />
          );
        })}
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--chip)" strokeWidth="8" />
        <circle
          cx="50" cy="50" r={r} fill="none"
          stroke={done ? '#1E9E6A' : '#F26B1D'} strokeWidth="8" strokeLinecap="round"
          strokeDasharray={`${c * pct} ${c}`}
          style={{ transition: 'stroke-dasharray 0.8s cubic-bezier(.2,.9,.3,1)' }}
        />
      </svg>
      <div className="relative flex flex-col items-center text-center">
        <span className="num font-extrabold leading-none" style={{ fontSize: size * 0.24 }}>{points}</span>
        <span className="mt-0.5 text-sm muted">{goal > 0 ? `de ${goal} pts` : 'puntos'}</span>
        <span className="num mt-1.5 rounded-full bg-leaf-soft px-2.5 py-0.5 text-sm font-bold text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]">≈ {euros(cents)}</span>
        <span className="sr-only">{label}</span>
      </div>
    </div>
  );
}

export function Bar({ value, max, tone = 'tangerine' }: { value: number; max: number; tone?: 'tangerine' | 'leaf' | 'sky' }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  const colors = { tangerine: '#F26B1D', leaf: '#1E9E6A', sky: '#4F8DF7' };
  return (
    <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--chip)]" role="progressbar" aria-valuenow={value} aria-valuemax={max}>
      <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: colors[tone] }} />
    </div>
  );
}
