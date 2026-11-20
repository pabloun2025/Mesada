import path from 'node:path';

function bool(v: string | undefined, def: boolean) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/mesada',
  uploadDir: path.resolve(process.env.UPLOAD_DIR ?? './data/uploads'),
  /** Cookie Secure: activar detrás de HTTPS. */
  cookieSecure: bool(process.env.COOKIE_SECURE, false),
  sessionDays: Number(process.env.SESSION_DAYS ?? 30),
  /** Permite crear familias nuevas desde /setup aunque ya exista alguna. */
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, false),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 6) * 1024 * 1024,
  staticDir: process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : undefined,
  /** Intentos por minuto e IP en login/setup/cambio de contraseña. */
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT ?? 10),
  logLevel: process.env.LOG_LEVEL ?? 'info',
};
