-- ============================================================
-- Probes for migration 075 (checkin_brain_signals, checkin_guard_results)
-- ============================================================
-- Run EACH block below as its own execute_sql call against
-- sawekpguemzvuvvulfbc. Every block ends in RAISE EXCEPTION, so whatever
-- it seeded or changed is rolled back.
--   pass: the call fails with a message starting  PROBE_OK
--   fail: the call fails with a message starting  PROBE_FAIL, or any
--         other error
-- ============================================================

-- S1. Only service_role may execute checkin_brain_signals; anon and
--     authenticated get permission denied when they call it.
DO $probe$
DECLARE
  f CONSTANT TEXT := 'public.checkin_brain_signals(timestamptz)';
  r TEXT;
BEGIN
  IF has_function_privilege('anon', f, 'EXECUTE') OR has_function_privilege('authenticated', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE_FAIL anon or authenticated holds EXECUTE on %', f;
  END IF;
  IF NOT has_function_privilege('service_role', f, 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE_FAIL service_role cannot execute %', f;
  END IF;
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I', r);
      PERFORM public.checkin_brain_signals(now() - interval '1 day');
      RAISE EXCEPTION 'PROBE_FAIL % executed %', r, f;
    EXCEPTION WHEN insufficient_privilege THEN
      NULL;  -- expected; the sub-block rollback also undoes SET LOCAL ROLE
    END;
  END LOOP;
  RAISE EXCEPTION 'PROBE_OK S1 only service_role executes checkin_brain_signals';
END
$probe$;

-- S2. Seeded funnel: right count per stage, denominators present,
--     test-desk stage non-gating, null vs 0 in event_day.
DO $probe$
DECLARE
  u1 UUID := gen_random_uuid();  -- signed up, never confirmed
  u2 UUID := gen_random_uuid();  -- confirmed, created an event, stopped
  u3 UUID := gen_random_uuid();  -- all the way: import, test desk, checkout, paid, live
  u4 UUID := gen_random_uuid();  -- confirmed with an event, but NOT a check-in sign-up
  e2 UUID := gen_random_uuid();
  e3 UUID := gen_random_uuid();
  e4 UUID := gen_random_uuid();
  a3 UUID := gen_random_uuid();
  r  JSONB;
  st JSONB;
  expected JSONB := '{"signed_up":[3,null],"confirmed":[2,3],"created_event":[2,2],"imported_guests":[1,2],"used_test_desk":[1,1],"opened_checkout":[1,1],"paid":[1,1],"went_live":[1,1]}';
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, created_at, aud, role) VALUES
    (u1, 'probe-075-u1@probe.invalid', '{"signup_source":"checkin"}', NULL,  now(), 'authenticated', 'authenticated'),
    (u2, 'probe-075-u2@probe.invalid', '{"signup_source":"checkin"}', now(), now(), 'authenticated', 'authenticated'),
    (u3, 'probe-075-u3@probe.invalid', '{"signup_source":"checkin"}', now(), now(), 'authenticated', 'authenticated'),
    (u4, 'probe-075-u4@probe.invalid', '{}',                          now(), now(), 'authenticated', 'authenticated');

  INSERT INTO leod_events (id, name, date, event_start, event_end, timezone, created_by, created_via) VALUES
    (e2, 'probe 075 e2', current_date, '09:00', '18:00', 'UTC', u2, 'checkin'),
    (e3, 'probe 075 e3', current_date, '09:00', '18:00', 'UTC', u3, 'checkin'),
    (e4, 'probe 075 e4', current_date, '09:00', '18:00', 'UTC', u4, 'checkin');

  INSERT INTO leod_checkin_entitlements (event_id, status, went_live_at, checkout_session_id, checkout_expires_at)
  VALUES (e3, 'live', now(), 'cs_probe_075_e3', now() + interval '1 hour');

  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, qr_token, source)
  VALUES (a3, e3, 'Probe', 'Guest', 'probe-075-' || gen_random_uuid(), 'import');

  INSERT INTO leod_checkin_scan_events (id, event_id, attendee_id, scanned_at, received_at, result, is_test)
  VALUES (gen_random_uuid(), e3, a3, now(), now(), 'ok', true);

  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id, paid_at, amount_total, currency)
  VALUES (e3, u3, 'cs_probe_075_e3', now(), 24900, 'eur');

  r := public.checkin_brain_signals(now());

  FOR st IN SELECT * FROM jsonb_array_elements(r->'funnel'->'stages') LOOP
    IF NOT (st ? 'of') THEN
      RAISE EXCEPTION 'PROBE_FAIL stage % has no denominator key', st->>'stage';
    END IF;
    IF (st->'count') IS DISTINCT FROM (expected->(st->>'stage')->0)
       OR (st->'of') IS DISTINCT FROM (expected->(st->>'stage')->1) THEN
      RAISE EXCEPTION 'PROBE_FAIL stage %: got count=% of=%, want %',
        st->>'stage', st->'count', st->'of', expected->(st->>'stage');
    END IF;
  END LOOP;
  IF jsonb_array_length(r->'funnel'->'stages') <> 8 THEN
    RAISE EXCEPTION 'PROBE_FAIL expected 8 stages, got %', jsonb_array_length(r->'funnel'->'stages');
  END IF;

  -- Event day: exactly the one seeded test scan is inside the window.
  IF (r->'event_day'->'scans'->>'total')::int <> 1 THEN
    RAISE EXCEPTION 'PROBE_FAIL event_day scans total %, want 1', r->'event_day'->'scans'->>'total';
  END IF;
  IF r->'event_day'->'late_sync' <> '{"count":0,"of":1,"threshold_seconds":60}'::jsonb THEN
    RAISE EXCEPTION 'PROBE_FAIL late_sync %', r->'event_day'->'late_sync';
  END IF;

  -- null vs 0: forbidden / desks are null until the roles build exists,
  -- 0 (with a denominator) once it does.
  IF EXISTS (SELECT 1 FROM pg_constraint
              WHERE conrelid = 'public.leod_checkin_scan_events'::regclass AND contype = 'c'
                AND pg_get_constraintdef(oid) LIKE '%''forbidden''%') THEN
    IF r->'event_day'->'forbidden'->'count' <> '0'::jsonb OR r->'event_day'->'forbidden'->'of' <> '1'::jsonb THEN
      RAISE EXCEPTION 'PROBE_FAIL forbidden should be 0 of 1, got %', r->'event_day'->'forbidden';
    END IF;
  ELSE
    IF r->'event_day'->'forbidden'->'count' <> 'null'::jsonb THEN
      RAISE EXCEPTION 'PROBE_FAIL forbidden should be null before the roles build, got %', r->'event_day'->'forbidden';
    END IF;
  END IF;
  IF to_regclass('public.leod_checkin_desks') IS NULL
     AND r->'event_day'->'desks_pending'->'count' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'PROBE_FAIL desks_pending should be null without leod_checkin_desks, got %', r->'event_day'->'desks_pending';
  END IF;
  IF r->'friction'->'captcha_failed'->'count' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'PROBE_FAIL captcha_failed must be null (not measurable), got %', r->'friction'->'captcha_failed';
  END IF;

  RAISE EXCEPTION 'PROBE_OK S2 funnel %', r->'funnel'->'stages';
