export type Role = 'adult' | 'child';
export type Relationship = 'mother' | 'father' | 'partner' | 'guardian' | 'grandparent' | 'aunt_uncle' | 'other';

export interface User {
  id: string;
  family_id: string;
  role: Role;
  display_name: string;
  username?: string;
  avatar: string;
  color: string;
  birth_year: number | null;
  weekly_goal_points: number;
  active: boolean;
  email?: string | null;
  phone?: string | null;
  whatsapp_consent_at?: string | null;
  is_superadmin?: boolean;
  terms_version?: string | null;
  terms_accepted_at?: string | null;
  /** Parentesco de un adulto (vacío en los anteriores a I20) y texto libre de «Otro». */
  relationship?: Relationship | null;
  relationship_label?: string | null;
  /** Cuenta principal: la que creó la familia (o a la que se cedió). */
  is_principal?: boolean;
  /** Pariente (abuelo/a, tío/a, otro): ver y animar. */
  is_relative?: boolean;
}

export interface Family {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  rate_points: number;
  rate_cents: number;
  settlement_period: 'week' | 'month';
  cap_cents: number | null;
  leaderboard_enabled: boolean;
  celebrations_enabled: boolean;
  bank_exchange_enabled: boolean;
  bank_exchange_min_points: number;
  bank_withdraw_enabled: boolean;
  bank_withdraw_per_week: number;
  bank_advance_enabled: boolean;
  bank_advance_percent: number;
  bank_loan_enabled: boolean;
  bank_loan_max_percent: number;
  bank_loan_max_weeks: number;
  bank_loan_interest_points: number;
  bank_savings_enabled: boolean;
  bank_savings_rate_percent: number;
}

export type InstanceStatus = 'pending' | 'submitted' | 'approved' | 'rejected' | 'expired' | 'declined';
export type ReviewOutcome = 'approved' | 'partial' | 'returned' | 'declined' | 'penalized';

export interface Instance {
  id: string;
  /** El hijo puede desmarcarla (la marcó él, nadie la ha validado y, si no pedía validación, sigue siendo el mismo día). */
  can_unmark?: boolean;
  task_id: string;
  assignee_id: string | null;
  due_date: string;
  status: InstanceStatus;
  points: number;
  completed_by: string | null;
  completed_at: string | null;
  child_note: string | null;
  has_photo: boolean;
  photo_deleted?: boolean;
  review_note: string | null;
  review_outcome: ReviewOutcome | null;
  penalty_points: number;
  penalty_screen: number;
  title: string;
  icon: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'as_needed';
  assignment_mode: 'individual' | 'shared' | 'rotation';
  requires_approval: boolean;
  requires_photo: boolean;
  due_time: string | null;
  due_time_weekend: string | null;
  late_percent: number;
  task_points: number;
  late_points: number;
  /** Hora límite vigente ese día («HH:MM») y su instante exacto. */
  deadline_time: string | null;
  deadline_at: string | null;
  on_time: boolean | null;
  check_mode: boolean;
  check_met: boolean | null;
  penalty_minutes: number;
  success_minutes: number;
  /** Minutos de pantalla que da la tarea (comprobación cumplida o bono visible): se ven junto a puntos y euros. */
  minutes_reward?: number;
  bonus: Bonus | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  assignee_color: string | null;
  completed_by_name: string | null;
  repeat_no: number;
  repeatable: boolean;
  max_per_day: number | null;
  done_count: number;
  cooldown_days: number | null;
  /** Mientras espere tras hacerla (I14): día en que vuelve. */
  blocked_until: string | null;
}

/** Bono tal como lo ve quien mira: a un hijo, una sorpresa sin ganar no trae contenido. */
export interface Bonus {
  surprise: boolean;
  onTimeOnly: boolean;
  kind?: 'points' | 'screen' | 'text' | 'reward';
  label?: string | null;
  claimed?: boolean;
}

