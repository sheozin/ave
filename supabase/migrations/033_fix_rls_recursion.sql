-- Migration 033: Fix infinite recursion in leod_users RLS policies
-- The admin_read_all_users and admin_update_all_users policies on leod_users
-- referenced leod_users in their USING clause, causing infinite recursion.
-- Fix: use a SECURITY DEFINER helper function that bypasses RLS.

-- Step 1: Create a helper function to check admin role without triggering RLS
CREATE OR REPLACE FUNCTION is_admin()
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin'
  );
$$;

-- Step 2: Drop the recursive policies
DROP POLICY IF EXISTS admin_read_all_users ON leod_users;
DROP POLICY IF EXISTS admin_update_all_users ON leod_users;

-- Step 3: Recreate with the helper function (no recursion)
CREATE POLICY admin_read_all_users ON leod_users FOR SELECT TO authenticated
  USING (is_admin());
CREATE POLICY admin_update_all_users ON leod_users FOR UPDATE TO authenticated
  USING (is_admin());

-- Step 4: Also fix the other admin policies that reference leod_users
-- (these don't recurse but benefit from the helper for consistency)
DROP POLICY IF EXISTS admin_read_all_subs ON leod_subscriptions;
DROP POLICY IF EXISTS admin_update_all_subs ON leod_subscriptions;
CREATE POLICY admin_read_all_subs ON leod_subscriptions FOR SELECT TO authenticated
  USING (is_admin());
CREATE POLICY admin_update_all_subs ON leod_subscriptions FOR UPDATE TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS admin_read_all_promos ON leod_promo_codes;
DROP POLICY IF EXISTS admin_manage_promos ON leod_promo_codes;
CREATE POLICY admin_read_all_promos ON leod_promo_codes FOR SELECT TO authenticated
  USING (is_admin());
CREATE POLICY admin_manage_promos ON leod_promo_codes FOR ALL TO authenticated
  USING (is_admin());

DROP POLICY IF EXISTS admin_read_audit ON leod_admin_audit;
DROP POLICY IF EXISTS admin_insert_audit ON leod_admin_audit;
CREATE POLICY admin_read_audit ON leod_admin_audit FOR SELECT TO authenticated
  USING (is_admin());
CREATE POLICY admin_insert_audit ON leod_admin_audit FOR INSERT TO authenticated
  WITH CHECK (is_admin());
