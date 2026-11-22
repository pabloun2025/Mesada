-- I16: plan semanal de pantalla, caducidad por lotes y «Ajustes de pantalla».

-- ---------- Nuevos tipos de movimiento ----------
ALTER TABLE screen_ledger DROP CONSTRAINT IF EXISTS screen_ledger_kind_check;
ALTER TABLE screen_ledger ADD CONSTRAINT screen_ledger_kind_check
  CHECK (kind IN ('bonus','penalty','spend','adjustment','refund','task','usage','plan','expiry'));

-- ---------- Lotes de minutos ----------
-- Cada entrada de minutos es un lote con su caducidad; gastar consume primero el que caduca antes.
-- Invariante: la suma de `remaining` de un hijo es igual a la suma del libro de pantalla.
CREATE TABLE IF NOT EXISTS screen_lots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('plan','earned','refund')),
  amount integer NOT NULL CHECK (amount > 0),
  remaining integer NOT NULL CHECK (remaining >= 0),
  expires_at timestamptz NOT NULL,
  plan_week date,                 -- lunes de la semana del plan (idempotencia por hijo y semana)
  ledger_id uuid,                 -- movimiento del libro que lo creó
  ext_pause_id uuid,              -- pausa que alargó su caducidad
  ext_days integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (remaining <= amount)
);
CREATE UNIQUE INDEX IF NOT EXISTS screen_lots_plan_week ON screen_lots (user_id, plan_week) WHERE source = 'plan';
CREATE INDEX IF NOT EXISTS screen_lots_open ON screen_lots (user_id, expires_at) WHERE remaining > 0;

-- Lo que ya hay en el saldo al publicar cuenta como ganado hoy: caduca el primer lunes que cae 30 días o más
-- después (a las 00:00 de la zona de la familia).
INSERT INTO screen_lots(family_id, user_id, source, amount, remaining, expires_at)
SELECT b.family_id, b.user_id, 'earned', b.bal, b.bal,
       (((now() AT TIME ZONE b.tz)::date + 30 + ((8 - extract(isodow FROM ((now() AT TIME ZONE b.tz)::date + 30))::int) % 7))::timestamp AT TIME ZONE b.tz)
  FROM (SELECT l.family_id, l.user_id, SUM(l.delta)::int AS bal, f.timezone AS tz
          FROM screen_ledger l JOIN families f ON f.id = l.family_id GROUP BY l.family_id, l.user_id, f.timezone) b
 WHERE b.bal > 0 AND NOT EXISTS (SELECT 1 FROM screen_lots x WHERE x.user_id = b.user_id);

-- ---------- Plan semanal ----------
CREATE TABLE IF NOT EXISTS screen_plans (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  minutes_per_week integer NOT NULL DEFAULT 0 CHECK (minutes_per_week BETWEEN 0 AND 10080),
  enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- Ajustes de pantalla ----------
-- Catálogo de motivos, escritos en positivo (lo que se busca). Cada uno trae su efecto habitual.
CREATE TABLE IF NOT EXISTS screen_adjust_reasons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  effect text NOT NULL CHECK (effect IN ('minutes','pause')),
  minutes integer CHECK (minutes IS NULL OR minutes BETWEEN 1 AND 1440),
  pause_days integer CHECK (pause_days IS NULL OR pause_days BETWEEN 1 AND 30),
  archived boolean NOT NULL DEFAULT false,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((effect = 'minutes' AND minutes IS NOT NULL) OR (effect = 'pause' AND pause_days IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS screen_adjust_reasons_family ON screen_adjust_reasons (family_id, archived, position);

CREATE TABLE IF NOT EXISTS screen_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason_id uuid REFERENCES screen_adjust_reasons(id) ON DELETE SET NULL,
  reason_title text NOT NULL,                     -- copia: editar o archivar el motivo no cambia el historial
  effect text NOT NULL CHECK (effect IN ('minutes','pause')),
  minutes integer,                                -- pedidos
  applied_minutes integer NOT NULL DEFAULT 0,     -- restados de verdad (nunca por debajo de 0)
  pause_days integer,
  pause_starts_on date,
  pause_ends_on date,                             -- primer día en que ya puede gastar
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 300),
  recovery_task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,   -- trabajo extra para recuperar
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','recovered','ended')),
  recovered_minutes integer NOT NULL DEFAULT 0,
  recovery_instance_id uuid,                      -- la ocurrencia del trabajo extra que lo recuperó
  ended_at timestamptz,
  ended_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((effect = 'minutes' AND minutes IS NOT NULL) OR (effect = 'pause' AND pause_days IS NOT NULL AND pause_starts_on IS NOT NULL AND pause_ends_on IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS screen_adjustments_user ON screen_adjustments (user_id, created_at DESC);
-- Una sola pausa vigente por hijo.
CREATE UNIQUE INDEX IF NOT EXISTS screen_adjustments_one_pause ON screen_adjustments (user_id) WHERE effect = 'pause' AND status = 'active';
