CREATE TABLE child_expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  total_cents integer NOT NULL CHECK (total_cents > 0),
  parent_cents integer NOT NULL CHECK (parent_cents BETWEEN 0 AND total_cents),
  parent_basis_points integer CHECK (parent_basis_points BETWEEN 0 AND 10000),
  cash_cents integer NOT NULL CHECK (cash_cents >= 0),
  used_points integer NOT NULL CHECK (used_points >= 0),
  points_cents integer NOT NULL CHECK (points_cents >= 0),
  debt_cents integer NOT NULL CHECK (debt_cents >= 0),
  balance_after integer NOT NULL,
  request_id uuid NOT NULL,
  quote_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, request_id),
  CHECK (cash_cents <= total_cents - parent_cents),
  CHECK (debt_cents = GREATEST(0, total_cents - parent_cents - cash_cents - points_cents)),
  CHECK ((used_points = 0) = (points_cents = 0))
);
CREATE INDEX child_expenses_family ON child_expenses (family_id);

-- Fecha del asiento, incluso si la transacción empezó antes de obtener el bloqueo de la cuenta.
ALTER TABLE money_ledger ALTER COLUMN created_at SET DEFAULT clock_timestamp();

ALTER TABLE money_ledger DROP CONSTRAINT money_ledger_kind_check;
ALTER TABLE money_ledger ADD CONSTRAINT money_ledger_kind_check
  CHECK (kind IN ('conversion','payment','adjustment','transfer','exchange','advance','loan','loan_repayment',
                  'interest','interest_forfeit','goal_redeem','goal_auto','goal_match','goal_gift','goal_reversal','expense'));