END
$probe$;

-- S3. Test desk is non-gating and 'unknown' after go-live deleted the
--     test scans: u went live but has no test scan left.
DO $probe$
DECLARE
  u UUID := gen_random_uuid();
  e UUID := gen_random_uuid();
  r JSONB;
  st JSONB;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data, email_confirmed_at, created_at, aud, role)
  VALUES (u, 'probe-075-s3@probe.invalid', '{"signup_source":"checkin"}', now(), now(), 'authenticated', 'authenticated');
  INSERT INTO leod_events (id, name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES (e, 'probe 075 s3', current_date + 30, '09:00', '18:00', 'UTC', u, 'checkin');
  INSERT INTO leod_checkin_entitlements (event_id, status, went_live_at, checkout_session_id, checkout_expires_at)
  VALUES (e, 'live', now(), 'cs_probe_075_s3', now() + interval '1 hour');
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source)
  VALUES (e, 'Probe', 'Guest', 'probe-075-' || gen_random_uuid(), 'import');
  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id, paid_at)
  VALUES (e, u, 'cs_probe_075_s3', now());

  r := public.checkin_brain_signals(now());
  SELECT s INTO st FROM jsonb_array_elements(r->'funnel'->'stages') s WHERE s->>'stage' = 'used_test_desk';
  IF st->'count' <> '0'::jsonb OR st->'unknown' <> '1'::jsonb OR st->'gating' <> 'false'::jsonb THEN
    RAISE EXCEPTION 'PROBE_FAIL used_test_desk %', st;
  END IF;
  SELECT s INTO st FROM jsonb_array_elements(r->'funnel'->'stages') s WHERE s->>'stage' = 'went_live';
  IF st->'count' <> '1'::jsonb THEN
    RAISE EXCEPTION 'PROBE_FAIL went_live should still count 1 without a test scan, got %', st;
  END IF;
  RAISE EXCEPTION 'PROBE_OK S3 test desk non-gating';
