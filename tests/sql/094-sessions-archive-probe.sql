-- tests/sql/094-sessions-archive-probe.sql
-- Run after 094. Expected: an error whose message starts with 'PROBE OK 094'.
-- Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();
  v_ev     uuid;
  v_sid    uuid;
  v_row    jsonb;
  v_g      record;
  v_checks int := 0;
BEGIN
  -- 1. the guard passes now
  SELECT * INTO v_g FROM checkin_guard_results() WHERE guard = 'sessions_archive_has_every_column';
  IF v_g.ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'PROBE FAIL 1: guard %: %', v_g.ok, v_g.detail; END IF;
  -- and 092's guard is still there (094 is built on 092's body)
  IF NOT EXISTS (SELECT 1 FROM checkin_guard_results() WHERE guard = 'checkin_reports_not_parked') THEN
    RAISE EXCEPTION 'PROBE FAIL 1: checkin_reports_not_parked guard lost';
  END IF;
  v_checks := v_checks + 1;

  -- 2. a full leod_sessions row, as the cron sends it, lands in the archive
  INSERT INTO auth.users (id, email, aud, role)
  VALUES (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'authenticated', 'authenticated');
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 094', current_date - 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_sessions (event_id, sort_order, title, status,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe session', 'ENDED', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sid;
  SELECT to_jsonb(s) INTO v_row FROM leod_sessions s WHERE s.id = v_sid;
  IF v_row->'seq' IS NULL OR v_row->>'seq' IS NULL THEN RAISE EXCEPTION 'PROBE FAIL 2: no seq stamped'; END IF;
  INSERT INTO leod_sessions_archive
  SELECT * FROM jsonb_populate_record(NULL::leod_sessions_archive, v_row || jsonb_build_object('archived_at', now()));
  IF NOT EXISTS (SELECT 1 FROM leod_sessions_archive WHERE id = v_sid AND seq = (v_row->>'seq')::bigint
                   AND people = '[]'::jsonb AND status = 'ENDED') THEN
    RAISE EXCEPTION 'PROBE FAIL 2: archived row wrong';
  END IF;
  v_checks := v_checks + 1;

  -- 3. the guard catches a column the archive lacks, by exclusion
  ALTER TABLE leod_sessions ADD COLUMN probe_094_extra int;
  SELECT * INTO v_g FROM checkin_guard_results() WHERE guard = 'sessions_archive_has_every_column';
  IF v_g.ok IS DISTINCT FROM false OR v_g.detail NOT LIKE '%probe_094_extra%' THEN
    RAISE EXCEPTION 'PROBE FAIL 3: guard did not catch the new column: %', v_g.detail;
  END IF;
  v_checks := v_checks + 1;

  -- 4. the cron is registered and the watcher reports it (stale until its first run)
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_jobs WHERE job_name = 'session-cleanup' AND active
                   AND expected_interval = interval '25 hours') THEN
    RAISE EXCEPTION 'PROBE FAIL 4: job not registered';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(checkin_brain_signals(now() - interval '1 day')->'watchers'->'jobs') j
                  WHERE j->>'job' = 'session-cleanup') THEN
    RAISE EXCEPTION 'PROBE FAIL 4: watcher does not list session-cleanup: %',
      left((checkin_brain_signals(now() - interval '1 day'))::text, 300);
  END IF;
  -- a failed run reads as failing
  INSERT INTO leod_checkin_job_runs (job_name, started_at, finished_at, status, detail)
  VALUES ('session-cleanup', now(), now(), 'failed', '{"error":"probe"}');
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(checkin_brain_signals(now() - interval '1 day')->'watchers'->'jobs') j
                  WHERE j->>'job' = 'session-cleanup' AND j->>'status' = 'failing') THEN
    RAISE EXCEPTION 'PROBE FAIL 4: a failed run is not reported failing';
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 094: % checks passed', v_checks;
END
$probe$;
