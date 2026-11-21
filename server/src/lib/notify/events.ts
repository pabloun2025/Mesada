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
  badge: { label: 'Insignia u objetivo conseguido', audience: 'child', defaults: [] },
} satisfies Record<string, EventDef>;

export type EventKey = keyof typeof EVENTS;
export const isEventKey = (k: string): k is EventKey => k in EVENTS;

/** Eventos de sistema que no dependen de preferencias (correo directo). */
export const SYSTEM_EVENTS = {
  password_reset: { label: 'Recuperar contraseña', critical: true },
  invitation: { label: 'Invitación a la familia', critical: true },
} as const;
