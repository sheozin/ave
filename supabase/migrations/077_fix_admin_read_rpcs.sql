-- 077: repair five admin read RPCs, and guard every admin read RPC.
--
-- Found during Task 10 (2026-10-04) and reproduced as an admin (rolled back):
--   admin_get_activity_feed, admin_get_audit_log, admin_list_emails
--     -> 42702 column reference "id" is ambiguous
--   admin_get_recent_signups, admin_get_signups_with_emails
--     -> 42702 column reference "role" is ambiguous
-- Root cause: the admin check `SELECT 1 FROM leod_users WHERE id = auth.uid()
-- AND role = 'admin'` is unqualified, and each function's RETURNS TABLE has an
-- output column named id or role. In PL/pgSQL those output columns are
-- variables, so the reference is ambiguous and the function fails for every
-- caller, admin or not. admin_get_signups_with_emails had two more faults
-- behind the first: `SELECT user_id ... FROM email_log GROUP BY user_id`
-- (user_id is also an output column) and `u.created_at`, a column
-- leod_users does not have.
--
-- Fix: qualify every ambiguous reference with its table alias. Signatures,
-- return columns, the admin checks, grants and owners are unchanged; the
-- search_path set by 076 is restated so CREATE OR REPLACE keeps it.
--
-- created_at in admin_get_signups_with_emails: no page calls this function
-- (cuedeck-admin.html never references it), so there is no label to match.
-- The column is the signup time, which is auth.users.created_at: the same
-- source admin_get_recent_signups uses for its created_at. first_login_at
-- stays its own column, so it is not reused here.
--
-- Guard G9 admin_read_rpcs_callable is appended to checkin_guard_results().
-- Guards G1 to G7 are byte-identical to the live definition read on
-- 2026-10-04 (prosrc md5 73fbdb241d3ea47b6bbf65f0d62eeb8f before this
-- migration).
--
-- Rollback (not run): re-apply each function's previous body from
-- 035_admin_email_tracking.sql / the definition recorded in the Task 11
-- report, plus `ALTER FUNCTION ... SET search_path = public, extensions,
-- pg_temp`, and re-apply part B of 075 for checkin_guard_results.

