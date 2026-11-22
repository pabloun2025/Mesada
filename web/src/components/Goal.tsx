import { Target } from 'lucide-react';
import { euros } from '../lib/format';

interface Visual { id: string; title: string; emoji: string | null; has_photo: boolean }

/** Foto de la meta, o su emoji, o un icono: lo primero que se ve de ella. */
export function GoalVisual({ goal, size = 56 }: { goal: Visual; size?: number }) {
  const box = { width: size, height: size };
  if (goal.has_photo) {
    return <img src={`/api/goals/${goal.id}/photo`} alt={`Foto de la meta ${goal.title}`} width={size} height={size} loading="lazy" style={box} className="shrink-0 rounded-2xl object-cover" />;
  }
  return (
    <span aria-hidden style={{ ...box, fontSize: size * 0.55 }} className="flex shrink-0 items-center justify-center rounded-2xl bg-leaf-soft text-leaf-deep dark:bg-leaf/20 dark:text-[#7fe0b2]">
      {goal.emoji ? <span>{goal.emoji}</span> : <Target size={size * 0.5} />}
    </span>
  );
}

export const goalPct = (g: { balance_cents: number; target_cents: number }) => (g.target_cents > 0 ? Math.min(100, Math.floor((g.balance_cents / g.target_cents) * 100)) : 0);

/** «Te faltan 3 semanas» (a quien ahorra) o «Le faltan 3 semanas» (a quien mira). Sin datos, nada. */
export function weeksLeftText(g: { weeks_left: number | null; reached?: boolean }, own: boolean): string | null {
  if (g.reached) return '¡Meta alcanzada!';
  if (!g.weeks_left) return null;
  const n = g.weeks_left;
  const verb = own ? (n === 1 ? 'Te falta' : 'Te faltan') : n === 1 ? 'Le falta' : 'Le faltan';
  return `${verb} ${n} ${n === 1 ? 'semana' : 'semanas'}`;
}

export function GoalBar({ goal, label }: { goal: { balance_cents: number; target_cents: number }; label: string }) {
  const p = goalPct(goal);
  return (
    <>
      <div className="h-3 overflow-hidden rounded-full bg-[var(--chip)]" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <i className="block h-full rounded-full bg-gradient-to-r from-leaf to-[#38c28a] transition-[width] duration-700" style={{ width: `${p}%` }} />
      </div>
      <p className="num mt-1 flex justify-between text-sm text-[var(--fg-2)]"><span>{euros(goal.balance_cents)} de {euros(goal.target_cents)}</span><span>{p} %</span></p>
    </>
  );
}
