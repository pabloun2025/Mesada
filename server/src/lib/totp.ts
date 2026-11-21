import crypto from 'node:crypto';

/** TOTP (RFC 6238, SHA-1, 6 cifras, 30 s): compatible con Google Authenticator, Microsoft Authenticator, 1Password, etc. */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string) {
  const clean = s.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('base32 no válido');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

export function hotp(secret: string, counter: number) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = h[h.length - 1] & 15;
  const code = ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString();
  return code.padStart(6, '0');
}

export const counterAt = (ms: number) => Math.floor(ms / 1000 / 30);

export function totp(secret: string, ms = Date.now()) {
  return hotp(secret, counterAt(ms));
}

/** Devuelve el contador que coincide (±1 paso de tolerancia por desfase de reloj) o null. */
export function verifyTotp(secret: string, code: string, ms = Date.now()): number | null {
  const c = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const now = counterAt(ms);
  for (const k of [now, now - 1, now + 1]) {
    const expected = hotp(secret, k);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return k;
  }
  return null;
}

export function otpauthUri(secret: string, account: string, issuer = 'DiploP') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/* ---------- Cifrado del secreto en la base de datos ---------- */

function key() {
  const k = process.env.SECRET_KEY;
  if (!k) {
    if (process.env.NODE_ENV === 'production') throw new Error('Falta SECRET_KEY en el servidor');
    return crypto.createHash('sha256').update('mesada-solo-desarrollo').digest();
  }
  return crypto.createHash('sha256').update(k).digest();
}

export function seal(plain: string) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function unseal(sealed: string) {
  const [v, iv, tag, enc] = sealed.split('.');
  if (v !== 'v1') throw new Error('formato no válido');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8');
}

/* ---------- Códigos de recuperación ---------- */

export function recoveryCodes(n = 10) {
  // 10 caracteres sin letras confusas, en dos bloques: «K7QX-M2PA9».
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(9);
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4, 9)}`;
  });
}

export const hashCode = (code: string) => crypto.createHash('sha256').update(code.replace(/[\s-]/g, '').toUpperCase()).digest('hex');
