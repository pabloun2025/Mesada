-- Los libros de puntos y dinero son inmutables: no se pueden borrar movimientos ni cambiar importes.
-- Las correcciones se hacen con nuevos movimientos (ajustes), que quedan auditados.
CREATE OR REPLACE FUNCTION mesada_ledger_guard() RETURNS trigger AS $$
BEGIN
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

CREATE TRIGGER points_ledger_guard BEFORE UPDATE OR DELETE ON points_ledger FOR EACH ROW EXECUTE FUNCTION mesada_ledger_guard();
CREATE TRIGGER money_ledger_guard BEFORE UPDATE OR DELETE ON money_ledger FOR EACH ROW EXECUTE FUNCTION mesada_ledger_guard();
CREATE TRIGGER payments_guard BEFORE DELETE ON payments FOR EACH ROW EXECUTE FUNCTION mesada_ledger_guard();
CREATE TRIGGER settlements_guard BEFORE DELETE ON settlements FOR EACH ROW EXECUTE FUNCTION mesada_ledger_guard();
CREATE TRIGGER audit_log_guard BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION mesada_ledger_guard();