export interface BonusGrant {
  id: string;
  user_id: string;
  task_title: string;
  kind: 'points' | 'screen' | 'text' | 'reward';
  label: string;
  surprise: boolean;
  revealed_at: string | null;
  fulfilled_at: string | null;
  created_at: string;
  display_name: string;
  avatar: string;
  color: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  icon: string;
  difficulty: 'easy' | 'medium' | 'hard';
  points: number;
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly' | 'as_needed';
  weekdays: number[];
  month_day: number | null;
  start_date: string;
  end_date: string | null;
  repeatable?: boolean;
  max_per_day?: number | null;
  cooldown_days?: number | null;
  due_time: string | null;
  due_time_weekend: string | null;
  late_percent: number;
  check_mode: boolean;
  penalty_minutes: number;
  success_minutes: number;
  bonus: Bonus | null;
  bonus_kind?: 'points' | 'screen' | 'text' | 'reward' | null;
  bonus_points?: number | null;
  bonus_minutes?: number | null;
  bonus_text?: string | null;
  bonus_reward_id?: string | null;
  bonus_surprise?: boolean;
  bonus_on_time_only?: boolean;
  assignment_mode: 'individual' | 'shared' | 'rotation';
  requires_approval: boolean;
  requires_photo: boolean;
  assignees: { id: string; display_name: string; avatar: string; color: string }[];
}

export interface Wallet {
  points_available: number;
  points_lifetime: number;
  points_reserved: number;
  points_value_cents: number;
  cents_pending: number;
  cents_savings: number;
  cents_converted_total: number;
  cents_paid_total: number;
  screen_minutes: number;
}

export interface Reward {
  id: string;
  title: string;
  description: string;
  icon: string;
  cost_points: number;
}

export interface Redemption {
  id: string;
  reward_title: string;
  user_id: string;
  cost_points: number;
  status: 'requested' | 'approved' | 'rejected' | 'delivered';
  requested_at: string;
  note: string;
  display_name: string;
  avatar: string;
  color: string;
}

export interface Progress {
  user: { id: string; display_name: string; avatar: string; color: string; weekly_goal_points: number };
  level: { level: number; title: string; current: number; needed: number; nextAt: number };
  lifetimePoints: number;
  streak: number;
  week: { start: string; points: number; goal: number; cents: number };
  period: {
    start: string; end: string; type: 'week' | 'month';
    maxPoints: number; earnedPoints: number; missedPoints: number; waitingPoints: number; maxCents: number; earnedCents: number;
  };
  badges: { key: string; title: string; description: string; icon: string; awardedAt: string | null }[];
}

export type ScreenCategory = 'videojuegos' | 'tele' | 'tablet' | 'movil' | 'ordenador' | 'otro';
export type PayMethod = 'cash' | 'transfer' | 'bizum' | 'other';

export interface PayoutRequest {
  id: string;
  user_id: string;
  kind: 'money' | 'screen';
  amount_cents: number | null;
  minutes: number | null;
  category: ScreenCategory | null;
  note: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  granted_cents: number | null;
  granted_minutes: number | null;
  decision_note: string;
  created_at: string;
  display_name: string;
  avatar: string;
  color: string;
}

export interface ScreenLog {
  id: string;
  user_id: string;
  day: string;
  minutes: number;
  applied_minutes: number;
  overflow_minutes: number;
  category: ScreenCategory;
  note: string;
  status: 'pending' | 'confirmed' | 'voided';
  created_at: string;
  display_name: string;
  avatar: string;
  color: string;
}

/* ---------- Banco ---------- */

/** `hint` es la versión corta del motivo (para el botón redondo); `reason` es el motivo completo. */
export interface BankAction { ok: boolean; reason: string | null; hint: string | null }

export interface Loan {
  id: string;
  user_id: string;
  amount_cents: number;
  weeks: number;
  interest_points: number;
  status: 'pending' | 'active' | 'paid' | 'rejected' | 'cancelled';
  note: string;
  installments_paid: number;
  remaining_installments: number;
  remaining_cents: number;
  installment_cents: number;
  next_charge_week: string | null;
  created_at: string;
  display_name: string;
  avatar: string;
  color: string;
}

export interface Bank {
  accounts: { money: string; points: string };
  money_cents: number;
  points: number;
  savings_cents: number;
  rate: { points: number; cents: number };
  week: { start: string; end: string; cap_cents: number | null; used_cents: number; remaining_cents: number | null; withdrawals_used: number; withdrawals_max: number };
  actions: {
    withdraw: BankAction & { max_cents: number };
    exchange: BankAction & { min_points: number; max_points: number };
    advance: BankAction & { max_cents: number };
    loan: BankAction & { max_cents: number; max_weeks: number; interest_points: number };
    save: BankAction;
  };
  loan: Loan | null;
  owed_cents: number;
  history: BalanceHistory;
}

