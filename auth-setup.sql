-- ══════════════════════════════════════════════════════════════════
-- CueDeck — Auth Setup
-- ⚠ SUPERSEDED by supabase/migrations/ (the live schema is built by the
-- numbered migrations; the access rules are 095_event_scoped_writes.sql and
-- later). Do not run this against the live project: it would
-- re-create policies the migrations replaced. Kept as a historical bootstrap only. Since 095 it no longer
-- creates the open write policies or the 'global' broadcast default.
-- Run ONCE in Supabase SQL Editor after:
--   1. Enabling Email provider in Dashboard → Auth → Providers
--   2. Running supabase-setup.sql
-- ══════════════════════════════════════════════════════════════════

-- ── 1. leod_users: maps auth.users → role ─────────────────────────
CREATE TABLE IF NOT EXISTS leod_users (
  id      UUID    PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email   TEXT    NOT NULL,
  name    TEXT,
  role    TEXT    NOT NULL DEFAULT 'reg'
          CHECK (role IN ('director','stage','av','interp','signage','reg')),
  active  BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE leod_users ENABLE ROW LEVEL SECURITY;

-- Users can only read their own row
CREATE POLICY users_read_own ON leod_users FOR SELECT USING (auth.uid() = id);


-- ── 2. Tighten write policies: anon → authenticated only ──────────
DROP POLICY IF EXISTS anon_write_sessions  ON leod_sessions;
DROP POLICY IF EXISTS anon_write_log       ON leod_event_log;
DROP POLICY IF EXISTS anon_write_broadcast ON leod_broadcast;
DROP POLICY IF EXISTS anon_write_clock     ON leod_clock;

-- The auth_write_* policies (any signed-in user writes any event) are no
-- longer created here. Write access is event-scoped:
-- supabase/migrations/095_event_scoped_writes.sql.


-- ══════════════════════════════════════════════════════════════════
-- HOW TO ADD OPERATORS
-- ══════════════════════════════════════════════════════════════════
-- 1. Create the user in Supabase Dashboard → Auth → Users
--    (or invite via email)
-- 2. Copy their UUID from the Users list
-- 3. Run this insert:
--
-- INSERT INTO leod_users (id, email, name, role)
-- VALUES
--   ('<uuid>', 'director@example.com', 'Sherif Saleh',  'director'),
--   ('<uuid>', 'stage@example.com',    'Anna Kowalska', 'stage'),
--   ('<uuid>', 'av@example.com',       'Piotr Nowak',   'av');
--
-- Roles: director | stage | av | interp | signage | reg
-- ══════════════════════════════════════════════════════════════════


-- ── TEST USER (pre-created) ────────────────────────────────────────
-- A test director account is pre-seeded below.
-- Create the auth.users entry manually in Supabase Dashboard → Auth → Users
-- using the UUID below, then run this insert.
-- Use a strong password set via the Dashboard — do NOT hardcode it here.
-- Role:     director
INSERT INTO leod_users (id, email, name, role)
VALUES ('a22cdd0f-4d86-4901-9854-c6a1b96242d1', 'director@leod.test', 'Director', 'director')
ON CONFLICT (id) DO NOTHING;
