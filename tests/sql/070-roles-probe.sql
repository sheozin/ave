-- tests/sql/070-roles-probe.sql
-- Run with the Supabase MCP execute_sql (one statement). Everything it
-- inserts is rolled back by the final RAISE. Expected: an error whose
-- message starts with 'PROBE OK 070'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_att   uuid := gen_random_uuid();
  v_n     int := 0;
  v_c     int;
  v_role  text;
  v_bool  boolean;
  v_name  text;
  v_venue text;
  v_ev2   uuid;
BEGIN
  -- Fixture (as the migration owner).
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_crew, v_view, v_out]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 070', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, qr_token, source)
  VALUES (v_att, v_ev, 'Ana', 'Probe', 'probe' || replace(gen_random_uuid()::text, '-', ''), 'walk_in');
  INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash)
  VALUES (v_ev, 'Probe kiosk', 'kiosk', 'probe' || gen_random_uuid());
  INSERT INTO leod_checkin_scan_points (event_id, name, code, kind) VALUES (v_ev, 'Main', 'MAIN', 'entrance');
  INSERT INTO leod_checkin_scan_events (id, event_id, attendee_id, scanned_at, result, client_id)
  VALUES (gen_random_uuid(), v_ev, v_att, now(), 'forbidden', gen_random_uuid());
  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id)
  VALUES (v_ev, v_owner, 'cs_probe_' || gen_random_uuid());
  v_n := v_n + 3;   -- lead/viewer roles, walk_in source and forbidden result were accepted

  BEGIN
    INSERT INTO leod_checkin_operators (event_id, user_id, role) VALUES (v_ev, v_out, 'owner');
    RAISE EXCEPTION 'PROBE FAIL: owner accepted as an operator role';
  EXCEPTION WHEN check_violation THEN v_n := v_n + 1;
  END;

  -- ── viewer ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_attendees WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % attendee rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % scan rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_devices WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % device rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_points WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % scan point rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % purchase rows', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_entitlements WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % entitlement rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_operators WHERE event_id = v_ev;
  IF v_c < 5 THEN RAISE EXCEPTION 'PROBE FAIL: viewer read % operator rows, want 5', v_c; END IF;
  SELECT role INTO v_role FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_role IS DISTINCT FROM 'viewer' THEN RAISE EXCEPTION 'PROBE FAIL: my_events gave viewer %', v_role; END IF;
  v_n := v_n + 8;
  BEGIN
    -- No attendee_id: checkin_validate_scan_event_refs (SECURITY INVOKER)
    -- would otherwise refuse first because a viewer cannot see attendees,
    -- and the check would pass without ever reaching checkin_se_write.
    INSERT INTO leod_checkin_scan_events (id, event_id, attendee_id, scanned_at, result, client_id)
    VALUES (gen_random_uuid(), v_ev, NULL, now(), 'unknown_token', gen_random_uuid());
    RAISE EXCEPTION 'PROBE FAIL: viewer inserted a scan event';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Renamed', NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'PROBE FAIL: viewer edited event details';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── lead ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_attendees WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % attendee rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % scan rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_devices WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % device rows, want 1', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: lead read % purchase rows', v_c; END IF;
  INSERT INTO leod_checkin_scan_points (event_id, name, code, kind) VALUES (v_ev, 'Side', 'SIDE', 'entrance');
  SELECT role INTO v_role FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_role IS DISTINCT FROM 'lead' THEN RAISE EXCEPTION 'PROBE FAIL: my_events gave lead %', v_role; END IF;
  v_n := v_n + 6;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Renamed', NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'PROBE FAIL: lead edited event details';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── crew ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_attendees WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: crew read % attendee rows, want 1', v_c; END IF;
  v_n := v_n + 1;
  BEGIN
    INSERT INTO leod_checkin_scan_points (event_id, name, code, kind) VALUES (v_ev, 'Crew', 'CREW', 'entrance');
    RAISE EXCEPTION 'PROBE FAIL: crew wrote a scan point';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── organizer (not the owner) ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: organizer read % purchase rows', v_c; END IF;
  PERFORM checkin_update_event_details(v_ev, '  Probe   renamed ', 'Hall B', NULL, NULL, '10:00', '17:00');
  v_n := v_n + 2;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Probe', NULL, NULL, 'Not/AZone', NULL, NULL);
    RAISE EXCEPTION 'PROBE FAIL: unknown timezone accepted';
  EXCEPTION WHEN invalid_parameter_value THEN v_n := v_n + 1;
  END;
  RESET ROLE;
  SELECT name INTO v_name FROM leod_events WHERE id = v_ev;
  IF v_name IS DISTINCT FROM 'Probe renamed' THEN RAISE EXCEPTION 'PROBE FAIL: name is %', v_name; END IF;
  v_n := v_n + 1;

  -- ── fix round 1: venue keep/clear, end after start, console events ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM checkin_update_event_details(v_ev, 'Probe renamed', NULL, NULL, NULL, NULL, NULL);
  RESET ROLE;
  SELECT venue INTO v_venue FROM leod_events WHERE id = v_ev;
  IF v_venue IS DISTINCT FROM 'Hall B' THEN RAISE EXCEPTION 'PROBE FAIL: venue NULL gave %, want Hall B kept', v_venue; END IF;
  v_n := v_n + 1;
  SET LOCAL ROLE authenticated;
  PERFORM checkin_update_event_details(v_ev, 'Probe renamed', '', NULL, NULL, NULL, NULL);
  RESET ROLE;
  SELECT venue INTO v_venue FROM leod_events WHERE id = v_ev;
  IF v_venue IS NOT NULL THEN RAISE EXCEPTION 'PROBE FAIL: venue empty string gave %, want NULL', v_venue; END IF;
  v_n := v_n + 1;
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Probe renamed', NULL, NULL, NULL, '12:00', '12:00');
    RAISE EXCEPTION 'PROBE FAIL: end equal to start accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    IF SQLERRM <> 'The event must end at a different time than it starts' THEN RAISE; END IF;
    v_n := v_n + 1;
  END;
  -- Overnight: 22:00 to 02:00 is accepted (the end is the next day).
  PERFORM checkin_update_event_details(v_ev, 'Probe renamed', NULL, NULL, NULL, '22:00', '02:00');
  RESET ROLE;
  SELECT name INTO v_name FROM leod_events WHERE id = v_ev AND event_start = '22:00' AND event_end = '02:00';
  IF v_name IS NULL THEN RAISE EXCEPTION 'PROBE FAIL: overnight 22:00 to 02:00 not stored'; END IF;
  v_n := v_n + 1;
  -- A console event owned by v_owner, where v_org is also an organizer.
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 070 console', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'console')
  RETURNING id INTO v_ev2;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev2, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role) VALUES (v_ev2, v_org, 'organizer');
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_update_event_details(v_ev2, 'Hijacked', NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'PROBE FAIL: non-owner organizer edited a console event';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM <> 'Only the event owner can edit a console event' THEN RAISE; END IF;
    v_n := v_n + 1;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM checkin_update_event_details(v_ev2, 'Console renamed', NULL, NULL, NULL, NULL, NULL);
  RESET ROLE;
  SELECT name INTO v_name FROM leod_events WHERE id = v_ev2;
  IF v_name IS DISTINCT FROM 'Console renamed' THEN RAISE EXCEPTION 'PROBE FAIL: owner could not edit own console event (%)', v_name; END IF;
  v_n := v_n + 1;

  -- ── owner ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_c FROM leod_checkin_purchases WHERE event_id = v_ev;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: owner read % purchase rows, want 1', v_c; END IF;
  IF NOT checkin_is_owner(v_ev) THEN RAISE EXCEPTION 'PROBE FAIL: owner is not owner'; END IF;
  SELECT role, is_owner INTO v_role, v_bool FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_role IS DISTINCT FROM 'owner' OR v_bool IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROBE FAIL: owner row is (%, %), want (owner, true)', v_role, v_bool;
  END IF;
  v_n := v_n + 3;
  RESET ROLE;

  -- ── outsider ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_out, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF checkin_is_owner(v_ev) THEN RAISE EXCEPTION 'PROBE FAIL: outsider is owner'; END IF;
  SELECT count(*) INTO v_c FROM checkin_my_events() WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: outsider sees the event'; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_entitlements WHERE event_id = v_ev;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: outsider read the entitlement'; END IF;
  v_n := v_n + 3;
  RESET ROLE;

  -- ── anon cannot call the owner helper at all ──
  PERFORM set_config('request.jwt.claims', '', true);
  SET LOCAL ROLE anon;
  BEGIN
    PERFORM checkin_is_owner(v_ev);
    RAISE EXCEPTION 'PROBE FAIL: anon called checkin_is_owner';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  RAISE EXCEPTION 'PROBE OK 070: % checks passed (rolled back)', v_n;
END
$probe$;
