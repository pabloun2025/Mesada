import type { Relationship, User } from './types';

/** Parentescos que se pueden elegir al invitar o crear la familia, en el orden de la lista. */
export const KINSHIPS: { value: Relationship; label: string; relative: boolean }[] = [
  { value: 'mother', label: 'Madre', relative: false },
  { value: 'father', label: 'Padre', relative: false },
  { value: 'partner', label: 'Pareja', relative: false },
  { value: 'guardian', label: 'Tutor/a legal', relative: false },
  { value: 'grandparent', label: 'Abuelo/a', relative: true },
  { value: 'aunt_uncle', label: 'Tío/a', relative: true },
  { value: 'other', label: 'Otro', relative: true },
];

/** «Madre», «Abuelo/a»… o el texto libre de «Otro». Vacío si no hay parentesco. */
export function kinshipText(u: Pick<User, 'relationship' | 'relationship_label'>): string {
  if (!u.relationship) return '';
  if (u.relationship === 'other' && u.relationship_label?.trim()) return u.relationship_label.trim();
  return KINSHIPS.find((k) => k.value === u.relationship)?.label ?? '';
}

export const isRelative = (u: Pick<User, 'role' | 'is_relative'>) => u.role === 'adult' && !!u.is_relative;
