-- I15: revisar una tarea (parcial, devolver, rechazar sin penalidad o con penalidad).
-- Rechazo definitivo = estado nuevo 'declined'; «devolver» reutiliza 'rejected' (el hijo puede volver a enviarla).
ALTER TABLE task_instances DROP CONSTRAINT IF EXISTS task_instances_status_check;
ALTER TABLE task_instances ADD CONSTRAINT task_instances_status_check CHECK (status IN ('pending','submitted','approved','rejected','expired','declined'));
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS review_outcome text CHECK (review_outcome IN ('approved','partial','returned','declined','penalized'));
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS penalty_points integer NOT NULL DEFAULT 0;   -- puntos restados al rechazar
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS penalty_screen integer NOT NULL DEFAULT 0;   -- minutos realmente restados
-- Primera vez que el hijo la envió: la hora límite se juzga siempre con ese momento, aunque la devuelvan y la reenvíe.
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS first_submitted_at timestamptz;
UPDATE task_instances SET first_submitted_at = completed_at WHERE first_submitted_at IS NULL AND completed_at IS NOT NULL;
