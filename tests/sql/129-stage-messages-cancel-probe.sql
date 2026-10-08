-- tests/sql/129-stage-messages-cancel-probe.sql
-- Run after 129. Expected: an error whose message starts with
-- 'PROBE OK 129'. Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_ev    uuid;
  v_sid   uuid;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  VALUES (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'authenticated', 'authenticated');
  INSERT INTO leod_users (id, email, role, invited_by, active)
  VALUES (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'director', NULL, true)
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 129', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_sessions (event_id, sort_order, title, room, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe queued', 'Main Stage', 'READY', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sid;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_ev, v_sid, 'Queued before cancel');
  RESET ROLE;

  -- 1. READY -> CANCELLED clears the queued message (as the system)
  UPDATE leod_sessions SET status = 'CANCELLED' WHERE id = v_sid;
  IF EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NOT NULL AND cleared_by IS NULL) THEN
    RAISE EXCEPTION 'PROBE FAIL 1: cancel did not clear the queued message';
  END IF;
  v_checks := v_checks + 1;

  -- 2. reinstated and live: nothing comes back
  UPDATE leod_sessions SET status = 'READY' WHERE id = v_sid;
  UPDATE leod_sessions SET status = 'LIVE' WHERE id = v_sid;
  IF EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'PROBE FAIL 2: an old message is active after reinstate';
  END IF;
  v_checks := v_checks + 1;

  -- 3. a queued message on READY still survives READY -> CALLING -> LIVE (128 behaviour kept)
  UPDATE leod_sessions SET status = 'READY' WHERE id = v_sid;
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_ev, v_sid, 'Still queued');
  RESET ROLE;
  UPDATE leod_sessions SET status = 'CALLING' WHERE id = v_sid;
  UPDATE leod_sessions SET status = 'LIVE' WHERE id = v_sid;
  IF NOT EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL AND text = 'Still queued') THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a queued message was cleared on the way to LIVE';
  END IF;
  v_checks := v_checks + 1;

  -- 4. guards still pass
  IF (SELECT count(*) FROM checkin_guard_results() WHERE NOT ok) <> 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 4: guards %', (SELECT string_agg(guard, ', ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 129: % checks passed', v_checks;
END
$probe$;
