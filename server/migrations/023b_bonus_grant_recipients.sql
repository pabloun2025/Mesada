ALTER TABLE bonus_grants DROP CONSTRAINT bonus_grants_instance_id_key;
ALTER TABLE bonus_grants ADD CONSTRAINT bonus_grants_instance_recipient UNIQUE (instance_id, user_id);
CREATE UNIQUE INDEX bonus_grants_active_instance ON bonus_grants (instance_id) WHERE voided_at IS NULL;
