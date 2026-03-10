-- ============================================================
-- CueDeck — Migration 014: Backfill missing leod_users rows
-- ============================================================
-- Some users may have completed auth signup but their leod_users
-- row was never created (profile setup failed error).
-- This backfills pending rows for any auth.users not yet in leod_users.
-- Safe to run multiple times (ON CONFLICT DO NOTHING).
-- ============================================================

INSERT INTO public.leod_users (id, email, role, name, organization, active)
SELECT
  u.id,
  u.email,
  'pending',
  COALESCE(u.raw_user_meta_data->>'name', ''),
  COALESCE(u.raw_user_meta_data->>'organization', ''),
  true
FROM auth.users u
LEFT JOIN public.leod_users lu ON lu.id = u.id
WHERE lu.id IS NULL
  AND u.email IS NOT NULL
ON CONFLICT (id) DO NOTHING;
