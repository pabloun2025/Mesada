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
  assignee_name: string | null;
  assignee_avatar: string | null;
  assignee_color: string | null;
  completed_by_name: string | null;
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
