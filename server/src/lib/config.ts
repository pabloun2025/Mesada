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
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 5) * 1024 * 1024,
  staticDir: process.env.STATIC_DIR ? path.resolve(process.env.STATIC_DIR) : undefined,
  /** Intentos por minuto e IP en login/setup/cambio de contraseña. */
  authRateLimit: Number(process.env.AUTH_RATE_LIMIT ?? 10),
  /** URL pública, para los enlaces de correos y WhatsApp. */
  appBaseUrl: process.env.APP_BASE_URL ?? '',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  /** Detrás del túnel de Cloudflare la IP real llega en CF-Connecting-IP (que el cliente no puede falsear). */
  trustCloudflareIp: bool(process.env.TRUST_CLOUDFLARE_IP, true),
  /** Límites por IP y hora (D50). Un valor 0 desactiva ese límite. */
  limits: {
    setupPerHour: Number(process.env.RATE_SETUP_PER_HOUR ?? 5),
    invitePerHour: Number(process.env.RATE_INVITE_PER_HOUR ?? 20),
    inviteAcceptPerHour: Number(process.env.RATE_INVITE_ACCEPT_PER_HOUR ?? 20),
    recoveryPerHour: Number(process.env.RATE_RECOVERY_PER_HOUR ?? 6),
    resetPerHour: Number(process.env.RATE_RESET_PER_HOUR ?? 20),
    uploadPerHour: Number(process.env.RATE_UPLOAD_PER_HOUR ?? 60),
    exportPerHour: Number(process.env.RATE_EXPORT_PER_HOUR ?? 6),
  },
  /** Limpieza y conservación (D56-D57), en días. */
  retention: {
    photoDays: Number(process.env.PHOTO_RETENTION_DAYS ?? 7),
    notificationDays: Number(process.env.CLEAN_NOTIFICATIONS_DAYS ?? 90),
    outboxDays: Number(process.env.CLEAN_OUTBOX_DAYS ?? 90),
    inactiveFamilyMonths: Number(process.env.INACTIVE_FAMILY_MONTHS ?? 6),
  },
  /** Topes por familia (D50). */
  caps: {
    maxMembers: Number(process.env.MAX_MEMBERS_PER_FAMILY ?? 20),
    maxPendingInvitations: Number(process.env.MAX_PENDING_INVITATIONS ?? 10),
    maxPhotos: Number(process.env.MAX_PHOTOS_PER_FAMILY ?? 500),
  },
};
