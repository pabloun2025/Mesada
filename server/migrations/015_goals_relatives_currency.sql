-- I19 meta de ahorro visible · I20 otros adultos, parientes y moneda (D59-D63).
-- Idempotente: se puede volver a ejecutar sin efecto.

-- ---------- Moneda por familia (solo símbolo y formato; no convierte importes) ----------
UPDATE families SET currency = 'EUR' WHERE currency NOT IN ('EUR', 'USD');
ALTER TABLE families DROP CONSTRAINT IF EXISTS families_currency_check;
ALTER TABLE families ADD CONSTRAINT families_currency_check CHECK (currency IN ('EUR', 'USD'));

-- ---------- Parentesco, cuenta principal y parientes ----------
-- Madre, padre, pareja y tutor/a legal son adultos completos. Abuelo/a, tío/a y otro son «parientes» (ver y animar).
-- Un parentesco vacío en un adulto anterior a esta migración sigue siendo adulto completo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS relationship text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS relationship_label text;
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_relationship_check;
ALTER TABLE users ADD CONSTRAINT users_relationship_check
  CHECK (relationship IS NULL OR relationship IN ('mother','father','partner','guardian','grandparent','aunt_uncle','other'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_relationship_adult;
ALTER TABLE users ADD CONSTRAINT users_relationship_adult CHECK (role = 'adult' OR relationship IS NULL);
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_principal boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_relative boolean GENERATED ALWAYS AS (COALESCE(relationship IN ('grandparent','aunt_uncle','other'), false)) STORED;

-- La cuenta principal es la que creó la familia: el primer adulto de cada una.
UPDATE users u SET is_principal = true
 WHERE u.role = 'adult'
   AND u.id = (SELECT x.id FROM users x WHERE x.family_id = u.family_id AND x.role = 'adult' ORDER BY x.created_at, x.id LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM users y WHERE y.family_id = u.family_id AND y.is_principal);
CREATE UNIQUE INDEX IF NOT EXISTS users_one_principal ON users (family_id) WHERE is_principal;

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS relationship text;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS relationship_label text;
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');

-- Felicitaciones de adultos y parientes a un hijo (mensaje corto).
CREATE TABLE IF NOT EXISTS cheers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 140),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cheers_from ON cheers (from_user_id, created_at DESC);

-- ---------- Meta de ahorro: propuesta, foto o emoji, ahorro automático y aporte de los padres ----------
ALTER TABLE savings_goals DROP CONSTRAINT IF EXISTS savings_goals_status_check;
ALTER TABLE savings_goals ADD CONSTRAINT savings_goals_status_check CHECK (status IN ('proposed','active','bought','cashed_out','rejected'));
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS emoji text;
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS photo_path text;
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS proposed_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS proposed_title text;           -- lo que escribió el hijo, si el adulto lo cambia
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS proposed_target_cents integer;
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS decided_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS decided_at timestamptz;
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS decision_note text NOT NULL DEFAULT '';
-- % de cada cierre que va solo a la meta; el del hijo espera aprobación en auto_pending_percent.
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS auto_percent integer NOT NULL DEFAULT 0 CHECK (auto_percent BETWEEN 0 AND 100);
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS auto_pending_percent integer CHECK (auto_pending_percent BETWEEN 1 AND 100);
-- Aporte de los padres: «give» por cada «per» ahorrado, hasta un tope total.
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS match_per_cents integer CHECK (match_per_cents > 0);
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS match_gives_cents integer CHECK (match_gives_cents > 0);
ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS match_cap_cents integer CHECK (match_cap_cents > 0);

ALTER TABLE money_ledger DROP CONSTRAINT IF EXISTS money_ledger_kind_check;
ALTER TABLE money_ledger ADD CONSTRAINT money_ledger_kind_check
  CHECK (kind IN ('conversion','payment','adjustment','transfer','exchange','advance','loan','loan_repayment','interest','interest_forfeit','goal_redeem',
                  'goal_auto','goal_match','goal_gift','goal_reversal'));