/** Saldo de dinero al final de cada una de las últimas 8 semanas (lunes a domingo); el último punto es el saldo de ahora. */
export interface BalanceHistory {
  weeks: { week_start: string; balance_cents: number }[];
  start_cents: number;
  delta_cents: number;
  week_delta_cents: number;
}

export interface BankSummary {
  owed_cents: number;
  money_cents: number;
  savings_cents: number;
  loans_active: number;
  loans_remaining_cents: number;
  interest_week_cents: number;
}

export interface Goal {
  id: string;
  user_id: string;
  title: string;
  target_cents: number;
  status: 'proposed' | 'active' | 'bought' | 'cashed_out' | 'rejected';
  emoji: string | null;
  has_photo: boolean;
  decision_note: string;
  price_cents: number | null;
  principal_cents: number;
  interest_cents: number;
  interest_earned_cents: number;
  /** Aportes de padres y parientes (se pierden, como el interés, si se saca el ahorro antes de llegar). */
  contributions_cents: number;
  matched_cents: number;
  balance_cents: number;
  reached: boolean;
  auto_percent: number;
  auto_pending_percent: number | null;
  match_per_cents: number | null;
  match_gives_cents: number | null;
  match_cap_cents: number | null;
  /** Media de lo ganado por semana (últimas 4 semanas cerradas) y semanas que faltan; null si no hay datos. */
  weekly_cents: number | null;
  weeks_left: number | null;
  contributions: { id: string; kind: 'goal_gift' | 'goal_match'; cents: number; note: string; created_at: string; reversed: boolean }[];
  pending_request: { id: string; kind: 'redeem' | 'cashout'; status: string } | null;
}

export interface GoalProposals {
  proposals: { id: string; user_id: string; title: string; target_cents: number; emoji: string | null; has_photo: boolean; created_at: string; display_name: string; avatar: string; color: string }[];
  autoRequests: { id: string; user_id: string; title: string; auto_percent: number; auto_pending_percent: number; created_at: string; display_name: string; avatar: string; color: string }[];
}

export interface GoalRequest {
  id: string;
  user_id: string;
  goal_id: string;
  goal_title: string;
  kind: 'redeem' | 'cashout';
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  balance_cents: number;
  target_cents: number;
  created_at: string;
  display_name: string;
  avatar: string;
  color: string;
}

export interface StatementEntry {
  id: string;
  account: 'money' | 'points';
  /** `goal`: movimiento de una meta de ahorro (su saldo es el de la meta, no el de la cuenta). */
  scope: 'account' | 'goal';
  amount: number;
  kind: string;
  note: string;
  created_at: string;
  created_by_name: string | null;
  balance_after: number;
  method: PayMethod | null;
  is_withdrawal: boolean;
}

/** Trabajo extra en el tablón (I11). `assignee_id` null = libre; si no, lo tiene `holder_name`. */
export interface ExtraBoardItem {
  id: string;
  can_unmark?: boolean;
  task_id: string;
  status: InstanceStatus;
  points: number;
  extra_deadline: string | null;
  assignee_id: string | null;
  completed_by: string | null;
  has_photo: boolean;
  photo_deleted?: boolean;
  review_note: string | null;
  title: string;
  icon: string;
  description: string;
  requires_photo: boolean;
  holder_name: string | null;
  holder_avatar: string | null;
  mine: boolean;
  bonus: Bonus | null;
}

export interface ExtraCatalogItem {
  id: string;
  title: string;
  description: string;
  icon: string;
  points: number;
  requires_approval: boolean;
  requires_photo: boolean;
  bonus_kind: 'points' | 'screen' | 'text' | 'reward' | null;
  bonus_points: number | null;
  bonus_minutes: number | null;
  bonus_text: string | null;
  bonus_reward_id: string | null;
  bonus_surprise: boolean;
  bonus_on_time_only: boolean;
  open_instance_id: string | null;
  bonus: Bonus | null;
}

