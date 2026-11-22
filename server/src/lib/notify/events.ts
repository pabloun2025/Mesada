/** Catálogo de eventos de notificación. La aplicación (campana) siempre recibe el aviso; correo y WhatsApp, según preferencias. */
export type Channel = 'email' | 'whatsapp';
export const CHANNELS: Channel[] = ['email', 'whatsapp'];

export interface EventDef {
  label: string;
  audience: 'child' | 'adult' | 'any';
  /** Canales activos por defecto si no hay preferencia guardada. */
  defaults: Channel[];
  /** Ignora el horario de silencio. */
  critical?: boolean;
}

export const EVENTS = {
  task_assigned: { label: 'Nueva tarea asignada', audience: 'child', defaults: [] },
  task_reminder: { label: 'Recordatorio de tareas del día', audience: 'child', defaults: ['whatsapp'] },
  task_due_soon: { label: 'Tarea a punto de vencer', audience: 'child', defaults: ['whatsapp'] },
  task_submitted: { label: 'Tarea enviada para validar', audience: 'adult', defaults: ['whatsapp'] },
  task_approved: { label: 'Tarea aprobada y puntos', audience: 'child', defaults: [] },
  task_rejected: { label: 'Tarea devuelta para repasar', audience: 'child', defaults: ['whatsapp'] },
  points_adjusted: { label: 'Ajuste de puntos', audience: 'child', defaults: [] },
  reward_requested: { label: 'Recompensa pedida', audience: 'adult', defaults: ['whatsapp'] },
  reward_decided: { label: 'Recompensa aprobada o rechazada', audience: 'child', defaults: ['whatsapp'] },
  settlement: { label: 'Cierre de mesada', audience: 'any', defaults: ['email'] },
  payment: { label: 'Pago registrado', audience: 'child', defaults: [] },
  bonus_won: { label: 'Sorpresa ganada', audience: 'child', defaults: [] },
  screen_changed: { label: 'Cambio en minutos de pantalla', audience: 'child', defaults: [] },
  payout_requested: { label: 'Petición de dinero o pantalla', audience: 'adult', defaults: ['whatsapp'] },
  payout_decided: { label: 'Petición de dinero o pantalla resuelta', audience: 'child', defaults: ['whatsapp'] },
  screen_overuse: { label: 'Pantalla anotada por encima del saldo', audience: 'adult', defaults: ['whatsapp'] },
  points_exchanged: { label: 'Puntos cambiados por dinero', audience: 'adult', defaults: [] },
  advance_taken: { label: 'Adelanto de la semana siguiente', audience: 'adult', defaults: [] },
  loan_requested: { label: 'Préstamo pedido', audience: 'adult', defaults: ['whatsapp'] },
  loan_decided: { label: 'Préstamo aprobado o rechazado', audience: 'child', defaults: ['whatsapp'] },
  loan_charged: { label: 'Cuota del préstamo', audience: 'child', defaults: [] },
  goal_requested: { label: 'Meta de ahorro por canjear o pasar a efectivo', audience: 'adult', defaults: ['whatsapp'] },
  goal_decided: { label: 'Meta de ahorro resuelta', audience: 'child', defaults: ['whatsapp'] },
  savings_interest: { label: 'Interés del ahorro', audience: 'child', defaults: [] },
  badge: { label: 'Insignia u objetivo conseguido', audience: 'child', defaults: [] },
  goal_proposed: { label: 'Meta de ahorro o ahorro automático por aprobar', audience: 'adult', defaults: ['whatsapp'] },
  goal_gift: { label: 'Aporte a tu meta de ahorro', audience: 'child', defaults: [] },
  goal_match: { label: 'Aporte de tus padres a tu meta', audience: 'child', defaults: [] },
  goal_auto: { label: 'Ahorro automático a tu meta', audience: 'child', defaults: [] },
  cheer: { label: 'Felicitación', audience: 'child', defaults: [] },
  relative_activity: { label: 'Un pariente ha animado o aportado', audience: 'adult', defaults: [] },
  family_change: { label: 'Cambios en la familia', audience: 'adult', defaults: [] },
} satisfies Record<string, EventDef>;

export type EventKey = keyof typeof EVENTS;
export const isEventKey = (k: string): k is EventKey => k in EVENTS;

/** Eventos de sistema que no dependen de preferencias (correo directo). */
export const SYSTEM_EVENTS = {
  password_reset: { label: 'Recuperar contraseña', critical: true },
  invitation: { label: 'Invitación a la familia', critical: true },
} as const;
