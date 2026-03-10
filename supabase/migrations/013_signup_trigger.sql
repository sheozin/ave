-- ============================================================
-- CueDeck — Migration 013: Auto-create leod_users on signup
-- ============================================================
-- Root cause fix: signUp() with email confirmation returns no
-- session, so the client-side leod_users INSERT runs as anon
-- (blocked by RLS). A SECURITY DEFINER trigger runs as the
-- function owner (superuser), bypassing RLS entirely.
--
-- name and organization are passed via raw_user_meta_data when
-- calling sb.auth.signUp({ options: { data: { name, organization } } })
-- ============================================================

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
    'pending',
    COALESCE(NEW.raw_user_meta_data->>'name', ''),
    COALESCE(NEW.raw_user_meta_data->>'organization', ''),
    true
  )
  ON CONFLICT (id) DO NOTHING;  -- safe if row already exists (e.g. invited users)

  RETURN NEW;
END;
$$;

-- Drop if exists first (safe re-run)
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_auth_user();
