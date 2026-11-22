-- Privacidad, borrado de datos, protección ante abusos y registro de errores (D48-D54).

-- 1) Consentimiento: versión del texto legal y momento en que lo aceptó el adulto (en nombre propio y de los menores a su cargo).
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;

-- 2) Insignias: se anota qué tarea las concedió para poder retirarlas si esa tarea se desmarca (D42 cambia).
ALTER TABLE user_badges ADD COLUMN IF NOT EXISTS source_instance_id uuid REFERENCES task_instances(id) ON DELETE SET NULL;

-- 3) Errores 5xx del servidor, con el código que ve la persona usuaria. Sin datos personales: método, ruta sin parámetros y mensaje.
CREATE TABLE IF NOT EXISTS server_errors (
  id text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  method text NOT NULL,
  route text NOT NULL,
  status integer NOT NULL,
  message text,
  stack text
);
CREATE INDEX IF NOT EXISTS server_errors_created ON server_errors (created_at DESC);

-- 4) Borrado completo de una familia o de un hijo: los libros y el historial son inmutables, salvo para este borrado.
--    Quien borra activa `SET LOCAL mesada.erasure = 'on'` dentro de su transacción; sin eso, todo sigue protegido.
CREATE OR REPLACE FUNCTION mesada_ledger_guard() RETURNS trigger AS $$
BEGIN
  IF current_setting('mesada.erasure', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    -- Solo se permite como efecto de borrar la familia o el usuario completos (cascada).
    IF pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'Los movimientos de % no se pueden borrar', TG_TABLE_NAME;
  END IF;
  -- IF anidados: plpgsql no cortocircuita y fallaría al leer columnas de otra tabla.
  IF TG_TABLE_NAME = 'points_ledger' THEN
    IF NEW.delta <> OLD.delta OR NEW.user_id <> OLD.user_id OR NEW.kind <> OLD.kind THEN
      RAISE EXCEPTION 'Los movimientos de puntos no se pueden modificar';
    END IF;
  ELSIF TG_TABLE_NAME = 'money_ledger' THEN
    IF NEW.delta_cents <> OLD.delta_cents OR NEW.user_id <> OLD.user_id OR NEW.account <> OLD.account OR NEW.kind <> OLD.kind THEN
      RAISE EXCEPTION 'Los movimientos de dinero no se pueden modificar';
    END IF;
  ELSIF TG_TABLE_NAME = 'audit_log' THEN
    RAISE EXCEPTION 'El historial no se puede modificar';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION mesada_screen_guard() RETURNS trigger AS $$
DECLARE bal integer;
BEGIN
  IF current_setting('mesada.erasure', true) = 'on' AND TG_OP <> 'INSERT' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
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
