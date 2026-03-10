-- ============================================================
-- CueDeck — Migration 015: Self-registration creates director
-- ============================================================
-- Self-registered users ARE the director/owner of their account.
-- Invited operators have their leod_users row pre-created by the
-- invite-operator edge function (with the assigned role), so the
-- trigger's ON CONFLICT DO NOTHING makes it a no-op for them.
--
-- Changes:
-- 1. Recreate trigger function with role = 'director' (was 'pending')
-- 2. Promote existing self-registered pending users to director
--    (invited_by IS NULL = self-registered, not invited by a director)
-- ============================================================

-- 1. Update trigger function to assign director role
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.leod_users (id, email, role, name, organization, active)
  VALUES (
    NEW.id,
    NEW.email,
    'director',
    COALESCE(NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'organization', ''),
    true
  )
  ON CONFLICT (id) DO NOTHING;  -- invited users already have their row, skip

  RETURN NEW;
END;
$$;

-- 2. Promote any self-registered pending users (invited_by IS NULL)
--    to director so they can access the console immediately.
UPDATE public.leod_users
SET role = 'director'
WHERE role = 'pending'
  AND invited_by IS NULL;
