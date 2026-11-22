import { z } from 'zod';
import { RELATIONSHIPS } from './kinship.js';

/** Teléfono móvil: 9 cifras = España; «00…» o «+…» = internacional. Siempre se guarda como +prefijo y número. */
export const phoneSchema = z
  .string()
  .trim()
  .transform((s) => s.replace(/[\s.-]/g, ''))
  .transform((s) => (/^\d{9}$/.test(s) ? `+34${s}` : s.startsWith('00') ? `+${s.slice(2)}` : s))
  .refine((s) => /^\+[1-9]\d{7,14}$/.test(s), 'teléfono no válido (usa formato +34600000000)');

export const relationshipSchema = z.enum(RELATIONSHIPS);
/** Texto libre de «Otro» (p. ej. «Vecina»). */
export const relationshipLabelSchema = z.string().trim().max(40);
