-- ============================================================
-- CueDeck Migration 132: event teams, part 3 (the guard)
-- ============================================================
-- Spec §3: a guard fails if any policy or function outside the resolver
-- reads invited_by for access, so a new copy of the old membership rule
-- cannot creep back in. Same shape as checkin_guard_results(); kept in its
-- own function because checkin_guard_results() belongs to the check-in
-- work, whose migrations replace its whole body.
-- Every guard is written by exclusion and fails on an empty or missing
-- input rather than passing on nothing.
-- ============================================================

CREATE OR REPLACE FUNCTION public.cuedeck_guard_results()
RETURNS TABLE(guard text, ok boolean, detail text, checked_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_ok     boolean;
  v_detail text;
  v_bad    text[];
  v_n      int;
BEGIN
  -- T1 (132): no access path outside the resolver reads invited_by. Every
  -- policy and every function in public whose text mentions it fails,
  -- except these, none of which decides access:
  --   policy leod_users.auth_insert_own_pending  pins invited_by IS NULL on a self-insert
  --   admin_list_users             shows it on the admin screen
  --   get_my_profile               returns the caller's own profile fields
  --   leod_users_guard_privileged  refuses changes to it
  --   log_user_signup              copies it into the signup audit row
  --   cuedeck_guard_results        this function (it names the column)
  -- leod_event_members.invited_by (who added a person) is the same word and
  -- is held to the same rule: nothing reads it for access.
  BEGIN
    SELECT array_agg(c.relname || '.' || p.polname ORDER BY c.relname, p.polname) INTO v_bad
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND (coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' '
            || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '')) LIKE '%invited_by%'
       AND NOT (c.relname = 'leod_users' AND p.polname = 'auth_insert_own_pending');
    SELECT coalesce(v_bad, '{}') || coalesce(array_agg(p.proname || '()' ORDER BY p.proname), '{}') INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosrc LIKE '%invited_by%'
       AND p.proname NOT IN ('admin_list_users', 'get_my_profile', 'leod_users_guard_privileged',
                             'log_user_signup', 'cuedeck_guard_results');
    v_n := coalesce(cardinality(v_bad), 0);
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
                    WHERE ns.nspname = 'public' AND p.proname = 'cuedeck_event_role') THEN
      v_ok := false;
      v_detail := 'cuedeck_event_role not found: the resolver this guard protects is missing';
    ELSE
      v_ok := v_n = 0;
      v_detail := CASE WHEN v_n = 0 THEN 'no policy or function outside the resolver reads invited_by'
                       ELSE v_n || ' read invited_by: ' || array_to_string(v_bad, ', ') END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'event_access_not_via_invited_by'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- T2 (132): memberships are written only by the server (invite-operator,
  -- manage-operator). RLS on, no client INSERT/UPDATE/DELETE privilege, no
  -- write policy, anon has nothing. A missing table is a failure.
  BEGIN
    IF to_regclass('public.leod_event_members') IS NULL THEN
      v_ok := false; v_detail := 'leod_event_members not found';
    ELSE
      v_bad := ARRAY[]::text[];
      IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.leod_event_members'::regclass) THEN
        v_bad := v_bad || 'RLS off'::text;
      END IF;
      IF has_table_privilege('authenticated', 'public.leod_event_members', 'INSERT')
         OR has_table_privilege('authenticated', 'public.leod_event_members', 'UPDATE')
         OR has_table_privilege('authenticated', 'public.leod_event_members', 'DELETE') THEN
        v_bad := v_bad || 'authenticated may write'::text;
      END IF;
      IF has_table_privilege('anon', 'public.leod_event_members', 'SELECT')
         OR has_table_privilege('anon', 'public.leod_event_members', 'INSERT')
         OR has_table_privilege('anon', 'public.leod_event_members', 'UPDATE')
         OR has_table_privilege('anon', 'public.leod_event_members', 'DELETE') THEN
        v_bad := v_bad || 'anon has a privilege'::text;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.leod_event_members'::regclass AND polcmd <> 'r') THEN
        v_bad := v_bad || 'a write policy exists'::text;
      END IF;
      v_ok := cardinality(v_bad) = 0;
      v_detail := CASE WHEN v_ok THEN 'leod_event_members is read-only for clients'
                       ELSE array_to_string(v_bad, ', ') END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'event_members_server_writes_only'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- T3 (132): the creator of an event is never a member of it (spec §2:
  -- computed from created_by, so no row can demote them).
  BEGIN
    SELECT count(*), string_agg(m.event_id::text, ', ') INTO v_n, v_detail
      FROM leod_event_members m JOIN leod_events e ON e.id = m.event_id
     WHERE m.user_id = e.created_by;
    v_ok := v_n = 0;
    v_detail := CASE WHEN v_n = 0 THEN 'no event lists its creator as a member'
                     ELSE v_n || ' events list their creator as a member: ' || v_detail END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'event_creator_never_member'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.cuedeck_guard_results() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cuedeck_guard_results() TO service_role;
COMMENT ON FUNCTION public.cuedeck_guard_results() IS
  'Console guards (132+): event access only through cuedeck_event_role, memberships written by the server only, creators never members. Run as service_role; every row must be ok.';
