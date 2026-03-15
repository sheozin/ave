-- Fix infinite recursion in cms_users RLS (Postgres error 42P17).
-- The "super_admin full access" policy subqueried cms_users from within a
-- cms_users policy, triggering RLS on itself recursively.
--
-- Fix: replace the subquery with a SECURITY DEFINER function that reads
-- cms_users with RLS bypassed (safe — read-only, search_path locked).

CREATE OR REPLACE FUNCTION public.cms_current_user_role()
  RETURNS text
  LANGUAGE sql
  SECURITY DEFINER
  STABLE
  SET search_path = public
AS $$
  SELECT role FROM cms_users WHERE id = auth.uid()
$$;

-- Remove the recursive policy
DROP POLICY IF EXISTS "cms_users: super_admin full access" ON cms_users;

-- Recreate it using the helper function (no recursion)
CREATE POLICY "cms_users: super_admin full access" ON cms_users
  USING (public.cms_current_user_role() = 'super_admin');
