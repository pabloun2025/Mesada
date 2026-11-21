-- Administración de la instalación (superadmin) con verificación en dos pasos (TOTP).
-- Sin acceso a puntos ni dinero de las familias: solo cuentas, bloqueos, ajustes y estado.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret text;          -- cifrado (AES-256-GCM)
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending text;         -- alta en curso, cifrado
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_counter bigint;  -- evita reutilizar un código
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz;

ALTER TABLE families ADD COLUMN IF NOT EXISTS blocked_at timestamptz;
ALTER TABLE families ADD COLUMN IF NOT EXISTS blocked_reason text;

-- Momento en que esta sesión pasó la verificación en dos pasos (caduca a las 12 h).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS admin_verified_at timestamptz;

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  used_at timestamptz
);
CREATE INDEX IF NOT EXISTS admin_recovery_user ON admin_recovery_codes (user_id);

CREATE TABLE IF NOT EXISTS install_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS admin_audit (
  id bigserial PRIMARY KEY,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  family_id uuid REFERENCES families(id) ON DELETE SET NULL,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit (created_at DESC);

-- El adulto que creó la primera familia es el administrador inicial.
UPDATE users SET is_superadmin = true
 WHERE id = (
   SELECT u.id FROM users u JOIN families f ON f.id = u.family_id
    WHERE u.role = 'adult'
    ORDER BY f.created_at, u.created_at
    LIMIT 1
 )
 AND NOT EXISTS (SELECT 1 FROM users WHERE is_superadmin);
