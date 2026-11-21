-- I6 sistema de dinero (canje, retiro, adelanto, préstamo) e I7 ahorro programado con interés.
-- Idempotente: se puede volver a ejecutar sin efecto.

-- ---------- Ajustes del banco por familia (cada opción se puede apagar) ----------
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_exchange_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_exchange_min_points integer NOT NULL DEFAULT 50 CHECK (bank_exchange_min_points BETWEEN 1 AND 100000);
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_withdraw_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_withdraw_per_week integer NOT NULL DEFAULT 2 CHECK (bank_withdraw_per_week BETWEEN 1 AND 14);
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_advance_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_advance_percent integer NOT NULL DEFAULT 50 CHECK (bank_advance_percent BETWEEN 1 AND 100);
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_loan_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_loan_max_percent integer NOT NULL DEFAULT 300 CHECK (bank_loan_max_percent BETWEEN 1 AND 1000);
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_loan_max_weeks integer NOT NULL DEFAULT 12 CHECK (bank_loan_max_weeks BETWEEN 1 AND 52);
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_loan_interest_points integer NOT NULL DEFAULT 10 CHECK (bank_loan_interest_points BETWEEN 0 AND 1000);
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_savings_enabled boolean NOT NULL DEFAULT true;  -- interés del ahorro
ALTER TABLE families ADD COLUMN IF NOT EXISTS bank_savings_rate_percent numeric(5,2) NOT NULL DEFAULT 1 CHECK (bank_savings_rate_percent BETWEEN 0.01 AND 100);

-- ---------- Nuevos tipos de movimiento ----------
-- Los saldos de puntos y dinero pueden quedar en negativo (préstamo, compra de meta): no hay disparador que lo impida.
ALTER TABLE points_ledger DROP CONSTRAINT IF EXISTS points_ledger_kind_check;
ALTER TABLE points_ledger ADD CONSTRAINT points_ledger_kind_check
  CHECK (kind IN ('task','adjustment','bonus','redemption','refund','conversion','exchange','advance','loan_interest'));
ALTER TABLE money_ledger DROP CONSTRAINT IF EXISTS money_ledger_kind_check;
ALTER TABLE money_ledger ADD CONSTRAINT money_ledger_kind_check
  CHECK (kind IN ('conversion','payment','adjustment','transfer','exchange','advance','loan','loan_repayment','interest','interest_forfeit','goal_redeem'));

-- Orden de inserción estable para el extracto (created_at es el inicio de la transacción y se repite).
ALTER TABLE points_ledger ADD COLUMN IF NOT EXISTS seq bigserial;
ALTER TABLE money_ledger ADD COLUMN IF NOT EXISTS seq bigserial;

-- ---------- Ahorro programado: cada meta tiene su propio saldo ----------
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active';
ALTER TABLE savings_goals DROP CONSTRAINT IF EXISTS savings_goals_status_check;
ALTER TABLE savings_goals ADD CONSTRAINT savings_goals_status_check CHECK (status IN ('active','bought','cashed_out'));
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS price_cents integer;  -- precio real al marcar «Comprado»
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE money_ledger ADD COLUMN IF NOT EXISTS goal_id uuid REFERENCES savings_goals(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS money_ledger_goal ON money_ledger (goal_id) WHERE goal_id IS NOT NULL;
-- La hucha anterior (saldo sin meta) pasa a la primera meta de cada hijo. El guardián del libro permite
-- cambiar goal_id: solo protege importe, usuario, cuenta y tipo.
UPDATE money_ledger m SET goal_id = (SELECT g.id FROM savings_goals g WHERE g.user_id = m.user_id AND NOT g.archived ORDER BY g.created_at LIMIT 1)
 WHERE m.account = 'savings' AND m.goal_id IS NULL;

-- Canje del hijo (money_ledger/points_ledger llevan el movimiento; aquí se lleva el uso del tope semanal).
-- cap_week es el lunes cuyo tope se consume: el de la semana actual en un canje, el de la siguiente en un adelanto.
CREATE TABLE IF NOT EXISTS cap_uses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('exchange','advance')),
  cap_week date NOT NULL,
  points integer NOT NULL CHECK (points > 0),
  cents integer NOT NULL CHECK (cents > 0),
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cap_uses_user_week ON cap_uses (user_id, cap_week);

-- ---------- Préstamos ----------
CREATE TABLE IF NOT EXISTS loans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  weeks integer NOT NULL CHECK (weeks BETWEEN 1 AND 52),
  interest_points integer NOT NULL DEFAULT 0 CHECK (interest_points >= 0),  -- por semana, fijado al pedir
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','paid','rejected','cancelled')),
  note text NOT NULL DEFAULT '',
  decision_note text NOT NULL DEFAULT '',
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  first_charge_week date,                 -- lunes de la primera cuota
  installments_paid integer NOT NULL DEFAULT 0,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Un solo préstamo abierto (pedido o vigente) por hijo.
CREATE UNIQUE INDEX IF NOT EXISTS loans_one_open ON loans (user_id) WHERE status IN ('pending','active');
CREATE INDEX IF NOT EXISTS loans_family ON loans (family_id, status);

CREATE TABLE IF NOT EXISTS loan_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id uuid NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  week_start date NOT NULL,
  cents integer NOT NULL,
  interest_points integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (loan_id, seq),
  UNIQUE (loan_id, week_start)
);

-- ---------- Peticiones sobre una meta de ahorro (canjear la meta o pasarla a efectivo) ----------
CREATE TABLE IF NOT EXISTS goal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  goal_id uuid NOT NULL REFERENCES savings_goals(id) ON DELETE CASCADE,
  goal_title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('redeem','cashout')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  balance_cents integer NOT NULL,         -- saldo de la meta al pedir
  price_cents integer,                    -- precio real (canjear)
  settle_cents integer,                   -- + sobra / − falta, ya aplicado al saldo de dinero
  forfeited_cents integer,                -- interés perdido (pasar a efectivo)
  decision_note text NOT NULL DEFAULT '',
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS goal_requests_one_pending ON goal_requests (goal_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS goal_requests_family ON goal_requests (family_id, status);