END
$probe$;

-- S4. Watchers: a never-run job and an overdue job are 'stale', a job
--     whose last runs failed is 'failing', a fresh ok job is 'ok', and a
--     run from an unregistered job is listed.
DO $probe$
DECLARE
  r JSONB;
  j JSONB;
  want JSONB := '{"probe_never":"stale","probe_overdue":"stale","probe_failing":"failing","probe_fine":"ok","probe_crashing":"stale"}';
BEGIN
  INSERT INTO leod_checkin_jobs (job_name, expected_interval) VALUES
    ('probe_crashing', interval '1 hour'),
    ('probe_never',   interval '1 hour'),
    ('probe_overdue', interval '1 hour'),
    ('probe_failing', interval '1 hour'),
    ('probe_fine',    interval '1 hour');
  INSERT INTO leod_checkin_job_runs (job_name, started_at, finished_at, status) VALUES
    ('probe_overdue', now() - interval '2 hours',  now() - interval '2 hours', 'ok'),
    ('probe_failing', now() - interval '50 minutes', now(), 'ok'),
    ('probe_failing', now() - interval '20 minutes', now(), 'failed'),
    ('probe_failing', now() - interval '10 minutes', now(), 'failed'),
    ('probe_fine',    now() - interval '5 minutes',  now(), 'ok'),
    ('probe_rogue',   now() - interval '5 minutes',  now(), 'ok');
  -- Started fresh but never finished: only 'running' rows, no success.
  INSERT INTO leod_checkin_job_runs (job_name, started_at, status) VALUES
    ('probe_crashing', now() - interval '30 minutes', 'running'),
    ('probe_crashing', now() - interval '5 minutes',  'running');

  r := public.checkin_brain_signals(now());
  FOR j IN SELECT * FROM jsonb_array_elements(r->'watchers'->'jobs') LOOP
    IF want ? (j->>'job') AND j->>'status' <> want->>(j->>'job') THEN
      RAISE EXCEPTION 'PROBE_FAIL job % status %, want %', j->>'job', j->>'status', want->>(j->>'job');
    END IF;
    IF j->>'job' = 'probe_failing' AND (j->>'consecutive_failures')::int <> 2 THEN
      RAISE EXCEPTION 'PROBE_FAIL probe_failing consecutive_failures %, want 2', j->>'consecutive_failures';
    END IF;
  END LOOP;
  IF NOT (r->'watchers'->'unregistered_runs') ? 'probe_rogue' THEN
    RAISE EXCEPTION 'PROBE_FAIL probe_rogue not listed as unregistered: %', r->'watchers'->'unregistered_runs';
  END IF;
  IF to_regclass('cron.job_run_details') IS NULL AND r->'watchers'->'pg_cron' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'PROBE_FAIL pg_cron should be null when pg_cron is absent, got %', r->'watchers'->'pg_cron';
  END IF;
  RAISE EXCEPTION 'PROBE_OK S4 watchers %', r->'watchers'->'jobs';
END
$probe$;

-- S5. p_since in the future is refused, not answered with zeros.
DO $probe$
BEGIN
  PERFORM public.checkin_brain_signals(now() + interval '1 hour');
  RAISE EXCEPTION 'PROBE_FAIL future p_since accepted';
EXCEPTION WHEN invalid_parameter_value THEN
  RAISE EXCEPTION 'PROBE_OK S5 future p_since refused';
END
$probe$;

