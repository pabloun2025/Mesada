import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getPool, one, tx } from '../lib/db.js';
import { hashPassword, requireAdult, verifyPassword, type AuthUser } from '../lib/auth.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { generateSecret, hashCode, otpauthUri, recoveryCodes, seal, unseal, verifyTotp } from '../lib/totp.js';
import { getSetting, setSetting } from '../lib/settings.js';
import { channelStatus } from '../lib/notify/providers.js';
import { usage } from '../lib/notify/worker.js';
import { lineStatus } from '../lib/notify/whatsapp-line.js';

/**
 * Administración de la instalación. Reglas:
 * - Solo usuarios con is_superadmin, con verificación en dos pasos activada y verificada en esta sesión (12 h).
 * - Nunca devuelve puntos, dinero, tareas ni fotos de las familias: solo cuentas y estado técnico.
 * - Toda acción queda en admin_audit.
 */

const VERIFY_HOURS = 12;
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
const fails = new Map<string, { n: number; until: number; first: number }>();

function checkLock(userId: string) {
  const f = fails.get(userId);
  if (f && f.until > Date.now()) throw new HttpError(429, 'Demasiados códigos incorrectos. Espera 15 minutos.', 'locked');
}
function registerFail(userId: string) {
  const now = Date.now();
  const f = fails.get(userId);
  if (!f || now - f.first > LOCK_MS) return void fails.set(userId, { n: 1, until: 0, first: now });
  f.n++;
  if (f.n >= MAX_FAILS) f.until = now + LOCK_MS;
}
export function resetAdminFailures() {
  fails.clear();
}

function requireEligible(req: FastifyRequest): AuthUser {
  const u = requireAdult(req);
  if (!u.isSuperadmin) throw forbidden('Solo quien administra la instalación puede entrar aquí');
  return u;
}

function isVerified(u: AuthUser) {
  return !!u.adminVerifiedAt && Date.now() - new Date(u.adminVerifiedAt).getTime() < VERIFY_HOURS * 3600_000;
}

function requireSuper(req: FastifyRequest): AuthUser {
  const u = requireEligible(req);
  if (!isVerified(u)) throw new HttpError(403, 'Confirma con el código de tu aplicación de autenticación', 'admin_verify_required');
  return u;
}

async function log(req: FastifyRequest, actor: AuthUser, action: string, target: { familyId?: string | null; userId?: string | null } = {}, data: Record<string, unknown> = {}) {
  await getPool().query('INSERT INTO admin_audit(actor_id, action, family_id, user_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6)', [
    actor.id, action, target.familyId ?? null, target.userId ?? null, JSON.stringify(data), req.ip ?? null,
  ]);
}

/** «pablo@gmail.com» → «p•••o@gmail.com»: suficiente para reconocerlo sin exponerlo entero. */
export function maskEmail(e: string | null) {
  if (!e) return null;
  const [local, domain] = e.split('@');
  if (!domain) return '•••';
  const shown = local.length <= 2 ? local[0] : `${local[0]}•••${local[local.length - 1]}`;
  return `${shown}@${domain}`;
}

