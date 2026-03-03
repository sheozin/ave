-- ============================================================
-- Migration 001 — Remove dev-only anon write policies
-- REQUIRED before any production deployment.
--
-- supabase-setup.sql creates 4 permissive anon write policies
-- (marked "testing only") that allow any unauthenticated client
-- to INSERT/UPDATE/DELETE all core tables.
--
-- This migration drops them and replaces with authenticated-only
-- write access. Identical to what auth-setup.sql does, but
-- expressed as an explicit named migration for auditability.
--
-- Run: paste into Supabase SQL Editor → Run
-- Idempotent: safe to run multiple times (DROP IF EXISTS)
-- ============================================================

-- ── 1. Drop dev-only policies ─────────────────────────────────
DROP POLICY IF EXISTS anon_write_sessions  ON leod_sessions;
DROP POLICY IF EXISTS anon_write_log       ON leod_event_log;
DROP POLICY IF EXISTS anon_write_broadcast ON leod_broadcast;
DROP POLICY IF EXISTS anon_write_clock     ON leod_clock;

-- ── 2. Ensure authenticated write policies exist ──────────────
-- (auth-setup.sql creates these; this ensures they exist
--  even if auth-setup.sql was not applied separately)

DO $$
BEGIN

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='leod_sessions' AND policyname='auth_write_sessions'
  ) THEN
    EXECUTE $p$
      CREATE POLICY auth_write_sessions ON leod_sessions
        FOR ALL TO authenticated
        USING  (auth.role() = 'authenticated')
        WITH CHECK (auth.role() = 'authenticated')
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='leod_event_log' AND policyname='auth_write_log'
  ) THEN
    EXECUTE $p$
      CREATE POLICY auth_write_log ON leod_event_log
        FOR ALL TO authenticated
        USING  (auth.role() = 'authenticated')
        WITH CHECK (auth.role() = 'authenticated')
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='leod_broadcast' AND policyname='auth_write_broadcast'
  ) THEN
    EXECUTE $p$
      CREATE POLICY auth_write_broadcast ON leod_broadcast
        FOR ALL TO authenticated
        USING  (auth.role() = 'authenticated')
        WITH CHECK (auth.role() = 'authenticated')
    $p$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename='leod_clock' AND policyname='auth_write_clock'
  ) THEN
    EXECUTE $p$
      CREATE POLICY auth_write_clock ON leod_clock
        FOR ALL TO authenticated
        USING  (auth.role() = 'authenticated')
        WITH CHECK (auth.role() = 'authenticated')
    $p$;
  END IF;

END $$;

-- ── 3. Verify ─────────────────────────────────────────────────
-- After running, confirm no anon write policies remain:
-- SELECT tablename, policyname, roles::text, cmd
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND 'anon' = ANY(roles)
--   AND cmd IN ('INSERT','UPDATE','DELETE','ALL');
-- Expected: 0 rows (only leod_signage_displays UPDATE for heartbeat is allowed)
