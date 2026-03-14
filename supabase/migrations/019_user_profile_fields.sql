-- ============================================================
-- CueDeck — Migration 019: User Profile Fields
-- Run this in Supabase SQL Editor
-- ============================================================

-- 1. Add new columns to leod_users
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS company_name TEXT;
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS vat_id TEXT;
ALTER TABLE leod_users ADD COLUMN IF NOT EXISTS billing_address TEXT;

-- 2. RLS: Users can update their own row
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'leod_users'
      AND policyname = 'auth_update_own_profile'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "auth_update_own_profile"
        ON leod_users FOR UPDATE TO authenticated
        USING (id = auth.uid())
        WITH CHECK (id = auth.uid())
    $policy$;
  END IF;
END $$;

-- 3. RPC: get_operators_with_last_seen
CREATE OR REPLACE FUNCTION get_operators_with_last_seen()
RETURNS TABLE (
  id UUID,
  name TEXT,
  email TEXT,
  role TEXT,
  organization TEXT,
  active BOOLEAN,
  last_sign_in_at TIMESTAMPTZ
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM leod_users WHERE leod_users.id = auth.uid() AND leod_users.role = 'director'
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  SELECT u.id, u.name, u.email, u.role, u.organization, u.active,
         a.last_sign_in_at
  FROM leod_users u
  LEFT JOIN auth.users a ON a.id = u.id
  ORDER BY u.role, u.name;
END;
$$;
