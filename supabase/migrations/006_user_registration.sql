-- ============================================================
-- CueDeck — Migration 003: Self-Registration Support
-- Run this in Supabase SQL Editor
-- ============================================================

-- ── 1. leod_config table (invite code + future config) ─────
CREATE TABLE IF NOT EXISTS leod_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Default invite code — change this after applying the migration
INSERT INTO leod_config (key, value) VALUES ('signup_code', 'LEOD2026')
  ON CONFLICT DO NOTHING;

ALTER TABLE leod_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "anon_read_config"
  ON leod_config FOR SELECT TO anon USING (true);

CREATE POLICY "auth_all_config"
  ON leod_config FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 2. Add 'pending' to leod_users role constraint ─────────
-- Finds the role CHECK constraint by name pattern and recreates it
-- with 'pending' included. Safe to run even if no constraint exists.
DO $$
DECLARE v_con TEXT;
BEGIN
  SELECT conname INTO v_con
  FROM pg_constraint
  WHERE conrelid = 'leod_users'::regclass
    AND contype  = 'c'
    AND conname  ILIKE '%role%';

  IF v_con IS NOT NULL THEN
    EXECUTE format('ALTER TABLE leod_users DROP CONSTRAINT %I', v_con);
  END IF;

  ALTER TABLE leod_users DROP CONSTRAINT IF EXISTS leod_users_role_check;
  ALTER TABLE leod_users ADD CONSTRAINT leod_users_role_check
    CHECK (role IN ('director','stage','av','interp','reg','signage','pending'));
END $$;

-- ── 3. Allow authenticated users to insert their own pending row ──
-- Users can only insert a row for themselves (id = auth.uid()) with role = 'pending'
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'leod_users'
      AND policyname = 'auth_insert_own_pending'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "auth_insert_own_pending"
        ON leod_users FOR INSERT TO authenticated
        WITH CHECK (id = auth.uid() AND role = 'pending')
    $policy$;
  END IF;
END $$;
