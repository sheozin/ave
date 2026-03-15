-- 024: Fix operator isolation — directors only see their own team
-- CRITICAL: Previously returned ALL users across the platform

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
DECLARE
  v_caller_id UUID := auth.uid();
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM leod_users WHERE leod_users.id = v_caller_id AND leod_users.role = 'director'
  ) THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;

  RETURN QUERY
  SELECT u.id, u.name, u.email, u.role, u.organization, u.active,
         a.last_sign_in_at
  FROM leod_users u
  LEFT JOIN auth.users a ON a.id = u.id
  WHERE u.id = v_caller_id          -- the director themselves
     OR u.invited_by = v_caller_id  -- operators they invited
  ORDER BY u.role, u.name;
END;
$$;
