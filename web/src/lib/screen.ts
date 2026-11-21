import type { PayMethod, ScreenCategory } from './types';

export const SCREEN_CATEGORIES: { value: ScreenCategory; label: string; emoji: string; phrase: string }[] = [
  { value: 'videojuegos', label: 'Videojuegos', emoji: '🎮', phrase: 'de videojuegos' },
  { value: 'tele', label: 'Tele', emoji: '📺', phrase: 'de tele' },
  { value: 'tablet', label: 'Tablet', emoji: '📱', phrase: 'de tablet' },
  { value: 'movil', label: 'Móvil', emoji: '🤳', phrase: 'de móvil' },
  { value: 'ordenador', label: 'Ordenador', emoji: '💻', phrase: 'de ordenador' },
  { value: 'otro', label: 'Otro', emoji: '✨', phrase: 'de pantalla' },
];

export const categoryInfo = (c?: string | null) => SCREEN_CATEGORIES.find((x) => x.value === c);
/** «30 min de videojuegos» */
export const screenPhrase = (minutes: number, c?: string | null) => `${minutes} min ${categoryInfo(c)?.phrase ?? 'de pantalla'}`;

export const PAY_METHODS: { value: PayMethod; label: string }[] = [
  { value: 'cash', label: 'Efectivo' },
  { value: 'transfer', label: 'Transferencia' },
  { value: 'bizum', label: 'Bizum' },
  { value: 'other', label: 'Otro' },
];
