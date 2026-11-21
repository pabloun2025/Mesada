-- I4 pagos desde el Panel y peticiones del hijo, I5 el hijo anota su uso de pantalla.

-- ---------- Categoría de pantalla y nuevo tipo de movimiento ----------
-- Un solo saldo de minutos; la categoría solo describe en qué se gastó (NULL en filas antiguas y en bonos/penalizaciones).
ALTER TABLE screen_ledger ADD COLUMN IF NOT EXISTS category text;
ALTER TABLE screen_ledger DROP CONSTRAINT IF EXISTS screen_ledger_category_check;
ALTER TABLE screen_ledger ADD CONSTRAINT screen_ledger_category_check
  CHECK (category IS NULL OR category IN ('videojuegos','tele','tablet','movil','ordenador','otro'));
ALTER TABLE screen_ledger DROP CONSTRAINT IF EXISTS screen_ledger_kind_check;
ALTER TABLE screen_ledger ADD CONSTRAINT screen_ledger_kind_check
  CHECK (kind IN ('bonus','penalty','spend','adjustment','refund','task','usage'));

-- ---------- Peticiones del hijo (dinero o pantalla) ----------
CREATE TABLE IF NOT EXISTS payout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('money','screen')),
  amount_cents integer CHECK (amount_cents IS NULL OR amount_cents > 0),
  minutes integer CHECK (minutes IS NULL OR minutes > 0),
  category text CHECK (category IS NULL OR category IN ('videojuegos','tele','tablet','movil','ordenador','otro')),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  -- Lo que se concedió de verdad (puede ser menos de lo pedido si el saldo bajó).
  granted_cents integer,
  granted_minutes integer,
  method text CHECK (method IS NULL OR method IN ('cash','transfer','bizum','other')),
  payment_id uuid REFERENCES payments(id) ON DELETE SET NULL,
  decision_note text NOT NULL DEFAULT '',
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'money' AND amount_cents IS NOT NULL) OR (kind = 'screen' AND minutes IS NOT NULL AND category IS NOT NULL))
);
-- Una sola petición abierta por hijo y tipo.
CREATE UNIQUE INDEX IF NOT EXISTS payout_requests_one_pending ON payout_requests (user_id, kind) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS payout_requests_family ON payout_requests (family_id, status, created_at DESC);

-- ---------- Uso de pantalla anotado por el hijo ----------
CREATE TABLE IF NOT EXISTS screen_usage_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,                       -- día en la zona horaria de la familia
  minutes integer NOT NULL CHECK (minutes BETWEEN 1 AND 720),
  applied_minutes integer NOT NULL CHECK (applied_minutes >= 0),
  overflow_minutes integer NOT NULL CHECK (overflow_minutes >= 0),
  category text NOT NULL CHECK (category IN ('videojuegos','tele','tablet','movil','ordenador','otro')),
  note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','voided')),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (applied_minutes + overflow_minutes = minutes)
);
CREATE INDEX IF NOT EXISTS screen_usage_logs_user_day ON screen_usage_logs (user_id, day);
CREATE INDEX IF NOT EXISTS screen_usage_logs_family ON screen_usage_logs (family_id, status, created_at DESC);

-- Puntos de honestidad: una fila por hijo y día. `grants` cuenta las concesiones (para claves de idempotencia
-- distintas si se conceden, se compensan y se vuelven a conceder); `granted` es el estado vigente.
CREATE TABLE IF NOT EXISTS honesty_days (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day date NOT NULL,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  grants integer NOT NULL DEFAULT 0,
  granted boolean NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, day)
);
