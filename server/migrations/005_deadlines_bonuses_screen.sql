-- I1 hora límite con valor según la hora, I2 bonos y minutos de pantalla, I3 tareas que marca un adulto.

-- ---------- Tareas ----------
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due_time_weekend time;  -- S–D y festivos; NULL = usa due_time
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS late_percent smallint NOT NULL DEFAULT 100 CHECK (late_percent BETWEEN 0 AND 100);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS check_mode boolean NOT NULL DEFAULT false;  -- la marca un adulto, no el hijo
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS penalty_minutes integer NOT NULL DEFAULT 0 CHECK (penalty_minutes BETWEEN 0 AND 1440);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS success_minutes integer NOT NULL DEFAULT 0 CHECK (success_minutes BETWEEN 0 AND 1440);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bonus_kind text CHECK (bonus_kind IN ('points','screen','text','reward'));
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bonus_points integer CHECK (bonus_points IS NULL OR bonus_points BETWEEN 1 AND 10000);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bonus_minutes integer CHECK (bonus_minutes IS NULL OR bonus_minutes BETWEEN 1 AND 1440);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bonus_text text CHECK (bonus_text IS NULL OR length(bonus_text) BETWEEN 1 AND 200);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bonus_reward_id uuid REFERENCES rewards(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bonus_surprise boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS bonus_on_time_only boolean NOT NULL DEFAULT false;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_bonus_consistent;
ALTER TABLE tasks ADD CONSTRAINT tasks_bonus_consistent CHECK (
  bonus_kind IS NULL
  OR (bonus_kind = 'points' AND bonus_points IS NOT NULL)
  OR (bonus_kind = 'screen' AND bonus_minutes IS NOT NULL)
  OR (bonus_kind = 'text' AND bonus_text IS NOT NULL)
  OR (bonus_kind = 'reward' AND bonus_reward_id IS NOT NULL)
);
-- Una tarea de comprobación la marca un adulto sobre una persona concreta: no puede ser compartida.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_check_not_shared;
ALTER TABLE tasks ADD CONSTRAINT tasks_check_not_shared CHECK (NOT check_mode OR assignment_mode <> 'shared');

-- ---------- Ocurrencias ----------
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS deadline_at timestamptz;  -- hora límite vigente al pulsar «Hecha»
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS on_time boolean;
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS check_met boolean;        -- NULL = sin decidir
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS check_seq integer NOT NULL DEFAULT 0;  -- nº de decisiones (claves de idempotencia)
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS check_penalty_applied integer NOT NULL DEFAULT 0;  -- minutos realmente restados
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS check_minutes_applied integer NOT NULL DEFAULT 0;  -- minutos de éxito concedidos

-- ---------- Festivos de la familia (usan la hora de fin de semana) ----------
CREATE TABLE IF NOT EXISTS family_holidays (
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  day date NOT NULL,
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 80),
  PRIMARY KEY (family_id, day)
);

-- ---------- Tiempo de pantalla (minutos), aparte de puntos y dinero ----------
CREATE TABLE IF NOT EXISTS screen_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('bonus','penalty','spend','adjustment','refund','task')),
  ref_id uuid,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  idempotency_key text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS screen_ledger_user ON screen_ledger (user_id, created_at);

-- El saldo nunca baja de 0, ni siquiera si alguien se salta la capa de aplicación.
-- El bloqueo asesor serializa los movimientos concurrentes de un mismo hijo.
CREATE OR REPLACE FUNCTION mesada_screen_guard() RETURNS trigger AS $$
DECLARE bal integer;
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('screen:' || NEW.user_id::text));
    IF NEW.delta < 0 THEN
      SELECT COALESCE(SUM(delta), 0) INTO bal FROM screen_ledger WHERE user_id = NEW.user_id;
      IF bal + NEW.delta < 0 THEN
        RAISE EXCEPTION 'El saldo de pantalla no puede ser negativo';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;  -- cascada al borrar familia o usuario
  RAISE EXCEPTION 'Los movimientos de pantalla no se pueden modificar';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS screen_ledger_guard ON screen_ledger;
CREATE TRIGGER screen_ledger_guard BEFORE INSERT OR UPDATE OR DELETE ON screen_ledger FOR EACH ROW EXECUTE FUNCTION mesada_screen_guard();

-- ---------- Bonos ----------
-- Una sorpresa se gana una sola vez por tarea y persona.
CREATE TABLE IF NOT EXISTS bonus_claims (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id uuid REFERENCES task_instances(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, user_id)
);

-- Bono concedido (una fila por ocurrencia). Guarda una copia del contenido: editar la tarea no lo cambia.
CREATE TABLE IF NOT EXISTS bonus_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  instance_id uuid NOT NULL UNIQUE REFERENCES task_instances(id) ON DELETE CASCADE,
  task_title text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('points','screen','text','reward')),
  points integer NOT NULL DEFAULT 0,
  minutes integer NOT NULL DEFAULT 0,
  label text NOT NULL,
  reward_id uuid REFERENCES rewards(id) ON DELETE SET NULL,
  surprise boolean NOT NULL DEFAULT false,
  revealed_at timestamptz,      -- sorpresa ya mostrada al hijo
  fulfilled_at timestamptz,     -- texto/recompensa ya cumplidos por un adulto
  fulfilled_by uuid REFERENCES users(id) ON DELETE SET NULL,
  voided_at timestamptz,        -- anulado al corregir una tarea de comprobación
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bonus_grants_family ON bonus_grants (family_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bonus_grants_user ON bonus_grants (user_id, created_at DESC);
