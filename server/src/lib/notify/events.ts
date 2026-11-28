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
  /** Emoji que abre el título si el texto no trae ya uno: los avisos son alegres. */
  emoji: string;
}

export const EVENTS = {
  task_assigned: { label: 'Nueva tarea asignada', audience: 'child', emoji: '🆕', defaults: [] },
  task_available: { label: 'Tarea «cuando haga falta» activada', audience: 'child', emoji: '🏃', defaults: ['whatsapp'] },
  task_reminder: { label: 'Recordatorio de tareas del día', audience: 'child', emoji: '📝', defaults: ['whatsapp'] },
  task_due_soon: { label: 'Tarea a punto de vencer', audience: 'child', emoji: '⏰', defaults: ['whatsapp'] },
  task_submitted: { label: 'Tarea enviada para validar', audience: 'adult', emoji: '📬', defaults: ['whatsapp'] },
  task_approved: { label: 'Tarea aprobada y puntos', audience: 'child', emoji: '🎉', defaults: [] },
  task_rejected: { label: 'Tarea devuelta para repasar', audience: 'child', emoji: '🔁', defaults: ['whatsapp'] },
  proposal_received: { label: 'Idea de tarea o premio por revisar', audience: 'adult', emoji: '💡', defaults: [] },
  proposal_decided: { label: 'Respuesta a tu idea de tarea o premio', audience: 'child', emoji: '💡', defaults: [] },
  points_adjusted: { label: 'Ajuste de puntos', audience: 'child', emoji: '⭐', defaults: [] },
  reward_requested: { label: 'Recompensa pedida', audience: 'adult', emoji: '🎁', defaults: ['whatsapp'] },
  reward_decided: { label: 'Recompensa aprobada o rechazada', audience: 'child', emoji: '🎁', defaults: ['whatsapp'] },
  settlement: { label: 'Cierre de mesada', audience: 'any', emoji: '📅', defaults: ['email'] },
  payment: { label: 'Pago registrado', audience: 'child', emoji: '💸', defaults: [] },
  expense_recorded: { label: 'Gasto registrado en tu mesada', audience: 'child', emoji: '🧾', defaults: [] },
  bonus_won: { label: 'Sorpresa ganada', audience: 'child', emoji: '🎁', defaults: [] },
  screen_changed: { label: 'Cambio en minutos de pantalla', audience: 'child', emoji: '📺', defaults: [] },
  payout_requested: { label: 'Petición de dinero o pantalla', audience: 'adult', emoji: '🙋', defaults: ['whatsapp'] },
  payout_decided: { label: 'Petición de dinero o pantalla resuelta', audience: 'child', emoji: '💸', defaults: ['whatsapp'] },
  screen_overuse: { label: 'Pantalla anotada por encima del saldo', audience: 'adult', emoji: '👀', defaults: ['whatsapp'] },
  points_exchanged: { label: 'Puntos cambiados por dinero', audience: 'adult', emoji: '💱', defaults: [] },
  advance_taken: { label: 'Adelanto de la semana siguiente', audience: 'adult', emoji: '⏩', defaults: [] },
  loan_requested: { label: 'Préstamo pedido', audience: 'adult', emoji: '🏦', defaults: ['whatsapp'] },
  loan_decided: { label: 'Préstamo aprobado o rechazado', audience: 'child', emoji: '🏦', defaults: ['whatsapp'] },
  loan_charged: { label: 'Cuota del préstamo', audience: 'child', emoji: '🧾', defaults: [] },
  goal_requested: { label: 'Meta de ahorro por canjear o pasar a efectivo', audience: 'adult', emoji: '🛍️', defaults: ['whatsapp'] },
  goal_decided: { label: 'Meta de ahorro resuelta', audience: 'child', emoji: '🎯', defaults: ['whatsapp'] },
  savings_interest: { label: 'Interés del ahorro', audience: 'child', emoji: '📈', defaults: [] },
  badge: { label: 'Insignia u objetivo conseguido', audience: 'child', emoji: '🏅', defaults: [] },
  goal_proposed: { label: 'Meta de ahorro o ahorro automático por aprobar', audience: 'adult', emoji: '🎯', defaults: ['whatsapp'] },
  goal_gift: { label: 'Aporte a tu meta de ahorro', audience: 'child', emoji: '💝', defaults: [] },
  goal_match: { label: 'Aporte de tus padres a tu meta', audience: 'child', emoji: '🤝', defaults: [] },
  goal_auto: { label: 'Ahorro automático a tu meta', audience: 'child', emoji: '🐷', defaults: [] },
  cheer: { label: 'Felicitación', audience: 'child', emoji: '💌', defaults: [] },
  relative_activity: { label: 'Un pariente ha animado o aportado', audience: 'adult', emoji: '💌', defaults: [] },
  screen_started: { label: 'Un hijo ha empezado su pantalla', audience: 'adult', emoji: '🎮', defaults: [] },
  screen_stopped: { label: 'Un hijo ha parado su pantalla', audience: 'adult', emoji: '⏸️', defaults: [] },
  screen_parent_started: { label: 'Un adulto ha puesto en marcha tu pantalla', audience: 'child', emoji: '🎮', defaults: [] },
  screen_warning: { label: 'Quedan 5 minutos de pantalla', audience: 'child', emoji: '⏳', defaults: [] },
  screen_ended: { label: 'Se acabó el tiempo de pantalla', audience: 'any', emoji: '⏰', defaults: ['whatsapp'] },
  screen_request: { label: 'Petición de pantalla o de tiempo extra', audience: 'adult', emoji: '🙋', defaults: ['whatsapp'] },
  screen_decided: { label: 'Petición de pantalla resuelta', audience: 'child', emoji: '🎮', defaults: ['whatsapp'] },
  screen_block: { label: 'Descanso de pantalla', audience: 'child', emoji: '🌿', defaults: ['whatsapp'] },
  screen_challenge: { label: 'Reto de pantalla por validar', audience: 'adult', emoji: '🏆', defaults: ['whatsapp'] },
  screen_expiring: { label: 'Minutos ganados a punto de caducar', audience: 'child', emoji: '⌛', defaults: [] },
  screen_overrun: { label: 'Pantalla usada de más', audience: 'any', emoji: '⚠️', defaults: ['whatsapp'] },
  family_change: { label: 'Cambios en la familia', audience: 'adult', emoji: '👪', defaults: [] },
} satisfies Record<string, EventDef>;

export type EventKey = keyof typeof EVENTS;
export const isEventKey = (k: string): k is EventKey => k in EVENTS;

/** Eventos de sistema que no dependen de preferencias (correo directo). */
export const SYSTEM_EVENTS = {
  password_reset: { label: 'Recuperar contraseña', critical: true },
  invitation: { label: 'Invitación a la familia', critical: true },
} as const;
