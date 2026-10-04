-- ============================================================
-- CueDeck Migration 075: check-in sensors for the AVE Brain
-- ============================================================
-- Spec: ave-brain/docs/superpowers/specs/2026-10-04-cuedeck-checkin-brain-design.md
-- Plan: ave-brain/docs/superpowers/plans/2026-10-04-cuedeck-checkin-brain-sensors.md
--
-- Applied in two idempotent parts: part A (this section) as
-- 075_checkin_brain_sensors, part B (checkin_guard_results, below) as
-- 075_checkin_guard_results. Running the whole file again is safe.
--
-- Written to work before or after the roles build (070-074). Every
-- reference to an object that build adds (leod_checkin_desks, the
-- 'forbidden' scan result, roles lead/viewer) is looked up at run time.
-- A metric that cannot be measured is null, never 0.
-- ============================================================

-- A1. Scheduled job registry and run log ---------------------------------
-- A job writes one row per run into leod_checkin_job_runs. The registry
-- says how often each job must run, so a job that never runs is reported
-- 'stale' instead of simply being absent.
CREATE TABLE IF NOT EXISTS public.leod_checkin_jobs (
  job_name          TEXT        PRIMARY KEY,
  expected_interval INTERVAL    NOT NULL CHECK (expected_interval > interval '0'),
  active            BOOLEAN     NOT NULL DEFAULT true,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.leod_checkin_job_runs (
  id          BIGSERIAL   PRIMARY KEY,
  job_name    TEXT        NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status      TEXT        NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  detail      TEXT
);
CREATE INDEX IF NOT EXISTS leod_checkin_job_runs_job_idx
  ON public.leod_checkin_job_runs (job_name, started_at DESC);

ALTER TABLE public.leod_checkin_jobs     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leod_checkin_job_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leod_checkin_jobs, public.leod_checkin_job_runs FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.leod_checkin_job_runs_id_seq FROM anon, authenticated;
-- No policies on purpose: only the service role (which bypasses RLS)
-- reads or writes these tables.

-- A2. checkin_brain_signals ----------------------------------------------
-- plpgsql, not SQL: a LANGUAGE sql body is validated at creation, and
-- this one must be creatable before leod_checkin_desks exists.
CREATE OR REPLACE FUNCTION public.checkin_brain_signals(p_since TIMESTAMPTZ)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_funnel       JSONB;
  v_stalled      JSONB;
  v_refunds      JSONB;
  v_alerts       JSONB;
  v_event_ids    UUID[];
  v_scan_total   INTEGER;
  v_test_total   INTEGER;
  v_test_cap     INTEGER;
  v_late         INTEGER;
  v_by_result    JSONB;
  v_forbidden    JSONB;
  v_desks        JSONB;
  v_unconfirmed  JSONB;
  v_registered   INTEGER;
  v_jobs         JSONB;
  v_unregistered JSONB;
  v_cron         JSONB;
  v_cron_reason  TEXT;
BEGIN
  IF p_since IS NULL OR p_since > now() THEN
    RAISE EXCEPTION 'checkin_brain_signals: p_since must be a time in the past, got %', p_since
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Funnel. Cohort: accounts that signed up from the check-in pages since
  -- p_since (signup_source lives in auth.users.raw_user_meta_data; there is
  -- no such column on leod_users). Each gating stage counts members of the
  -- previous gating stage. used_test_desk does not gate: go-live deletes
  -- every test scan (checkin_mark_paid / checkin_mark_comp_live), so for an
  -- account that is already live it cannot be measured, and is reported in
  -- 'unknown' instead of being counted as a drop-out.
  WITH cohort AS (
    SELECT u.id, (u.email_confirmed_at IS NOT NULL) AS confirmed
      FROM auth.users u
     WHERE u.raw_user_meta_data->>'signup_source' = 'checkin'
       AND u.created_at >= p_since
  ), flags AS (
    SELECT c.confirmed,
           EXISTS (SELECT 1 FROM leod_events e WHERE e.created_by = c.id) AS created_event,
           EXISTS (SELECT 1 FROM leod_events e
                     JOIN leod_checkin_attendees a ON a.event_id = e.id
                    WHERE e.created_by = c.id AND a.source = 'import') AS imported,
           EXISTS (SELECT 1 FROM leod_events e
                     JOIN leod_checkin_scan_events s ON s.event_id = e.id
                    WHERE e.created_by = c.id AND s.is_test) AS used_test_desk,
           (EXISTS (SELECT 1 FROM leod_events e
                      JOIN leod_checkin_entitlements n ON n.event_id = e.id
                     WHERE e.created_by = c.id AND n.checkout_session_id IS NOT NULL)
            OR EXISTS (SELECT 1 FROM leod_events e
                         JOIN leod_checkin_purchases p ON p.event_id = e.id
                        WHERE e.created_by = c.id)) AS opened_checkout,
           EXISTS (SELECT 1 FROM leod_events e
                     JOIN leod_checkin_purchases p ON p.event_id = e.id
                    WHERE e.created_by = c.id AND p.paid_at IS NOT NULL) AS paid,
           EXISTS (SELECT 1 FROM leod_events e
                     JOIN leod_checkin_entitlements n ON n.event_id = e.id
                    WHERE e.created_by = c.id AND n.went_live_at IS NOT NULL) AS went_live
      FROM cohort c
  ), chain AS (
    SELECT count(*)::int                                                         AS signed_up,
           count(*) FILTER (WHERE confirmed)::int                                AS confirmed,
           count(*) FILTER (WHERE confirmed AND created_event)::int              AS created_event,
           count(*) FILTER (WHERE confirmed AND created_event AND imported)::int AS imported,
           count(*) FILTER (WHERE confirmed AND created_event AND imported
                              AND used_test_desk)::int                           AS test_desk_seen,
           count(*) FILTER (WHERE confirmed AND created_event AND imported
                              AND NOT used_test_desk AND went_live)::int         AS test_desk_unknown,
           count(*) FILTER (WHERE confirmed AND created_event AND imported
                              AND opened_checkout)::int                          AS opened_checkout,
           count(*) FILTER (WHERE confirmed AND created_event AND imported
                              AND opened_checkout AND paid)::int                 AS paid,
           count(*) FILTER (WHERE confirmed AND created_event AND imported
                              AND opened_checkout AND paid AND went_live)::int   AS went_live
      FROM flags
  )
  SELECT jsonb_build_object(
           'cohort', 'auth.users with raw_user_meta_data.signup_source = checkin, created since p_since',
           'stages', jsonb_build_array(
             jsonb_build_object('stage', 'signed_up',       'count', signed_up,       'of', NULL),
             jsonb_build_object('stage', 'confirmed',       'count', confirmed,       'of', signed_up),
             jsonb_build_object('stage', 'created_event',   'count', created_event,   'of', confirmed),
             jsonb_build_object('stage', 'imported_guests', 'count', imported,        'of', created_event),
             jsonb_build_object('stage', 'used_test_desk',  'count', test_desk_seen,  'of', imported,
                                'unknown', test_desk_unknown, 'gating', false),
             jsonb_build_object('stage', 'opened_checkout', 'count', opened_checkout, 'of', imported),
             jsonb_build_object('stage', 'paid',            'count', paid,            'of', opened_checkout),
             jsonb_build_object('stage', 'went_live',       'count', went_live,       'of', paid)))
    INTO v_funnel
    FROM chain;

  -- Money. A checkout's open time is checkout_expires_at - 1 h, because
  -- checkin-create-checkout creates every session with a 1 h expiry. The
  -- window holds checkouts that turned 24 h old since p_since, so each
  -- stalled checkout is reported once, not every night forever.
  SELECT jsonb_build_object(
           'count',  count(*) FILTER (WHERE NOT o.paid)::int,
           'of',     count(*)::int,
           'window', 'checkouts opened between p_since - 24h and now() - 24h')
    INTO v_stalled
    FROM (SELECT EXISTS (SELECT 1 FROM leod_checkin_purchases p
                          WHERE p.event_id = n.event_id AND p.paid_at IS NOT NULL) AS paid
            FROM leod_checkin_entitlements n
           WHERE n.checkout_session_id IS NOT NULL
             AND n.checkout_expires_at - interval '1 hour' >= p_since - interval '24 hours'
             AND n.checkout_expires_at - interval '1 hour' <  now()   - interval '24 hours') o;

  SELECT jsonb_build_object(
           'count',    count(*) FILTER (WHERE p.refunded_at >= p_since)::int,
           'of',       count(*)::int,
           'of_means', 'paid purchases not already refunded before p_since')
    INTO v_refunds
    FROM leod_checkin_purchases p
   WHERE p.paid_at IS NOT NULL
     AND (p.refunded_at IS NULL OR p.refunded_at >= p_since);

  SELECT jsonb_build_object(
           'count',   coalesce(sum(k.n), 0)::int,
           'by_kind', coalesce(jsonb_object_agg(k.kind, k.n), '{}'::jsonb))
    INTO v_alerts
    FROM (SELECT b.kind, count(*)::int AS n
            FROM leod_billing_alerts b
           WHERE b.resolved_at IS NULL
           GROUP BY b.kind) k;

  -- Event day: check-in events whose local date falls between p_since and
  -- now, in the event's own time zone.
  SELECT coalesce(array_agg(e.id), '{}'::uuid[])
    INTO v_event_ids
    FROM leod_events e
    JOIN leod_checkin_entitlements n ON n.event_id = e.id
   WHERE e.date BETWEEN (p_since AT TIME ZONE e.timezone)::date
                    AND (now()   AT TIME ZONE e.timezone)::date;

  SELECT count(*)::int,
         count(*) FILTER (WHERE s.is_test)::int,
         count(*) FILTER (WHERE s.result = 'test_cap')::int,
         count(*) FILTER (WHERE s.received_at - s.scanned_at > interval '60 seconds')::int
    INTO v_scan_total, v_test_total, v_test_cap, v_late
    FROM leod_checkin_scan_events s
   WHERE s.event_id = ANY (v_event_ids)
     AND s.scanned_at >= p_since;

  SELECT coalesce(jsonb_object_agg(r.result, r.n), '{}'::jsonb)
    INTO v_by_result
    FROM (SELECT s.result, count(*)::int AS n
            FROM leod_checkin_scan_events s
           WHERE s.event_id = ANY (v_event_ids)
             AND s.scanned_at >= p_since
           GROUP BY s.result) r;

  -- 'forbidden' only exists once the roles build widens the result check.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.leod_checkin_scan_events'::regclass
                AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%''forbidden''%') THEN
    v_forbidden := jsonb_build_object(
      'count', coalesce((v_by_result->>'forbidden')::int, 0),
      'of',    v_scan_total);
  ELSE
    v_forbidden := jsonb_build_object(
      'count', NULL, 'of', NULL,
      'reason', 'scan result forbidden does not exist yet (roles build not applied)');
  END IF;

  -- leod_checkin_desks only exists once the roles/dashboard build lands.
  -- Dynamic SQL so this function never references it at plan time.
  IF to_regclass('public.leod_checkin_desks') IS NOT NULL THEN
    EXECUTE 'SELECT jsonb_build_object(''count'', count(*) FILTER (WHERE d.pending_count > 0)::int,
                                       ''of'',    count(*)::int)
               FROM public.leod_checkin_desks d
              WHERE d.event_id = ANY ($1) AND NOT d.is_test'
       INTO v_desks
      USING v_event_ids;
  ELSE
    v_desks := jsonb_build_object(
      'count', NULL, 'of', NULL,
      'reason', 'leod_checkin_desks does not exist yet (roles build not applied)');
  END IF;

  -- Friction: check-in sign-ups that turned 24 h old since p_since and are
  -- still unconfirmed.
  SELECT jsonb_build_object(
           'count',  count(*) FILTER (WHERE u.email_confirmed_at IS NULL)::int,
           'of',     count(*)::int,
           'window', 'check-in sign-ups created between p_since - 24h and now() - 24h')
    INTO v_unconfirmed
    FROM auth.users u
   WHERE u.raw_user_meta_data->>'signup_source' = 'checkin'
     AND u.created_at >= p_since - interval '24 hours'
     AND u.created_at <  now()   - interval '24 hours';

  -- Watchers. 15 minutes of grace on top of each job's interval. Staleness
  -- is measured from the last 'ok' run, not the last start: a job that
  -- keeps starting and crashing leaves 'running' rows and must not look ok.
  SELECT count(*)::int INTO v_registered FROM leod_checkin_jobs WHERE active;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'job',                  j.job_name,
           'expected_interval',    j.expected_interval::text,
           'last_start',           r.last_start,
           'last_success',         r.last_success,
           'last_failure',         r.last_failure,
           'consecutive_failures', r.consecutive_failures,
           'status', CASE
                       WHEN r.consecutive_failures > 0 THEN 'failing'
                       WHEN r.last_success IS NULL
                         OR r.last_success < now() - j.expected_interval - interval '15 minutes' THEN 'stale'
                       ELSE 'ok'
                     END) ORDER BY j.job_name), '[]'::jsonb)
    INTO v_jobs
    FROM leod_checkin_jobs j
    CROSS JOIN LATERAL (
      SELECT max(x.started_at)                                    AS last_start,
             max(x.started_at) FILTER (WHERE x.status = 'ok')     AS last_success,
             max(x.started_at) FILTER (WHERE x.status = 'failed') AS last_failure,
             count(*) FILTER (WHERE x.status = 'failed'
                                AND x.started_at > coalesce(
                                      (SELECT max(y.started_at) FROM leod_checkin_job_runs y
                                        WHERE y.job_name = j.job_name AND y.status = 'ok'),
                                      '-infinity'::timestamptz))::int AS consecutive_failures
        FROM leod_checkin_job_runs x
       WHERE x.job_name = j.job_name) r
   WHERE j.active;

  -- Runs from a job nobody registered: by exclusion, so a new job cannot
  -- run unwatched.
  SELECT coalesce(jsonb_agg(DISTINCT x.job_name), '[]'::jsonb)
    INTO v_unregistered
    FROM leod_checkin_job_runs x
   WHERE NOT EXISTS (SELECT 1 FROM leod_checkin_jobs j WHERE j.job_name = x.job_name);

  -- pg_cron is not installed in this project today (checked 2026-10-04).
  IF to_regclass('cron.job_run_details') IS NOT NULL AND to_regclass('cron.job') IS NOT NULL THEN
    EXECUTE $q$
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'job',                  j.jobname,
               'schedule',             j.schedule,
               'active',               j.active,
               'last_start',           d.last_start,
               'last_success',         d.last_success,
               'last_failure',         d.last_failure,
               'consecutive_failures', d.consecutive_failures) ORDER BY j.jobname), '[]'::jsonb)
        FROM cron.job j
        CROSS JOIN LATERAL (
          SELECT max(x.start_time)                                       AS last_start,
                 max(x.start_time) FILTER (WHERE x.status = 'succeeded') AS last_success,
                 max(x.start_time) FILTER (WHERE x.status = 'failed')    AS last_failure,
                 count(*) FILTER (WHERE x.status = 'failed'
                                    AND x.start_time > coalesce(
                                          (SELECT max(y.start_time) FROM cron.job_run_details y
                                            WHERE y.jobid = j.jobid AND y.status = 'succeeded'),
                                          '-infinity'::timestamptz))::int AS consecutive_failures
            FROM cron.job_run_details x
           WHERE x.jobid = j.jobid) d
    $q$ INTO v_cron;
  ELSE
    v_cron := NULL;
    v_cron_reason := 'pg_cron is not installed in this project';
  END IF;

  RETURN jsonb_build_object(
    'version',      1,
    'since',        p_since,
    'generated_at', now(),
    'funnel',       v_funnel,
    'money', jsonb_build_object(
      'stalled_checkouts',   v_stalled,
      'refunds',             v_refunds,
      'open_billing_alerts', v_alerts),
    'event_day', jsonb_build_object(
      'events',        cardinality(v_event_ids),
      'scans',         jsonb_build_object('total', v_scan_total, 'test', v_test_total, 'by_result', v_by_result),
      'test_cap',      jsonb_build_object('count', v_test_cap, 'of', v_test_total),
      'forbidden',     v_forbidden,
      'late_sync',     jsonb_build_object('count', v_late, 'of', v_scan_total, 'threshold_seconds', 60),
      'desks_pending', v_desks),
    'friction', jsonb_build_object(
      'unconfirmed_after_24h', v_unconfirmed,
      'captcha_failed', jsonb_build_object(
        'count', NULL, 'of', NULL,
        'reason', 'Supabase auth logs are not readable from SQL and the brain has no auth-log reader')),
    'watchers', jsonb_build_object(
      'registered',        v_registered,
      'jobs',              v_jobs,
      'unregistered_runs', v_unregistered,
      'pg_cron',           v_cron,
      'pg_cron_reason',    v_cron_reason));
