-- Mesada: esquema inicial
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE families (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  currency text NOT NULL DEFAULT 'EUR',
  timezone text NOT NULL DEFAULT 'Europe/Madrid',
  -- Equivalencia: rate_points puntos = rate_cents céntimos (p. ej. 100 pts = 500 cts = 5 €)
  rate_points integer NOT NULL DEFAULT 100 CHECK (rate_points > 0),
  rate_cents integer NOT NULL DEFAULT 500 CHECK (rate_cents >= 0),
  settlement_period text NOT NULL DEFAULT 'week' CHECK (settlement_period IN ('week','month')),
  cap_cents integer CHECK (cap_cents IS NULL OR cap_cents >= 0), -- límite por periodo de cierre (NULL = sin límite)
  leaderboard_enabled boolean NOT NULL DEFAULT true,
  celebrations_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('adult','child')),
  display_name text NOT NULL,
  username text NOT NULL,
  password_hash text NOT NULL,
  avatar text NOT NULL DEFAULT 'fox',
  color text NOT NULL DEFAULT 'teal',
  birth_year integer,
  weekly_goal_points integer NOT NULL DEFAULT 0 CHECK (weekly_goal_points >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_username_key ON users (lower(username));
CREATE INDEX users_family_idx ON users (family_id);

CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT 'check',
  difficulty text NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  points integer NOT NULL CHECK (points >= 0),
  recurrence text NOT NULL CHECK (recurrence IN ('once','daily','weekly','monthly')),
  weekdays smallint[] NOT NULL DEFAULT '{}', -- ISO 1=lunes..7=domingo (para weekly; en daily filtra días)
  month_day smallint CHECK (month_day IS NULL OR month_day BETWEEN 1 AND 31),
  start_date date NOT NULL,
  end_date date,
  due_time time, -- hora límite opcional
  assignment_mode text NOT NULL DEFAULT 'individual' CHECK (assignment_mode IN ('individual','shared','rotation')),
  requires_approval boolean NOT NULL DEFAULT true,
  requires_photo boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tasks_family_idx ON tasks (family_id) WHERE active;

CREATE TABLE task_assignees (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, user_id)
);

-- Ocurrencias materializadas de cada tarea. assignee_id NULL = tarea compartida (la puede hacer cualquiera).
CREATE TABLE task_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  assignee_id uuid REFERENCES users(id) ON DELETE CASCADE,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','submitted','approved','rejected','expired')),
  points integer NOT NULL,
  completed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  completed_at timestamptz,
  child_note text,
  photo_path text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX task_instances_unique ON task_instances (task_id, due_date, COALESCE(assignee_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX task_instances_family_date ON task_instances (family_id, due_date);
CREATE INDEX task_instances_status ON task_instances (family_id, status);

-- Libro de puntos (append-only). Saldo de puntos = SUM(delta).
CREATE TABLE points_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('task','adjustment','bonus','redemption','refund','conversion')),
  ref_id uuid,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX points_ledger_user ON points_ledger (user_id, created_at);

-- Libro de dinero (céntimos). account: available (saldo convertido) | savings (hucha)
CREATE TABLE money_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account text NOT NULL DEFAULT 'available' CHECK (account IN ('available','savings')),
  delta_cents integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('conversion','payment','adjustment','transfer')),
  ref_id uuid,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX money_ledger_user ON money_ledger (user_id, created_at);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start date NOT NULL,
  period_end date NOT NULL,
  points_converted integer NOT NULL,
  cents integer NOT NULL,
  capped boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, period_start)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  method text NOT NULL DEFAULT 'cash' CHECK (method IN ('cash','transfer','bizum','other')),
  note text NOT NULL DEFAULT '',
  paid_by uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  paid_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE rewards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT 'gift',
  cost_points integer NOT NULL CHECK (cost_points > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  reward_id uuid REFERENCES rewards(id) ON DELETE SET NULL,
  reward_title text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cost_points integer NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','rejected','delivered')),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  note text NOT NULL DEFAULT ''
);

CREATE TABLE savings_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  target_cents integer NOT NULL CHECK (target_cents > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  archived boolean NOT NULL DEFAULT false
);

CREATE TABLE user_badges (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  badge text NOT NULL,
  awarded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, badge)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL DEFAULT '',
  link text,
  dedupe_key text UNIQUE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id uuid,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_family ON audit_log (family_id, created_at DESC);
