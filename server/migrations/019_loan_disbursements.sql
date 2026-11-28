ALTER TABLE child_expenses ADD COLUMN currency text CHECK (currency IN ('EUR', 'USD'));
ALTER TABLE child_expenses ADD COLUMN loan_cents integer CHECK (loan_cents > 0);

CREATE TABLE loan_disbursements (
  loan_id uuid PRIMARY KEY REFERENCES loans(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  destination text NOT NULL CHECK (destination IN ('balance', 'external', 'goal', 'purchase')),
  currency text NOT NULL CHECK (currency IN ('EUR', 'USD')),
  method text CHECK (method IN ('cash', 'bizum', 'transfer')),
  goal_id uuid REFERENCES savings_goals(id) ON DELETE SET NULL,
  goal_title text,
  expense_id uuid REFERENCES child_expenses(id) ON DELETE SET NULL,
  expense_title text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((destination = 'external') = (method IS NOT NULL)),
  CHECK ((destination = 'goal') = (goal_title IS NOT NULL)),
  CHECK ((destination = 'purchase') = (expense_title IS NOT NULL))
);
CREATE INDEX loan_disbursements_family ON loan_disbursements (family_id);

ALTER TABLE money_ledger DROP CONSTRAINT money_ledger_kind_check;
ALTER TABLE money_ledger ADD CONSTRAINT money_ledger_kind_check
  CHECK (kind IN ('conversion','payment','adjustment','transfer','exchange','advance','loan','loan_delivery','loan_repayment',
                  'interest','interest_forfeit','goal_redeem','goal_auto','goal_match','goal_gift','goal_reversal','expense'));
