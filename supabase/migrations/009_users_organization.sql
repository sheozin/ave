-- ── Add organization column to leod_users ─────────────────
-- Stores the company/organization name provided during registration.
-- Used by directors when reviewing pending account requests.

ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS organization TEXT;