/** Desglose del saldo de pantalla (plan de la semana y ganados) y pausa vigente. */
export interface ScreenBuckets {
  plan: { minutes: number; expires_at: string | null };
  earned: { minutes: number; first_expires_at: string | null };
}
export interface ScreenPause { id: string; starts_on: string; ends_on: string; reason: string; label: string }
export interface ScreenEntry {
  id: string;
  delta: number;
  kind: string;
  category: ScreenCategory | null;
  note: string;
  created_at: string;
  created_by_name: string | null;
  log_status?: 'pending' | 'confirmed' | 'voided' | null;
  log_overflow?: number | null;
  is_adjustment: boolean;
  reason: string | null;
  adjustment_note: string | null;
  recovery_title: string | null;
  adjustment_status: string | null;
}
export interface ScreenPauseRow { id: string; reason_title: string; note: string; pause_days: number; pause_starts_on: string; pause_ends_on: string; status: string; created_at: string; recovery_title: string | null }
export interface ScreenView {
  balance: number;
  buckets: ScreenBuckets;
  pause: ScreenPause | null;
  plan: { minutes_per_week: number; enabled: boolean };
  entries: ScreenEntry[];
  pauses: ScreenPauseRow[];
}
export interface ScreenReason { id: string; title: string; effect: 'minutes' | 'pause'; minutes: number | null; pause_days: number | null; archived: boolean }
export interface ScreenPlanRow { user_id: string; display_name: string; avatar: string | null; color: string | null; minutes_per_week: number; enabled: boolean; allowed_days?: number[]; day_max?: Record<string, number>; require_approval?: boolean }

/* ---------- I21: sesiones de pantalla, castigos y retos ---------- */
export interface ScreenSession {
  id: string; user_id: string; kind: 'timer' | 'charge'; status: 'pending' | 'running' | 'finished' | 'rejected' | 'cancelled'; category: ScreenCategory | null; note: string;
  requested_minutes: number; extended_minutes: number; extra: boolean; started_at: string | null; planned_end_at: string | null; ended_at: string | null;
  started_by: string | null; started_by_name: string | null; stopped_by_name: string | null; end_reason: 'stopped' | 'expired' | 'charge' | 'blocked' | null;
  used_minutes: number; charged_minutes: number; shortfall_mode: 'debt' | 'points' | 'money'; shortfall_minutes: number; paid_points: number; paid_cents: number; overrun_minutes: number;
  decided_by: string | null; decision_note: string; created_at: string;
  display_name?: string; avatar?: string | null; color?: string | null; balance_minutes?: number; rates?: { pointsPer15: number; centsPer15: number };
}
export interface ScreenChallenge { text: string; photo_required: boolean; effect: 'lift' | 'shorten'; days: number | null; status: 'open' | 'submitted' | 'approved' | 'rejected'; note: string; has_photo: boolean; done_at: string | null }
export interface ScreenBlock {
  id: string; kind: 'days' | 'window'; reason: string; starts_on: string; ends_on: string; window_start: string | null; window_end: string | null;
  state: 'active' | 'ended' | 'lifted'; label: string; blocked_now: boolean; challenge: ScreenChallenge | null; created_at: string;
}
export interface ScreenState {
  now: string; timezone: string; balance: number;
  buckets: { plan: { minutes: number; amount: number; expires_at: string | null }; earned: { minutes: number; amount: number; first_expires_at: string | null; lots: { minutes: number; expires_at: string }[] } };
  plan: { enabled: boolean; minutes_per_week: number; allowed_days: number[]; day_max: Record<string, number>; require_approval: boolean };
  today: { date: string; allowed: boolean; cap: number | null; used: number; cap_left: number | null };
  can_start: boolean; reason: string; reason_code: string | null; max_minutes: number;
  session: ScreenSession | null; pending_extra: ScreenSession | null; last_session: ScreenSession | null;
  blocks: ScreenBlock[]; pause: { label: string } | null; debt_minutes: number; expiring: { minutes: number; expires_at: string } | null;
  rates: { pointsPer15: number; centsPer15: number }; wallet: { points: number; cents: number };
  /** Hora local en el momento de recibirlo (para la cuenta atrás sin depender del reloj del móvil). */
  _recv?: number;
}
