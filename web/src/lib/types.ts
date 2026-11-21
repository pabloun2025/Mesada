export type Role = 'adult' | 'child';

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

export type InstanceStatus = 'pending' | 'submitted' | 'approved' | 'rejected' | 'expired';

export interface Instance {
  id: string;
  task_id: string;
  assignee_id: string | null;
  due_date: string;
  status: InstanceStatus;
  points: number;
  completed_by: string | null;
  completed_at: string | null;
  child_note: string | null;
  has_photo: boolean;
  review_note: string | null;
  title: string;
  icon: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly';
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
  bonus: Bonus | null;
  assignee_name: string | null;
  assignee_avatar: string | null;
  assignee_color: string | null;
  completed_by_name: string | null;
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
  recurrence: 'once' | 'daily' | 'weekly' | 'monthly';
  weekdays: number[];
  month_day: number | null;
  start_date: string;
  end_date: string | null;
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
  status: 'active' | 'bought' | 'cashed_out';
  price_cents: number | null;
  principal_cents: number;
  interest_cents: number;
  interest_earned_cents: number;
  balance_cents: number;
  reached: boolean;
  pending_request: { id: string; kind: 'redeem' | 'cashout'; status: string } | null;
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
