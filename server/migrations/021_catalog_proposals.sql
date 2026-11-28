CREATE TABLE catalog_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id uuid NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('task', 'reward')),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  points integer CHECK (points BETWEEN 0 AND 1000000),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decision text CHECK (decision IN ('approve', 'edit', 'reject')),
  decision_note text CHECK (char_length(decision_note) <= 300),
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  result_id uuid,
  result_title text,
  result_description text,
  result_points integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'approved') = (result_id IS NOT NULL))
);
CREATE INDEX catalog_proposals_family_status ON catalog_proposals (family_id, status, created_at DESC);
CREATE INDEX catalog_proposals_user ON catalog_proposals (user_id, created_at DESC);