/** Contraseña temporal legible (sin 0/O, 1/l) o PIN de 6 cifras para los hijos. */
function tempSecret(role: string) {
  if (role === 'child') return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(12);
  const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('');
  return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`;
}

function lastBackup() {
  const dir = process.env.BACKUP_DIR;
  if (!dir) return null;
  try {
    const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.')).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtime }));
    if (!files.length) return { count: 0, last: null as string | null };
    files.sort((a, b) => b.t.getTime() - a.t.getTime());
    return { count: files.length, last: files[0].t.toISOString() };
  } catch {
    return null;
  }
}

const started = Date.now();

export default async function adminRoutes(app: FastifyInstance) {
  /* ---------- Acceso y verificación en dos pasos ---------- */

  app.get('/api/admin/status', async (req) => {
    const u = requireAdult(req);
    if (!u.isSuperadmin) return { eligible: false, totpEnabled: false, verified: false };
    const r = await one<{ totp_enabled_at: string | null }>(getPool(), 'SELECT totp_enabled_at FROM users WHERE id = $1', [u.id]);
    return { eligible: true, totpEnabled: !!r?.totp_enabled_at, verified: !!r?.totp_enabled_at && isVerified(u) };
  });

  app.post('/api/admin/2fa/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireEligible(req);
    const b = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    const row = await one(getPool(), 'SELECT password_hash, totp_enabled_at FROM users WHERE id = $1', [u.id]);
    if (row.totp_enabled_at) throw badRequest('La verificación en dos pasos ya está activada');
    if (!(await verifyPassword(b.password, row.password_hash))) throw badRequest('La contraseña no es correcta');
    const secret = generateSecret();
    await getPool().query('UPDATE users SET totp_pending = $2 WHERE id = $1', [u.id, seal(secret)]);
    return { secret, uri: otpauthUri(secret, u.username) };
  });

  app.post('/api/admin/2fa/enable', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireEligible(req);
    checkLock(u.id);
    const b = z.object({ code: z.string().max(20) }).parse(req.body);
    const row = await one(getPool(), 'SELECT totp_pending, totp_enabled_at FROM users WHERE id = $1', [u.id]);
    if (row.totp_enabled_at) throw badRequest('La verificación en dos pasos ya está activada');
    if (!row.totp_pending) throw badRequest('Empieza de nuevo: escribe tu contraseña');
    const secret = unseal(row.totp_pending);
    const counter = verifyTotp(secret, b.code);
    if (counter === null) {
      registerFail(u.id);
      throw badRequest('El código no es correcto. Mira la hora del móvil y prueba con el código nuevo.');
    }
    const codes = recoveryCodes();
    await tx(async (db) => {
      await db.query(
        'UPDATE users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = now(), totp_last_counter = $2 WHERE id = $1',
        [u.id, counter],
      );
      await db.query('DELETE FROM admin_recovery_codes WHERE user_id = $1', [u.id]);
      for (const c of codes) await db.query('INSERT INTO admin_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [u.id, hashCode(c)]);
      await db.query('UPDATE sessions SET admin_verified_at = now() WHERE id = $1', [u.sessionId]);
    });
    fails.delete(u.id);
    await log(req, u, 'admin.2fa_enabled');
    return { recoveryCodes: codes };
  });

  app.post('/api/admin/verify', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireEligible(req);
    checkLock(u.id);
    const b = z.object({ code: z.string().trim().min(6).max(20) }).parse(req.body);
    const row = await one(getPool(), 'SELECT totp_secret, totp_last_counter FROM users WHERE id = $1', [u.id]);
    if (!row.totp_secret) throw badRequest('Activa primero la verificación en dos pasos');
    let ok = false;
    let how = 'totp';
    const counter = verifyTotp(unseal(row.totp_secret), b.code);
    if (counter !== null) {
      // Un mismo código no sirve dos veces (evita reutilizar uno visto por encima del hombro).
      const used = await getPool().query(
        'UPDATE users SET totp_last_counter = $2 WHERE id = $1 AND (totp_last_counter IS NULL OR totp_last_counter < $2)',
        [u.id, counter],
      );
      ok = used.rowCount === 1;
    } else if (/[A-Za-z]/.test(b.code)) {
      const r = await getPool().query(
        'UPDATE admin_recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
        [u.id, hashCode(b.code)],
      );
      ok = r.rowCount === 1;
      how = 'recuperacion';
    }
    if (!ok) {
      registerFail(u.id);
      await log(req, u, 'admin.verify_failed');
      throw badRequest('El código no es correcto');
    }
    fails.delete(u.id);
    await getPool().query('UPDATE sessions SET admin_verified_at = now() WHERE id = $1', [u.sessionId]);
    await log(req, u, 'admin.verified', {}, { how });
    const left = await one<{ n: number }>(getPool(), 'SELECT count(*)::int AS n FROM admin_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [u.id]);
    return { ok: true, recoveryCodesLeft: left?.n ?? 0 };
  });

  app.post('/api/admin/lock', async (req) => {
    const u = requireEligible(req);
    await getPool().query('UPDATE sessions SET admin_verified_at = NULL WHERE id = $1', [u.sessionId]);
    return { ok: true };
  });

  app.post('/api/admin/2fa/recovery-codes', async (req) => {
    const u = requireSuper(req);
    const codes = recoveryCodes();
    await tx(async (db) => {
      await db.query('DELETE FROM admin_recovery_codes WHERE user_id = $1', [u.id]);
      for (const c of codes) await db.query('INSERT INTO admin_recovery_codes(user_id, code_hash) VALUES ($1,$2)', [u.id, hashCode(c)]);
    });
    await log(req, u, 'admin.recovery_codes_regenerated');
    return { recoveryCodes: codes };
  });

  /* ---------- Resumen ---------- */

  app.get('/api/admin/overview', async (req) => {
    requireSuper(req);
    const db = getPool();
    const counts = await one(
      db,
      `SELECT (SELECT count(*)::int FROM families) AS families,
              (SELECT count(*)::int FROM families WHERE blocked_at IS NOT NULL) AS blocked,
              (SELECT count(*)::int FROM users WHERE role = 'adult') AS adults,
              (SELECT count(*)::int FROM users WHERE role = 'child') AS children,
              (SELECT count(DISTINCT user_id)::int FROM sessions WHERE created_at > now() - interval '7 days') AS active7,
              (SELECT count(*)::int FROM users WHERE role = 'adult' AND (email IS NULL OR email = '')) AS adults_without_email`,
    );
    const outbox = await one(
      db,
      `SELECT count(*) FILTER (WHERE status = 'pending')::int AS pending,
              count(*) FILTER (WHERE status = 'sent' AND sent_at > now() - interval '24 hours')::int AS sent24,
              count(*) FILTER (WHERE status IN ('failed','uncertain') AND created_at > now() - interval '24 hours')::int AS failed24
         FROM notification_outbox`,
    );
    const size = await one<{ bytes: string }>(db, 'SELECT pg_database_size(current_database())::text AS bytes');
    return {
      counts,
      notify: {
        paused: await getSetting('notify_paused'),
        channels: channelStatus(),
        usage: await usage(),
        outbox,
        whatsappLine: await lineStatus(),
      },
      settings: { registrationOpen: await getSetting('registration_open') },
      health: {
        uptimeSeconds: Math.round((Date.now() - started) / 1000),
        dbBytes: Number(size?.bytes ?? 0),
        backups: lastBackup(),
        node: process.version,
      },
    };
  });

  /* ---------- Familias y cuentas ---------- */

  app.get('/api/admin/families', async (req) => {
    requireSuper(req);
    const r = await getPool().query(
      `SELECT f.id, f.name, f.created_at, f.blocked_at, f.blocked_reason,
              count(u.id) FILTER (WHERE u.role = 'adult')::int AS adults,
              count(u.id) FILTER (WHERE u.role = 'child')::int AS children,
              max(u.last_login_at) AS last_login_at,
              (f.id = (SELECT id FROM families ORDER BY created_at LIMIT 1)) AS is_admin_family
         FROM families f LEFT JOIN users u ON u.family_id = f.id
        GROUP BY f.id ORDER BY f.created_at`,
    );
    return { families: r.rows };
  });

  app.get('/api/admin/families/:id', async (req) => {
    requireSuper(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const fam = await one(getPool(), 'SELECT id, name, created_at, blocked_at, blocked_reason FROM families WHERE id = $1', [id]);
    if (!fam) throw notFound('Esa familia no existe');
    const members = await getPool().query(
      `SELECT u.id, u.display_name, u.username, u.role, u.active, u.email, u.last_login_at, u.created_at, u.is_superadmin,
              (u.totp_enabled_at IS NOT NULL) AS two_factor,
              (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.expires_at > now()) AS sessions
         FROM users u WHERE u.family_id = $1 ORDER BY u.role, u.created_at`,
      [id],
    );
    return {
      family: fam,
      members: members.rows.map(({ email, ...m }) => ({ ...m, email: maskEmail(email) })),
    };
  });

  app.post('/api/admin/families/:id/block', async (req) => {
    const u = requireSuper(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ blocked: z.boolean(), reason: z.string().trim().max(200).optional() }).parse(req.body);
    if (id === u.familyId && b.blocked) throw badRequest('No puedes bloquear tu propia familia');
    const r = await tx(async (db) => {
      const up = await db.query(
        'UPDATE families SET blocked_at = CASE WHEN $2 THEN now() ELSE NULL END, blocked_reason = CASE WHEN $2 THEN $3 ELSE NULL END WHERE id = $1 RETURNING name',
        [id, b.blocked, b.reason ?? null],
      );
      if (!up.rowCount) throw notFound('Esa familia no existe');
      if (b.blocked) await db.query('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE family_id = $1)', [id]);
      return up.rows[0];
    });
    await log(req, u, b.blocked ? 'family.block' : 'family.unblock', { familyId: id }, { name: r.name, reason: b.reason ?? null });
    return { ok: true };
  });

  async function targetUser(id: string) {
    const t = await one(getPool(), 'SELECT id, family_id, role, username FROM users WHERE id = $1', [id]);
    if (!t) throw notFound('Esa cuenta no existe');
    return t;
  }

  app.post('/api/admin/users/:id/active', async (req) => {
    const u = requireSuper(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    if (id === u.id) throw badRequest('No puedes desactivar tu propia cuenta');
    const t = await targetUser(id);
    await tx(async (db) => {
      await db.query('UPDATE users SET active = $2 WHERE id = $1', [id, b.active]);
      if (!b.active) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    });
    await log(req, u, b.active ? 'user.activate' : 'user.deactivate', { familyId: t.family_id, userId: id }, { username: t.username });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/temp-password', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const u = requireSuper(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    if (id === u.id) throw badRequest('Para tu cuenta usa «Mi perfil»');
    const t = await targetUser(id);
    const secret = tempSecret(t.role);
    await tx(async (db) => {
      await db.query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, await hashPassword(secret)]);
      await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    });
    await log(req, u, 'user.temp_password', { familyId: t.family_id, userId: id }, { username: t.username });
    // Se muestra una sola vez; no se guarda en claro en ningún sitio.
    return { secret, kind: t.role === 'child' ? 'pin' : 'password' };
  });

  app.post('/api/admin/users/:id/logout', async (req) => {
    const u = requireSuper(req);
    const { id } = z.object({ id: z.uuid() }).parse(req.params);
    const t = await targetUser(id);
    const r = await getPool().query('DELETE FROM sessions WHERE user_id = $1 AND id <> $2', [id, u.sessionId ?? '00000000-0000-0000-0000-000000000000']);
    await log(req, u, 'user.logout_all', { familyId: t.family_id, userId: id }, { username: t.username, sessions: r.rowCount });
    return { ok: true, closed: r.rowCount };
  });

  /* ---------- Ajustes y registro ---------- */

  app.put('/api/admin/settings', async (req) => {
    const u = requireSuper(req);
    const b = z.object({ registrationOpen: z.boolean().optional(), notifyPaused: z.boolean().optional() }).parse(req.body);
    if (b.registrationOpen !== undefined) {
      await setSetting('registration_open', b.registrationOpen, u.id);
      await log(req, u, 'settings.registration', {}, { open: b.registrationOpen });
    }
    if (b.notifyPaused !== undefined) {
      await setSetting('notify_paused', b.notifyPaused, u.id);
      await log(req, u, 'settings.notify', { }, { paused: b.notifyPaused });
    }
    return { registrationOpen: await getSetting('registration_open'), notifyPaused: await getSetting('notify_paused') };
  });

  app.get('/api/admin/audit', async (req) => {
    requireSuper(req);
    const r = await getPool().query(
      `SELECT a.id, a.action, a.created_at, a.data, a.ip, act.display_name AS actor, f.name AS family, tu.username AS target
         FROM admin_audit a
         LEFT JOIN users act ON act.id = a.actor_id
         LEFT JOIN families f ON f.id = a.family_id
         LEFT JOIN users tu ON tu.id = a.user_id
        ORDER BY a.created_at DESC LIMIT 100`,
    );
    return { entries: r.rows };
  });
}
