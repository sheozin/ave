-- ============================================================
-- LEOD — Add Operators
--
-- Run this in Supabase SQL Editor each time you need to
-- add crew members before an event.
--
-- Steps:
--   1. Go to Dashboard → Authentication → Users → "Invite user"
--      (or "Add user" → set email + temporary password)
--   2. Copy each user's UUID from the Users list
--   3. Fill in the VALUES below and run
--
-- Roles:
--   director  — full control (all transitions, delay, event edit)
--   stage     — can arm/call/go-live/hold/end sessions
--   av        — can hold sessions only
--   interp    — read-only view
--   reg       — registration read-only view
--   signage   — signage panel + display management
-- ============================================================

INSERT INTO leod_users (id, email, name, role, active)
VALUES
  -- Replace UUIDs and details with real values:
  ('00000000-0000-0000-0000-000000000001', 'director@yourcompany.com',  'Director Name',  'director', true),
  ('00000000-0000-0000-0000-000000000002', 'stage@yourcompany.com',     'Stage Manager',  'stage',    true),
  ('00000000-0000-0000-0000-000000000003', 'av@yourcompany.com',        'AV Tech',        'av',       true),
  ('00000000-0000-0000-0000-000000000004', 'interp@yourcompany.com',    'Interpreter',    'interp',   true),
  ('00000000-0000-0000-0000-000000000005', 'signage@yourcompany.com',   'Signage Op',     'signage',  true),
  ('00000000-0000-0000-0000-000000000006', 'reg@yourcompany.com',       'Registration',   'reg',      true)
ON CONFLICT (id) DO UPDATE
  SET email  = EXCLUDED.email,
      name   = EXCLUDED.name,
      role   = EXCLUDED.role,
      active = EXCLUDED.active;

-- ── To deactivate an operator (e.g. after event): ──────────
-- UPDATE leod_users SET active = false WHERE email = 'av@yourcompany.com';

-- ── To check current operators: ────────────────────────────
-- SELECT id, email, name, role, active FROM leod_users ORDER BY role, name;

-- ── To remove an operator entirely: ────────────────────────
-- DELETE FROM leod_users WHERE email = 'temp@yourcompany.com';
-- NOTE: also delete from Dashboard → Auth → Users if they should lose login access