END;
$function$;

REVOKE ALL ON FUNCTION public.checkin_brain_signals(TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_brain_signals(TIMESTAMPTZ) TO service_role;
COMMENT ON FUNCTION public.checkin_brain_signals(TIMESTAMPTZ) IS
  'AVE Brain nightly sensor. null = could not measure, 0 = measured none. Service role only.';

-- ============================================================
-- Part B: checkin_guard_results (applied as 075_checkin_guard_results)
-- ============================================================
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
BEGIN
  -- G1 (061, 064, 069): no leod_checkin_* table writable by anon. Writable
  -- = an INSERT/UPDATE/DELETE grant AND (RLS off OR a permissive write
  -- policy that applies to anon or PUBLIC). TRUNCATE is not counted:
  -- PostgREST cannot issue it, and Supabase grants it to anon by default.
  BEGIN
    SELECT array_agg(c.relname::text ORDER BY c.relname)
      INTO v_bad
      FROM pg_class c
      JOIN pg_namespace ns ON ns.oid = c.relnamespace
     WHERE ns.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND c.relname LIKE 'leod\_checkin\_%'
       AND has_table_privilege('anon', c.oid, 'INSERT, UPDATE, DELETE')
       AND (NOT c.relrowsecurity OR EXISTS (
             SELECT 1 FROM pg_policy p
              WHERE p.polrelid = c.oid
                AND p.polpermissive
                AND p.polcmd IN ('a', 'w', 'd', '*')
                AND (0::oid = ANY (p.polroles) OR 'anon'::regrole::oid = ANY (p.polroles))));
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'no leod_checkin_* table is writable by anon'
                     ELSE 'writable by anon: ' || array_to_string(v_bad, ', ') END;
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
    SELECT array_agg(n.event_id::text ORDER BY n.event_id)
      INTO v_bad
      FROM leod_checkin_entitlements n
      JOIN leod_events e ON e.id = n.event_id
     WHERE n.status = 'live'
       AND NOT EXISTS (SELECT 1 FROM leod_checkin_purchases p
                        WHERE p.event_id = n.event_id
                          AND p.paid_at IS NOT NULL
                          AND p.refunded_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM leod_checkin_comp_accounts c WHERE c.user_id = e.created_by)
       AND NOT (n.went_live_at = n.created_at
                AND n.created_at < timestamptz '2026-10-04 10:42:11+00');
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every live event has a paid purchase or a comp owner'
                     ELSE 'live without payment: ' || array_to_string(v_bad, ', ') END;
  EXCEPTION WHEN OTHERS THEN
    v_ok := false; v_detail := 'guard error: ' || SQLERRM;
  END;
  guard := 'live_events_have_purchase'; ok := v_ok; detail := v_detail; checked_at := now();
  RETURN NEXT;

  -- G6 (billing invariants): no paid purchase without a matching
  -- entitlement: live while the purchase stands, any status once refunded
  -- (checkin_mark_refunded sets the entitlement back to 'test').
  BEGIN
    SELECT array_agg(p.id::text ORDER BY p.id)
      INTO v_bad
      FROM leod_checkin_purchases p
      LEFT JOIN leod_checkin_entitlements n ON n.event_id = p.event_id
     WHERE p.paid_at IS NOT NULL
       AND (n.event_id IS NULL
            OR (p.refunded_at IS NULL AND n.status IS DISTINCT FROM 'live'));
    v_ok := v_bad IS NULL;
    v_detail := CASE WHEN v_ok THEN 'every paid purchase has a live or refunded entitlement'
                     ELSE 'purchase without matching entitlement: ' || array_to_string(v_bad, ', ') END;
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
END;
$function$;

REVOKE ALL ON FUNCTION public.checkin_guard_results() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_guard_results() TO service_role;
COMMENT ON FUNCTION public.checkin_guard_results() IS
  'AVE Brain nightly guards: one row per guard, ok = false on violation or on guard error. Service role only.';
