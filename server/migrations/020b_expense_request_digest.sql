ALTER TABLE child_expenses ADD COLUMN input_digest text CHECK (input_digest ~ '^[a-f0-9]{64}$');
