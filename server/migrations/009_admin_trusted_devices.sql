-- I9: Administración recuerda el dispositivo 90 días tras un código correcto.
-- Solo se guarda el hash (sha256) del token; el token vive en una cookie httpOnly del navegador.
CREATE TABLE IF NOT EXISTS admin_trusted_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  user_agent text
);
CREATE INDEX IF NOT EXISTS admin_trusted_devices_user ON admin_trusted_devices (user_id);
