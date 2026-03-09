-- ── Migration 010: Track who invited each operator ───────────────
-- Nullable UUID referencing the director who sent the invite.
-- Self-registered users will have NULL (they signed up themselves).

ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS invited_by UUID REFERENCES auth.users(id);
