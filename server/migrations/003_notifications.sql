-- Notificaciones multicanal (aplicación, correo y WhatsApp), recuperación de contraseña e invitaciones.

-- Datos de contacto. Opcionales: los hijos no necesitan correo.
ALTER TABLE users ADD COLUMN email text;
ALTER TABLE users ADD COLUMN phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$');
ALTER TABLE users ADD COLUMN whatsapp_consent_at timestamptz;
CREATE UNIQUE INDEX users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

-- Horarios de la familia: silencio y recordatorios.
ALTER TABLE families ADD COLUMN quiet_start time NOT NULL DEFAULT '21:30';
ALTER TABLE families ADD COLUMN quiet_end time NOT NULL DEFAULT '08:00';
ALTER TABLE families ADD COLUMN reminder_time time NOT NULL DEFAULT '17:30';
ALTER TABLE families ADD COLUMN due_soon_minutes integer NOT NULL DEFAULT 60 CHECK (due_soon_minutes BETWEEN 0 AND 720);

-- Preferencias explícitas (lo que no está aquí usa el valor por defecto del evento).
CREATE TABLE notification_prefs (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp')),
  enabled boolean NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, event, channel)
);

-- Cola de salida transaccional: se escribe en la misma transacción que la acción que la origina.
CREATE TABLE notification_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  to_address text,               -- correo o teléfono; para destinatarios sin cuenta (invitaciones) o fijado al encolar
  event text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','whatsapp')),
  subject text NOT NULL,
  body text NOT NULL,
  link text,
  critical boolean NOT NULL DEFAULT false,   -- ignora horario de silencio (p. ej. recuperar contraseña)
  dedupe_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','failed','skipped','uncertain')),
  attempts integer NOT NULL DEFAULT 0,
  not_before timestamptz NOT NULL DEFAULT now(),
  provider text,
  external_id text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX notification_outbox_due ON notification_outbox (not_before) WHERE status = 'pending';
CREATE INDEX notification_outbox_family ON notification_outbox (family_id, created_at DESC);

-- Contador de envíos por canal y periodo (tope mensual de correo y diario de WhatsApp de la instalación).
CREATE TABLE notification_usage (
  channel text NOT NULL,
  period text NOT NULL,
  sent integer NOT NULL DEFAULT 0,
  PRIMARY KEY (channel, period)
);

CREATE TABLE password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  email text NOT NULL,
  display_name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  accepted_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
