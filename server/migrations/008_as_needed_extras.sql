-- I10 «Cuando haga falta» e I11 «Trabajos extra».

-- Periodicidad nueva: sin día ni hora fijos. Siempre disponible, una vez al día.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_recurrence_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_recurrence_check CHECK (recurrence IN ('once','daily','weekly','monthly','as_needed'));

-- Una tarea extra del catálogo es una fila de `tasks` sin asignados (nunca se materializa sola).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_extra boolean NOT NULL DEFAULT false;

-- Cada activación en el tablón es una ocurrencia: `assignee_id` NULL = libre; con valor = reservada por ese hijo.
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS is_extra boolean NOT NULL DEFAULT false;
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS extra_deadline date;     -- plazo opcional (inclusive)
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS reserved_at timestamptz;

-- I13 «Se puede repetir en el día»: por defecto una vez; si se repite, `max_per_day` (NULL = sin límite, mínimo 2).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repeatable boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS max_per_day integer CHECK (max_per_day IS NULL OR max_per_day >= 2);
-- Cada repetición es otra ocurrencia del mismo día (repeat_no 1, 2, 3…); solo la 1.ª cuenta para el % y la racha.
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS repeat_no integer NOT NULL DEFAULT 1;

-- Las extras pueden repetirse el mismo día con el mismo hijo: el índice único solo rige para las normales.
DROP INDEX IF EXISTS task_instances_unique;
CREATE UNIQUE INDEX task_instances_unique ON task_instances (task_id, due_date, COALESCE(assignee_id, '00000000-0000-0000-0000-000000000000'::uuid), repeat_no) WHERE NOT is_extra;
-- Y solo puede haber una activación abierta de cada extra a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS task_instances_extra_open ON task_instances (task_id) WHERE is_extra AND status IN ('pending','submitted','rejected');

-- I14 espera tras hacerla (solo «Cuando haga falta»): días hasta que vuelve a estar disponible. NULL = sin espera.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS cooldown_days integer CHECK (cooldown_days IS NULL OR cooldown_days >= 1);
