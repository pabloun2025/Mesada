CREATE TABLE task_promotions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  instance_id uuid UNIQUE REFERENCES task_instances(id) ON DELETE SET NULL,
  day date NOT NULL,
  base_points integer NOT NULL CHECK (base_points > 0),
  percentage integer NOT NULL CHECK (percentage IN (30, 50)),
  extra_points integer NOT NULL CHECK (extra_points > 0),
  activated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  activated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  reserved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reserved_at timestamptz,
  granted_at timestamptz,
  UNIQUE (task_id, day)
);
CREATE INDEX task_promotions_family ON task_promotions (family_id);
