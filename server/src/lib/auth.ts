import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { getPool, one, type Db } from './db.js';
import { forbidden, unauthorized } from './errors.js';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const got = await scrypt(pw, Buffer.from(saltB64, 'base64'), key.length, { ...SCRYPT, N: Number(n) });
  return crypto.timingSafeEqual(key, got);
}

// Hash ficticio para igualar tiempos cuando el usuario no existe.
let dummyHash: string | undefined;
export async function dummyVerify(pw: string) {
  dummyHash ??= await hashPassword('dummy-password');
  await verifyPassword(pw, dummyHash);
}

export const SESSION_COOKIE = 'mesada_session';

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, userId: string, userAgent?: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionDays * 86400000);
  await db.query('INSERT INTO sessions(user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4)', [
    userId,
    sha256(token),
    expires,
    userAgent?.slice(0, 300) ?? null,
  ]);
  return { token, expires };
}

export async function destroySession(db: Db, token: string) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
}

export function setSessionCookie(reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.cookieSecure,
    expires,
  });
}

export interface AuthUser {
  id: string;
  familyId: string;
  role: 'adult' | 'child';
  displayName: string;
  username: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export async function loadUser(req: FastifyRequest): Promise<AuthUser | undefined> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return undefined;
  const row = await one(
    getPool(),
    `SELECT u.id, u.family_id, u.role, u.display_name, u.username
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha256(token)],
  );
  if (!row) return undefined;
  return { id: row.id, familyId: row.family_id, role: row.role, displayName: row.display_name, username: row.username };
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw unauthorized();
  return req.user;
}

export function requireAdult(req: FastifyRequest): AuthUser {
  const u = requireUser(req);
  if (u.role !== 'adult') throw forbidden('Solo los adultos pueden hacer esto');
  return u;
}
