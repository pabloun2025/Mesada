import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { config } from './config.js';
import { badRequest } from './errors.js';

/** Lado largo máximo de una foto de evidencia. */
export const PHOTO_MAX_SIDE = 1280;

/** Primeros bytes: JPEG (FF D8 FF), PNG (89 'PNG') o WebP ('RIFF'....'WEBP'). */
export function looksLikeImage(b: Buffer, mime: string) {
  if (b.length < 12) return false;
  if (mime === 'image/jpeg') return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  if (mime === 'image/png') return b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP';
}

/**
 * Reduce a 1280 px como máximo en el lado largo y recodifica (JPEG si venía en JPEG, si no WebP), calidad buena.
 * Se aplica la orientación EXIF y se descartan TODOS los metadatos (EXIF, GPS, miniatura, perfil): `sharp` no los conserva
 * salvo que se pida. Un archivo que no se puede decodificar como imagen se rechaza.
 */
export async function processPhoto(input: Buffer, mime: string): Promise<{ data: Buffer; ext: 'jpg' | 'webp' }> {
  try {
    const img = sharp(input, { failOn: 'error', limitInputPixels: 80_000_000 }).rotate().resize({ width: PHOTO_MAX_SIDE, height: PHOTO_MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    if (mime === 'image/jpeg') return { data: await img.jpeg({ quality: 82, mozjpeg: true }).toBuffer(), ext: 'jpg' };
    return { data: await img.webp({ quality: 82 }).toBuffer(), ext: 'webp' };
  } catch {
    throw badRequest('El archivo no es una foto válida');
  }
}

/** Guarda la foto ya procesada en la carpeta privada de la familia y devuelve su ruta relativa. */
export async function storePhoto(familyId: string, data: Buffer, ext: string): Promise<string> {
  const rel = path.join(familyId, `${crypto.randomUUID()}.${ext}`);
  const abs = path.join(config.uploadDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await fs.promises.writeFile(abs, data, { mode: 0o600 });
  return rel;
}

export function removePhotoFile(rel: string | null | undefined) {
  if (!rel) return;
  const root = path.resolve(config.uploadDir);
  const abs = path.resolve(root, rel);
  if (abs.startsWith(root + path.sep)) fs.rmSync(abs, { force: true });
}
