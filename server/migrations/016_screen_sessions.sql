-- I21: temporizador de pantalla, días de uso, castigos con retos y tiempo extra.

-- ---------- Nuevo tipo de movimiento: lo usado en una sesión ----------
ALTER TABLE screen_ledger DROP CONSTRAINT IF EXISTS screen_ledger_kind_check;
ALTER TABLE screen_ledger ADD CONSTRAINT screen_ledger_kind_check
  CHECK (kind IN ('bonus','penalty','spend','adjustment','refund','task','usage','plan','expiry','session'));

-- ---------- Días de uso y aprobación (por hijo, junto al plan semanal) ----------
-- allowed_days: 1 = lunes … 7 = domingo. day_max: tope de minutos por día, p. ej. {"1":30,"2":30} (sin clave = sin tope).
ALTER TABLE screen_plans ADD COLUMN IF NOT EXISTS allowed_days smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}';
ALTER TABLE screen_plans ADD COLUMN IF NOT EXISTS day_max jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE screen_plans ADD COLUMN IF NOT EXISTS require_approval boolean NOT NULL DEFAULT false;

-- ---------- Tasa del tiempo extra pagado con puntos o dinero (por cada 15 minutos) ----------
-- Por defecto 15 min = 10 puntos o 0,25 (en la moneda de la familia). Se cambia en Ajustes de pantalla.
ALTER TABLE families ADD COLUMN IF NOT EXISTS screen_points_per_15 integer NOT NULL DEFAULT 10 CHECK (screen_points_per_15 BETWEEN 1 AND 1000);
ALTER TABLE families ADD COLUMN IF NOT EXISTS screen_cents_per_15 integer NOT NULL DEFAULT 25 CHECK (screen_cents_per_15 BETWEEN 1 AND 10000);

-- ---------- Sesiones de pantalla (el temporizador vive aquí, no en el móvil) ----------
CREATE TABLE IF NOT EXISTS screen_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'timer' CHECK (kind IN ('timer','charge')),      -- charge = «Dar minutos»: se descuentan al instante, sin temporizador
  status text NOT NULL CHECK (status IN ('pending','running','finished','rejected','cancelled')),
  category text CHECK (category IS NULL OR category IN ('videojuegos','tele','tablet','movil','ordenador','otro')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 200),
  requested_minutes integer NOT NULL CHECK (requested_minutes BETWEEN 1 AND 720),
  extended_minutes integer NOT NULL DEFAULT 0,
  day date NOT NULL,                                  -- día civil de la familia en que se pidió
  extra boolean NOT NULL DEFAULT false,               -- tiempo extra: no cuenta para los días ni los topes
  started_at timestamptz,
  planned_end_at timestamptz,
  ended_at timestamptz,
  started_by uuid REFERENCES users(id) ON DELETE SET NULL,
  stopped_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT '',
  end_reason text CHECK (end_reason IS NULL OR end_reason IN ('stopped','expired','charge','blocked')),
  used_minutes integer NOT NULL DEFAULT 0,
  charged_minutes integer NOT NULL DEFAULT 0,         -- descontados de las baterías
  shortfall_mode text NOT NULL DEFAULT 'debt' CHECK (shortfall_mode IN ('debt','points','money')),
  shortfall_minutes integer NOT NULL DEFAULT 0,       -- lo que las baterías no cubrían
  paid_points integer NOT NULL DEFAULT 0,
  paid_cents integer NOT NULL DEFAULT 0,
  overrun_minutes integer NOT NULL DEFAULT 0,         -- lo anotado de más (va a la semana siguiente)
  warned_at timestamptz,
  end_notified_at timestamptz,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Un hijo solo tiene un temporizador abierto (esperando permiso o en marcha) y una sola petición de minutos extra esperando.
CREATE UNIQUE INDEX IF NOT EXISTS screen_sessions_one_open ON screen_sessions (user_id) WHERE kind = 'timer' AND status IN ('pending','running');
CREATE UNIQUE INDEX IF NOT EXISTS screen_sessions_one_pending_charge ON screen_sessions (user_id) WHERE kind = 'charge' AND status = 'pending';
CREATE INDEX IF NOT EXISTS screen_sessions_user ON screen_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS screen_sessions_due ON screen_sessions (planned_end_at) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS screen_sessions_family ON screen_sessions (family_id, status);

-- ---------- Exceso que se descuenta de la semana siguiente ----------
CREATE TABLE IF NOT EXISTS screen_debts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id uuid REFERENCES screen_sessions(id) ON DELETE SET NULL,
  minutes integer NOT NULL CHECK (minutes > 0),
  remaining integer NOT NULL CHECK (remaining >= 0),
  reason text NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX IF NOT EXISTS screen_debts_open ON screen_debts (user_id) WHERE remaining > 0;

-- ---------- Castigos: bloquear días o una franja horaria, con reto opcional ----------
CREATE TABLE IF NOT EXISTS screen_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('days','window')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  starts_on date NOT NULL,
  ends_on date NOT NULL,                              -- último día bloqueado (incluido)
  window_start time,
  window_end time,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','lifted')),
  challenge_text text CHECK (challenge_text IS NULL OR length(challenge_text) BETWEEN 1 AND 300),
  challenge_photo boolean NOT NULL DEFAULT false,     -- el adulto pide foto como prueba
  challenge_effect text CHECK (challenge_effect IS NULL OR challenge_effect IN ('lift','shorten')),
  challenge_days integer CHECK (challenge_days IS NULL OR challenge_days BETWEEN 1 AND 30),
  challenge_status text CHECK (challenge_status IS NULL OR challenge_status IN ('open','submitted','approved','rejected')),
  challenge_note text NOT NULL DEFAULT '',
  challenge_photo_path text,
  challenge_done_at timestamptz,
  challenge_decided_at timestamptz,
  challenge_decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  lifted_by uuid REFERENCES users(id) ON DELETE SET NULL,
  CHECK (ends_on >= starts_on),
  CHECK ((kind = 'window' AND window_start IS NOT NULL AND window_end IS NOT NULL AND window_start < window_end) OR (kind = 'days' AND window_start IS NULL AND window_end IS NULL))
);
CREATE INDEX IF NOT EXISTS screen_blocks_user ON screen_blocks (user_id, status, ends_on);
