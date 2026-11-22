import { Gift } from 'lucide-react';
import type { Bonus } from '../lib/types';
import { Badge } from './ui';

/** Chip del bono de una tarea: etiqueta visible o «Sorpresa» (el contenido no viaja al hijo). */
export function BonusChip({ bonus }: { bonus: Bonus | null }) {
  if (!bonus) return null;
  const note = bonus.onTimeOnly ? ' · a tiempo' : '';
  if (bonus.surprise) {
    return <Badge tone="sun"><Gift size={12} aria-hidden /> Sorpresa{note}{bonus.label ? ` (${bonus.label})` : ''}</Badge>;
  }
  return <Badge tone="leaf"><Gift size={12} aria-hidden /> {bonus.label}{note}</Badge>;
}
