-- I17: desmarcar una tarea marcada por error.
-- Cuántas veces se ha desmarcado: las claves de idempotencia de puntos y bonos llevan este contador,
-- para que volver a marcarla conceda otra vez (y no choque con la clave de la primera vez).
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS unmark_count integer NOT NULL DEFAULT 0;
-- Si un adulto la devolvió para repasar, al desmarcar el reenvío vuelve a «devuelta» (no a limpia) y conserva
-- la primera hora de envío: la devolución fue una decisión real del adulto, no un error del hijo.
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS returned_at timestamptz;
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS returned_note text;

-- Puntos de toda la vida (niveles): un movimiento que deshace lo ganado (corrección, desmarcar, honestidad anulada)
-- resta de ese total. Se marca con esta columna; antes solo contaban los positivos de tarea y bono.
ALTER TABLE points_ledger ADD COLUMN IF NOT EXISTS reverses_earning boolean NOT NULL DEFAULT false;
UPDATE points_ledger SET reverses_earning = true
 WHERE NOT reverses_earning AND kind = 'adjustment'
   AND (idempotency_key LIKE 'honesty-rev:%' OR idempotency_key LIKE 'task-rev:%' OR idempotency_key LIKE 'bonus-rev:%');
