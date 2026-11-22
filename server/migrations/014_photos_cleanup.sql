-- Fotos de evidencia: se borran 7 días después de validar la tarea (D56). Se anota cuándo, para decir «Foto ya borrada».
ALTER TABLE task_instances ADD COLUMN IF NOT EXISTS photo_deleted_at timestamptz;
-- Para la limpieza nocturna y la búsqueda de familias inactivas.
CREATE INDEX IF NOT EXISTS task_instances_photo_expiry ON task_instances (reviewed_at) WHERE photo_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_created ON notifications (created_at);
CREATE INDEX IF NOT EXISTS notification_outbox_created ON notification_outbox (created_at);
