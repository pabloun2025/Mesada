import { forbidden } from './errors.js';

/**
 * Qué puede hacer un pariente (abuelo/a, tío/a, otro): ver el progreso de los niños, felicitar y dar aportes a una meta.
 * Cualquier otra ruta de la API responde 403 aunque la pantalla no enseñe el botón (D60). Es una lista cerrada:
 * una ruta nueva queda prohibida para los parientes hasta que alguien la añada aquí a propósito.
 * La clave es «MÉTODO plantilla-de-la-ruta».
 */
export const RELATIVE_ALLOWED = new Set<string>([
  'GET /api/me',
  'PATCH /api/me',
  'PUT /api/me/email',
  'POST /api/me/password',
  'POST /api/auth/logout',
  'GET /api/family',
  'GET /api/progress/:userId',
  'GET /api/goals/:userId',
  'GET /api/goals/:id/photo',
  'GET /api/notifications',
  'POST /api/notifications/read',
  'GET /api/relative/overview',
  'POST /api/cheers',
  'POST /api/goals/:id/gift',
]);

/** Rutas que no dependen de la sesión: se pueden llamar con la cookie de un pariente puesta. */
export const PUBLIC_ROUTES = new Set<string>([
  'GET /api/health',
  'GET /api/setup/status',
  'POST /api/setup',
  'POST /api/auth/login',
  'POST /api/auth/forgot',
  'POST /api/auth/reset',
  'POST /api/invitations/lookup',
  'POST /api/invitations/accept',
]);

export function assertRelativeMay(method: string, routeUrl: string | undefined) {
  if (!routeUrl) return; // ruta inexistente: responde 404 el propio servidor
  const key = `${method} ${routeUrl}`;
  if (RELATIVE_ALLOWED.has(key) || PUBLIC_ROUTES.has(key)) return;
  throw forbidden('Como pariente puedes ver y animar, pero no cambiar esto');
}