-- S6. A stalled checkout is reported once: opened 30 h ago (inside the
--     window for p_since = now() - 24h) counts; opened 50 h ago or 2 h
--     ago does not; a paid one is in the denominator only.
DO $probe$
DECLARE
  u UUID := gen_random_uuid();
  e_in UUID := gen_random_uuid();
  e_old UUID := gen_random_uuid();
  e_new UUID := gen_random_uuid();
  e_paid UUID := gen_random_uuid();
  base INT;
  base_of INT;
  r JSONB;
BEGIN
  r := public.checkin_brain_signals(now() - interval '24 hours');
  base    := (r->'money'->'stalled_checkouts'->>'count')::int;
  base_of := (r->'money'->'stalled_checkouts'->>'of')::int;

  INSERT INTO auth.users (id, email, created_at, aud, role)
  VALUES (u, 'probe-075-s6@probe.invalid', now(), 'authenticated', 'authenticated');
  INSERT INTO leod_events (id, name, date, event_start, event_end, created_by, created_via) VALUES
    (e_in,   'probe 075 s6 in',   current_date + 30, '09:00', '18:00', u, 'checkin'),
    (e_old,  'probe 075 s6 old',  current_date + 30, '09:00', '18:00', u, 'checkin'),
    (e_new,  'probe 075 s6 new',  current_date + 30, '09:00', '18:00', u, 'checkin'),
    (e_paid, 'probe 075 s6 paid', current_date + 30, '09:00', '18:00', u, 'checkin');
  -- opened = checkout_expires_at - 1 h
  INSERT INTO leod_checkin_entitlements (event_id, status, checkout_session_id, checkout_expires_at) VALUES
    (e_in,   'test', 'cs_probe_075_s6_in',   now() - interval '29 hours'),
    (e_old,  'test', 'cs_probe_075_s6_old',  now() - interval '49 hours'),
    (e_new,  'test', 'cs_probe_075_s6_new',  now() - interval '1 hour'),
    (e_paid, 'live', 'cs_probe_075_s6_paid', now() - interval '29 hours');
  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id, paid_at)
  VALUES (e_paid, u, 'cs_probe_075_s6_paid', now() - interval '29 hours');

  r := public.checkin_brain_signals(now() - interval '24 hours');
  IF (r->'money'->'stalled_checkouts'->>'count')::int - base <> 1
     OR (r->'money'->'stalled_checkouts'->>'of')::int - base_of <> 2 THEN
    RAISE EXCEPTION 'PROBE_FAIL stalled_checkouts % (baseline count % of %), want +1 of +2',
      r->'money'->'stalled_checkouts', base, base_of;
  END IF;
  RAISE EXCEPTION 'PROBE_OK S6 stalled checkout reported once';
END
$probe$;

-- S7. Event day uses the event's own time zone: an event whose local
--     date is today in UTC+14 is included even when its date is
--     tomorrow in UTC.
DO $probe$
DECLARE
  u UUID := gen_random_uuid();
  e UUID := gen_random_uuid();
  a UUID := gen_random_uuid();
  r JSONB;
BEGIN
  INSERT INTO auth.users (id, email, created_at, aud, role)
  VALUES (u, 'probe-075-s7@probe.invalid', now(), 'authenticated', 'authenticated');
  INSERT INTO leod_events (id, name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES (e, 'probe 075 s7', (now() AT TIME ZONE 'Pacific/Kiritimati')::date, '00:00', '23:59',
          'Pacific/Kiritimati', u, 'checkin');
  INSERT INTO leod_checkin_entitlements (event_id, status, went_live_at) VALUES (e, 'live', now());
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, qr_token)
  VALUES (a, e, 'Probe', 'Guest', 'probe-075-' || gen_random_uuid());
  INSERT INTO leod_checkin_scan_events (id, event_id, attendee_id, scanned_at, received_at, result)
  VALUES (gen_random_uuid(), e, a, now(), now() + interval '90 seconds', 'ok');

  r := public.checkin_brain_signals(now());
  IF (r->'event_day'->'scans'->>'total')::int <> 1 OR r->'event_day'->'late_sync'->'count' <> '1'::jsonb THEN
    RAISE EXCEPTION 'PROBE_FAIL UTC+14 event not in event_day or late sync missed: %', r->'event_day';
  END IF;
  RAISE EXCEPTION 'PROBE_OK S7 event day follows the event time zone';
END
$probe$;
