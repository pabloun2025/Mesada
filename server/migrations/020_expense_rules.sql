CREATE TABLE expense_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  type text NOT NULL CHECK (type IN ('amount', 'percent')),
  cents integer CHECK (cents BETWEEN 0 AND 10000000),
  basis_points integer CHECK (basis_points BETWEEN 0 AND 10000),
  currency text CHECK (currency IN ('EUR', 'USD')),
  archived_at timestamptz,
  CHECK ((type = 'percent' AND basis_points IS NOT NULL AND cents IS NULL AND currency IS NULL)
      OR (type = 'amount' AND cents IS NOT NULL AND basis_points IS NULL AND currency IS NOT NULL))
);
CREATE INDEX expense_rules_active ON expense_rules (family_id, title) WHERE archived_at IS NULL;

ALTER TABLE child_expenses ADD COLUMN rule_snapshot jsonb;
