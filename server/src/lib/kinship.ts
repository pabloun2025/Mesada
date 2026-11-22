/** Parentesco de los adultos (I20). Los tres últimos son «parientes»: ven y animan, pero no gestionan nada. */
export const RELATIONSHIPS = ['mother', 'father', 'partner', 'guardian', 'grandparent', 'aunt_uncle', 'other'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const RELATIVE_KINDS: readonly Relationship[] = ['grandparent', 'aunt_uncle', 'other'];
export const isRelativeKind = (r: string | null | undefined) => !!r && (RELATIVE_KINDS as readonly string[]).includes(r);

const TEXT: Record<Relationship, string> = {
  mother: 'Madre', father: 'Padre', partner: 'Pareja', guardian: 'Tutor/a legal', grandparent: 'Abuelo/a', aunt_uncle: 'Tío/a', other: 'Otro',
};

/** «Madre», «Abuelo/a»… o, en «Otro», el texto libre («Vecina»). Vacío si no hay parentesco. */
export function kinshipText(rel: string | null | undefined, label?: string | null): string {
  if (!rel) return '';
  if (rel === 'other' && label?.trim()) return label.trim();
  return TEXT[rel as Relationship] ?? '';
}

/** «Ana (Madre)»: cómo se nombra a un adulto en los avisos. */
export const whoText = (name: string, rel?: string | null, label?: string | null) => {
  const k = kinshipText(rel, label);
  return k ? `${name} (${k})` : name;
};