-- ── admin_get_activity_feed ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_activity_feed(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_category text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, user_id uuid, user_name text, user_email text, action text, category text, description text, metadata jsonb, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions, pg_temp
AS $function$
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM leod_users lu WHERE lu.id = auth.uid() AND lu.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    a.id,
    a.user_id,
    COALESCE(u.name, '') AS user_name,
    COALESCE(u.email, '') AS user_email,
    a.action,
    a.category,
    a.description,
    a.metadata,
    a.created_at
  FROM activity_log a
  LEFT JOIN leod_users u ON a.user_id = u.id
  WHERE (p_category IS NULL OR a.category = p_category)
  ORDER BY a.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;

-- ── admin_get_audit_log ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_audit_log(p_offset integer DEFAULT 0, p_limit integer DEFAULT 50)
 RETURNS TABLE(id uuid, admin_email text, action text, target_type text, target_id text, details jsonb, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions, pg_temp
AS $function$
BEGIN
  -- ADMIN CHECK
  IF NOT EXISTS (SELECT 1 FROM leod_users lu WHERE lu.id = auth.uid() AND lu.role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;
  IF p_offset < 0 THEN p_offset := 0; END IF;

  RETURN QUERY
  SELECT a.id, au.email::TEXT AS admin_email, a.action::TEXT, a.target_type::TEXT,
    a.target_id::TEXT, a.details, a.created_at
  FROM leod_admin_audit a
  LEFT JOIN auth.users au ON au.id = a.admin_id
  ORDER BY a.created_at DESC
  LIMIT p_limit OFFSET p_offset;
END;
$function$;

-- ── admin_get_recent_signups ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_recent_signups(p_limit integer DEFAULT 10)
 RETURNS TABLE(email text, name text, role text, organization text, created_at timestamp with time zone, plan text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions, pg_temp
AS $function$
BEGIN
  -- ADMIN CHECK
  IF NOT EXISTS (SELECT 1 FROM leod_users lu WHERE lu.id = auth.uid() AND lu.role = 'admin') THEN
    RAISE EXCEPTION 'Forbidden';
  END IF;
  IF p_limit > 100 THEN p_limit := 100; END IF;

  RETURN QUERY
  SELECT au.email::TEXT, lu.name::TEXT, lu.role::TEXT, lu.organization::TEXT, au.created_at,
    COALESCE(s.plan, 'none')::TEXT
  FROM auth.users au
  LEFT JOIN leod_users lu ON lu.id = au.id
  LEFT JOIN leod_subscriptions s ON s.director_id = au.id
  ORDER BY au.created_at DESC
  LIMIT p_limit;
END;
$function$;

-- ── admin_get_signups_with_emails ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_get_signups_with_emails(p_limit integer DEFAULT 20)
 RETURNS TABLE(user_id uuid, name text, email text, role text, created_at timestamp with time zone, first_login_at timestamp with time zone, welcome_email_sent boolean, emails_received integer, last_email_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions, pg_temp
AS $function$
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM leod_users lu WHERE lu.id = auth.uid() AND lu.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- created_at is the signup time from auth.users (leod_users has no
  -- created_at column); same source as admin_get_recent_signups.
  RETURN QUERY
  SELECT
    u.id AS user_id,
    u.name,
    u.email,
    u.role,
    au.created_at,
    u.first_login_at,
    COALESCE(u.welcome_email_sent, false) AS welcome_email_sent,
    COALESCE(e.email_count, 0)::INT AS emails_received,
    e.last_email_at
  FROM leod_users u
  LEFT JOIN auth.users au ON au.id = u.id
  LEFT JOIN (
    SELECT
      el.user_id,
      COUNT(*) as email_count,
      MAX(el.sent_at) as last_email_at
    FROM email_log el
    GROUP BY el.user_id
  ) e ON e.user_id = u.id
  ORDER BY au.created_at DESC NULLS LAST
  LIMIT p_limit;
END;
$function$;

-- ── admin_list_emails ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_list_emails(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_type text DEFAULT NULL::text, p_status text DEFAULT NULL::text, p_search text DEFAULT NULL::text)
 RETURNS TABLE(id uuid, user_id uuid, user_name text, user_email text, email_type text, email_address text, subject text, status text, resend_id text, sent_at timestamp with time zone, opened_at timestamp with time zone, clicked_at timestamp with time zone, invoice_number text, metadata jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public, extensions, pg_temp
AS $function$
BEGIN
  -- Verify caller is admin
  IF NOT EXISTS (
    SELECT 1 FROM leod_users lu WHERE lu.id = auth.uid() AND lu.role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  RETURN QUERY
  SELECT
    el.id,
    el.user_id,
    COALESCE(u.name, '') AS user_name,
    COALESCE(u.email, el.email_address) AS user_email,
    el.email_type,
    el.email_address,
    el.subject,
    COALESCE(el.status, 'sent') AS status,
    el.resend_id,
    el.sent_at,
    el.opened_at,
    el.clicked_at,
    inv.invoice_number,
    el.metadata
  FROM email_log el
  LEFT JOIN leod_users u ON el.user_id = u.id
  LEFT JOIN leod_invoices inv ON el.invoice_id = inv.id
  WHERE (p_type IS NULL OR el.email_type = p_type)
    AND (p_status IS NULL OR COALESCE(el.status, 'sent') = p_status)
    AND (p_search IS NULL OR
         el.email_address ILIKE '%' || p_search || '%' OR
         u.name ILIKE '%' || p_search || '%')
  ORDER BY el.sent_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$function$;

-- ── checkin_guard_results: G1 to G7 unchanged, G9 appended ──────────
-- One row per guard. Every guard runs in its own exception block: a
-- guard that throws is reported ok = false with the error as detail,
-- never skipped. Guards are written by exclusion (list what must not
-- exist) wherever the invariant allows it.
CREATE OR REPLACE FUNCTION public.checkin_guard_results()
RETURNS TABLE (guard TEXT, ok BOOLEAN, detail TEXT, checked_at TIMESTAMPTZ)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
#variable_conflict use_column
DECLARE
  v_ok     BOOLEAN;
  v_detail TEXT;
  v_bad    TEXT[];
  v_roles  TEXT[];
  v_n      INT;
  v_total  INT;
  v_gf     INT;
  v_admin  UUID;
  v_fn     RECORD;
  v_noargs TEXT[];
BEGIN
  -- G1 (061, 064, 069): no leod_checkin_* table writable by anon. Writable
  -- = an INSERT/UPDATE/DELETE grant AND (RLS off OR a permissive write
  -- policy that applies to anon or PUBLIC). TRUNCATE is not counted:
  -- PostgREST cannot issue it, and Supabase grants it to anon by default.
  -- An empty in-scope set (prefix renamed, tables moved) is a failure: the
  -- guard must not pass by looking at nothing.
  BEGIN
    SELECT count(*),
           array_agg(c.relname::text ORDER BY c.relname) FILTER (WHERE
             has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE')
             AND (NOT c.relrowsecurity OR EXISTS (
                   SELECT 1 FROM pg_policy p
                    WHERE p.polrelid = c.oid
                      AND p.polpermissive
                      AND p.polcmd IN ('a', 'w', 'd', '*')
                      AND (0::oid = ANY (p.polroles) OR 'anon'::regrole::oid = ANY (p.polroles)))))
      INTO v_total, v_bad
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE 'leod\_checkin\_%';
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_total > 0 AND v_n = 0;
    v_detail := CASE WHEN v_total = 0 THEN '0 leod_checkin_* tables found'
                     WHEN v_n = 0 THEN '0 of ' || v_total || ' leod_checkin_* tables writable by anon'
                     ELSE v_n || ' of ' || v_total || ' leod_checkin_* tables writable by anon: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_tables_not_anon_writable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G2 (061, 064, 069): no table in public with RLS off.
  BEGIN
    SELECT array_agg(c.relname::text ORDER BY c.relname)
      INTO v_bad
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND NOT c.relrowsecurity;
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every table in public has RLS on'
                     ELSE 'RLS off: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'public_tables_rls_on'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G3 (069): leod_config not writable by authenticated (same definition
  -- of writable as G1).
  BEGIN
    IF to_regclass('public.leod_config') IS NULL THEN
      v_ok := false;
      v_detail := 'leod_config does not exist';
    ELSE
      SELECT NOT (has_table_privilege('authenticated', c.oid, 'INSERT, UPDATE, DELETE')
                  AND (NOT c.relrowsecurity OR EXISTS (
                        SELECT 1 FROM pg_policy p
                         WHERE p.polrelid = c.oid
                           AND p.polpermissive
                           AND p.polcmd IN ('a', 'w', 'd', '*')
                           AND (0::oid = ANY (p.polroles)
                                OR 'authenticated'::regrole::oid = ANY (p.polroles)))))
        INTO v_ok
        FROM pg_class c
       WHERE c.oid = to_regclass('public.leod_config');
      v_detail := CASE WHEN v_ok THEN 'authenticated cannot write leod_config'
                       ELSE 'authenticated can write leod_config' END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'leod_config_not_authenticated_writable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G4 (roles build): every leod_checkin_operators.role is allowed. Five
  -- roles once the roles build has widened the check constraint, three
  -- before it.
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_constraint
                WHERE conrelid = 'public.leod_checkin_operators'::regclass
                  AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%''lead''%'
                  AND pg_get_constraintdef(oid) LIKE '%''viewer''%') THEN
      v_roles := ARRAY['organizer', 'lead', 'crew', 'viewer', 'api_consumer'];
    ELSE
      v_roles := ARRAY['organizer', 'crew', 'api_consumer'];
    END IF;
    SELECT array_agg(DISTINCT coalesce(o.role, '<null>'))
      INTO v_bad
      FROM leod_checkin_operators o
     WHERE o.role IS NULL OR NOT (o.role = ANY (v_roles));
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every role is one of: ' || array_to_string(v_roles, ', ')
                     ELSE 'roles outside {' || array_to_string(v_roles, ', ') || '}: '
                          || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'checkin_operator_roles_allowed'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G5 (billing invariants): no live event without a paid, unrefunded
  -- purchase unless its owner is a comp account. Rows that 059 made live
  -- when paid go-live shipped (went_live_at = created_at, created before
  -- 059 was applied at 2026-10-04 10:42:11 UTC) were enabled by hand and
  -- are grandfathered.
  BEGIN
    SELECT count(*),
           array_agg(x.event_id::text ORDER BY x.event_id) FILTER (WHERE x.unpaid AND NOT x.gf),
           count(*) FILTER (WHERE x.unpaid AND x.gf)
      INTO v_total, v_bad, v_gf
      FROM (SELECT n.event_id,
                   (NOT EXISTS (SELECT 1 FROM leod_checkin_purchases p
                                 WHERE p.event_id = n.event_id
                                   AND p.paid_at IS NOT NULL
                                   AND p.refunded_at IS NULL)
                    AND NOT EXISTS (SELECT 1 FROM leod_checkin_comp_accounts c WHERE c.user_id = e.created_by)) AS unpaid,
                   coalesce(n.went_live_at = n.created_at
                            AND n.created_at < timestamptz '2026-10-04 10:42:11+00', false) AS gf
              FROM leod_checkin_entitlements n
              JOIN leod_events e ON e.id = n.event_id
             WHERE n.status = 'live') x;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_n = 0;
    v_detail := v_n || ' of ' || v_total || ' live entitlements without a purchase (' || v_gf || ' grandfathered)'
                || CASE WHEN v_ok THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'live_events_have_purchase'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G6 (billing invariants): no paid purchase without a matching
  -- entitlement: live while the purchase stands, any status once refunded
  -- (checkin_mark_refunded sets the entitlement back to 'test').
  BEGIN
    SELECT count(*),
           array_agg(p.id::text ORDER BY p.id) FILTER (WHERE n.event_id IS NULL
             OR (p.refunded_at IS NULL AND n.status IS DISTINCT FROM 'live'))
      INTO v_total, v_bad
      FROM leod_checkin_purchases p
      LEFT JOIN leod_checkin_entitlements n ON n.event_id = p.event_id
     WHERE p.paid_at IS NOT NULL;
    v_n := coalesce(cardinality(v_bad), 0);
    v_ok := v_n = 0;
    v_detail := v_n || ' of ' || v_total || ' paid purchases without a matching entitlement'
                || CASE WHEN v_ok THEN '' ELSE ': ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'purchases_have_entitlement'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G7 (069): every SECURITY DEFINER function in public pins search_path.
  BEGIN
    SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                     ORDER BY p.proname)
      INTO v_bad
      FROM pg_proc p
      JOIN pg_namespace ns ON ns.oid = p.pronamespace
     WHERE ns.nspname = 'public'
       AND p.prosecdef
       AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}'::text[])) cfg
                        WHERE cfg LIKE 'search\_path=%');
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every SECURITY DEFINER function in public sets search_path'
                     ELSE cardinality(v_bad) || ' without search_path: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'security_definer_search_path'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G9 (077): every admin read RPC (public admin_get_* / admin_list_*)
  -- that can be called without arguments runs cleanly as an admin.
  -- PL/pgSQL prepares a statement only when execution reaches it, so a
  -- broken query behind the admin check is invisible to a caller without a
  -- JWT. Each call therefore impersonates an existing admin (request.jwt.claims,
  -- transaction-local) inside its own subblock, and ends by raising a private
  -- SQLSTATE so the subblock rolls back: any write the RPC made and the
  -- impersonation itself are undone. Only that private SQLSTATE is a pass.
  -- Any other error is a failure, including Forbidden/Unauthorized, which as
  -- an admin means the admin check itself is broken. No admin to test as, or
  -- no callable RPC in scope, is a failure, not an all-clear. RPCs that need
  -- arguments without defaults are listed but do not fail the guard.
  BEGIN
    v_bad := NULL;
    v_noargs := NULL;
    v_total := 0;
    SELECT u.id INTO v_admin
      FROM leod_users u
     WHERE u.role = 'admin'
     ORDER BY u.id
     LIMIT 1;
    IF v_admin IS NULL THEN
      v_ok := false;
      v_detail := 'no admin user to test as';
    ELSE
      FOR v_fn IN
        SELECT p.proname::text AS fname,
               p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig,
               p.pronargs = p.pronargdefaults AS callable
          FROM pg_proc p
          JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'
           AND p.prokind = 'f'
           AND (p.proname LIKE 'admin\_get\_%' OR p.proname LIKE 'admin\_list\_%')
         ORDER BY 2
      LOOP
        IF NOT v_fn.callable THEN
          v_noargs := array_append(v_noargs, v_fn.sig);
          CONTINUE;
        END IF;
        v_total := v_total + 1;
        BEGIN
          PERFORM set_config('request.jwt.claims',
                             json_build_object('sub', v_admin, 'role', 'authenticated')::text, true);
          EXECUTE format('SELECT count(*) FROM public.%I()', v_fn.fname);
          RAISE EXCEPTION USING ERRCODE = 'ZZG09';
        EXCEPTION
          WHEN SQLSTATE 'ZZG09' THEN
            NULL;
          WHEN OTHERS THEN
            v_bad := array_append(v_bad, v_fn.sig || ' ' || SQLSTATE || ' ' || left(SQLERRM, 120));
        END;
      END LOOP;
      v_n := coalesce(cardinality(v_bad), 0);
      v_ok := v_total > 0 AND v_n = 0;
      v_detail := CASE WHEN v_total = 0 THEN '0 admin read RPCs callable without args found'
                       ELSE v_n || ' of ' || v_total || ' admin read RPCs fail when called as an admin'
                            || CASE WHEN v_n = 0 THEN '' ELSE ': ' || array_to_string(v_bad, '; ') END END
                  || CASE WHEN v_noargs IS NULL THEN ''
                          ELSE '; not callable without args: ' || array_to_string(v_noargs, ', ') END;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'admin_read_rpcs_callable'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.checkin_guard_results() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_guard_results() TO service_role;
COMMENT ON FUNCTION public.checkin_guard_results() IS
  'AVE Brain nightly guards: one row per guard, ok = false on violation or on guard error. Service role only.';
