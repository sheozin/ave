-- tests/sql/097-scanner-probe.sql
-- Run with `supabase db query --linked -f`. Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 097'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_door  uuid := gen_random_uuid();
  v_room  uuid := gen_random_uuid();
  v_dev   uuid := gen_random_uuid();
  v_a     uuid := gen_random_uuid();
  v_b     uuid := gen_random_uuid();
  v_r     text;
  v_j     jsonb;
  v_denied int := 0;
  r uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_crew, v_view, v_out]) u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 097', current_date, '00:00', '23:59', 'Europe/Warsaw', v_owner, 'checkin') RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_scan_points (id, event_id, name, code, kind, sort_order)
  VALUES (v_door, v_ev, 'Main door', 'DOOR', 'entrance', 1), (v_room, v_ev, 'Hall B', 'HALLB', 'interior', 2);
  INSERT INTO leod_checkin_devices (id, event_id, label, kind, scan_point_id, api_key_hash)
  VALUES (v_dev, v_ev, 'Door phone', 'scanner', v_door, md5(gen_random_uuid()::text));
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, qr_token) VALUES
    (v_a, v_ev, 'Ann', 'Probe', 'p097a' || replace(gen_random_uuid()::text, '-', '')),
    (v_b, v_ev, 'Bob', 'Probe', 'p097b' || replace(gen_random_uuid()::text, '-', ''));

  -- 1. A scanner scan stores its device and no operator; the old call shape still works.
  PERFORM set_config('request.jwt.claims', '', true);
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a, now(), 'checkin', NULL, NULL, v_door, true, NULL, v_dev);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'FAIL scanner scan %', v_r; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_scan_events WHERE attendee_id = v_a AND device_id = v_dev AND operator_id IS NULL AND scan_point_id = v_door) THEN
    RAISE EXCEPTION 'FAIL device not recorded'; END IF;
  SELECT checkin_apply_scan(p_event_id => v_ev, p_client_id => gen_random_uuid(), p_attendee_id => v_b,
                            p_scanned_at => now(), p_action => 'checkin', p_prev_checked_in_at => NULL,
                            p_operator_id => v_crew, p_scan_point_id => NULL, p_live_time_ok => true, p_desk_id => NULL) INTO v_r;
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'FAIL desk call shape %', v_r; END IF;
  -- Ann walks into Hall B: already checked in at the door, so 'duplicate', still attendance.
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a, now(), 'checkin', NULL, NULL, v_room, true, NULL, v_dev);
  IF v_r <> 'duplicate' THEN RAISE EXCEPTION 'FAIL session repeat %', v_r; END IF;

  -- 2. Scan point counts: viewer allowed, crew and stranger refused.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_j := checkin_scan_point_counts(v_ev);
  RESET ROLE;
  IF v_j->0->>'name' <> 'Main door' OR (v_j->0->>'people')::int <> 1
     OR v_j->1->>'name' <> 'Hall B' OR (v_j->1->>'people')::int <> 1 OR v_j->1->>'kind' <> 'interior' THEN
    RAISE EXCEPTION 'FAIL counts %', v_j; END IF;
  IF v_j::text ~ 'Ann|Bob|Probe' THEN RAISE EXCEPTION 'FAIL counts leak names'; END IF;

  -- 3. Scanning settings: organizer may turn the door on; session needs the plan; others refused.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_j := checkin_set_scanning(v_ev, true, NULL);
  IF NOT (v_j->>'entrance_scanning')::boolean OR (v_j->>'session_scanning')::boolean THEN RAISE EXCEPTION 'FAIL set door %', v_j; END IF;
  BEGIN
    PERFORM checkin_set_scanning(v_ev, NULL, true);
    RAISE EXCEPTION 'FAIL session allowed without the plan';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  RESET ROLE;
  UPDATE leod_checkin_entitlements SET multi_point_scanning = true WHERE event_id = v_ev;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_j := checkin_set_scanning(v_ev, NULL, true);
  RESET ROLE;
  IF NOT (v_j->>'session_scanning')::boolean OR NOT (v_j->>'entrance_scanning')::boolean THEN RAISE EXCEPTION 'FAIL set session %', v_j; END IF;
  IF (SELECT status FROM leod_checkin_entitlements WHERE event_id = v_ev) <> 'test' THEN RAISE EXCEPTION 'FAIL status moved'; END IF;

  FOREACH r IN ARRAY ARRAY[v_lead, v_crew, v_view, v_out] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM checkin_set_scanning(v_ev, false, false);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
  END LOOP;
  FOREACH r IN ARRAY ARRAY[v_crew, v_out] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM checkin_scan_point_counts(v_ev);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
  END LOOP;
  IF v_denied <> 6 THEN RAISE EXCEPTION 'FAIL denied %', v_denied; END IF;

  RAISE EXCEPTION 'PROBE OK 097';
END
$probe$;
