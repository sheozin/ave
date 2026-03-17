-- ============================================================
-- CueDeck — Migration 028: Admin self-check RPC
-- Fixes recursive RLS on leod_users for admin login
-- ============================================================

-- SECURITY DEFINER bypasses RLS, so the admin can read their own row
CREATE OR REPLACE FUNCTION get_my_profile()
RETURNS TABLE (
  id UUID,
  email TEXT,
  name TEXT,
  role TEXT,
  active BOOLEAN,
  organization TEXT,
  invited_by UUID,
  phone TEXT,
  company_name TEXT,
  vat_id TEXT,
  billing_address TEXT
) LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN QUERY
  SELECT u.id, u.email, u.name, u.role, u.active, u.organization,
         u.invited_by, u.phone, u.company_name, u.vat_id, u.billing_address
  FROM leod_users u
  WHERE u.id = auth.uid();
END;
$$;
