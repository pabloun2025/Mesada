ALTER TABLE tasks ADD COLUMN bonus_allow_swap boolean NOT NULL DEFAULT false;
ALTER TABLE rewards ADD COLUMN swap_eligible boolean NOT NULL DEFAULT false;

ALTER TABLE bonus_grants
  ADD COLUMN swap_allowed boolean NOT NULL DEFAULT false,
  ADD COLUMN original_reward_id uuid REFERENCES rewards(id) ON DELETE SET NULL,
  ADD COLUMN original_reward_title text,
  ADD COLUMN original_reward_cost integer CHECK (original_reward_cost > 0),
  ADD COLUMN swapped_at timestamptz;

CREATE INDEX rewards_swap_candidates ON rewards (family_id, cost_points) WHERE active AND swap_eligible;
