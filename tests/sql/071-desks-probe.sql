-- tests/sql/071-desks-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 071'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_crew2 uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_a1    uuid := gen_random_uuid();
  v_a2    uuid := gen_random_uuid();
  v_a3    uuid := gen_random_uuid();
  v_d1    uuid := gen_random_uuid();
  v_d2    uuid := gen_random_uuid();
  v_t1    timestamptz := date_trunc('second', now()) - interval '10 minutes';
  v_t2    timestamptz := date_trunc('second', now()) - interval '9 minutes';
  v_t3    timestamptz := date_trunc('second', now()) - interval '8 minutes';
  v_r     text;
  v_label text;
  v_n     int := 0;
  v_c     int;
  v_ts    timestamptz;
  v_pend  int;
  v_op    uuid;
  v_test  boolean;
  v_t4    timestamptz := date_trunc('second', now()) - interval '7 minutes';
  v_cid   uuid := gen_random_uuid();
  v_d3    uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_crew, v_crew2, v_view, v_out]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 071', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'),
         (v_ev, v_crew2, 'crew'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, qr_token)
  VALUES (v_a1, v_ev, 'One', 'Probe', 'p1' || replace(gen_random_uuid()::text, '-', '')),
         (v_a2, v_ev, 'Two', 'Probe', 'p2' || replace(gen_random_uuid()::text, '-', '')),
         (v_a3, v_ev, 'Three', 'Probe', 'p3' || replace(gen_random_uuid()::text, '-', ''));

  -- ── heartbeat as desk staff ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_label := checkin_desk_heartbeat(v_ev, v_d1, NULL, 3);
  IF v_label IS DISTINCT FROM 'Desk 1' THEN RAISE EXCEPTION 'PROBE FAIL: first desk is %', v_label; END IF;
  v_label := checkin_desk_heartbeat(v_ev, v_d2, NULL, 0);
  IF v_label IS DISTINCT FROM 'Desk 2' THEN RAISE EXCEPTION 'PROBE FAIL: second desk is %', v_label; END IF;
  v_label := checkin_desk_heartbeat(v_ev, v_d1, '  Front   desk ', 0);
  IF v_label IS DISTINCT FROM 'Front desk' THEN RAISE EXCEPTION 'PROBE FAIL: rename gave %', v_label; END IF;
  v_label := checkin_desk_heartbeat(v_ev, v_d1, NULL, 2);
  IF v_label IS DISTINCT FROM 'Front desk' THEN RAISE EXCEPTION 'PROBE FAIL: label not kept, %', v_label; END IF;
  v_n := v_n + 4;
  BEGIN
    PERFORM checkin_desk_heartbeat(v_ev, v_d1, NULL, -1);
    RAISE EXCEPTION 'PROBE FAIL: negative pending count accepted';
  EXCEPTION WHEN invalid_parameter_value THEN v_n := v_n + 1;
  END;
  BEGIN
    SELECT count(*) INTO v_c FROM leod_checkin_desks;
    RAISE EXCEPTION 'PROBE FAIL: authenticated read leod_checkin_desks directly';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  BEGIN
    PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_a1, v_t1, 'checkin', NULL, v_crew, NULL, true, v_d1);
    RAISE EXCEPTION 'PROBE FAIL: authenticated called checkin_apply_scan';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;
  SELECT pending_count, operator_id, is_test INTO v_pend, v_op, v_test
    FROM leod_checkin_desks WHERE event_id = v_ev AND desk_id = v_d1;
  IF v_pend <> 2 OR v_op <> v_crew OR v_test IS NOT TRUE THEN
    RAISE EXCEPTION 'PROBE FAIL: desk row is (%, %, %)', v_pend, v_op, v_test;
  END IF;
  v_n := v_n + 1;

  -- ── viewer and outsider cannot report a desk ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_desk_heartbeat(v_ev, gen_random_uuid(), NULL, 0);
    RAISE EXCEPTION 'PROBE FAIL: viewer reported a desk';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_out, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_desk_heartbeat(v_ev, gen_random_uuid(), NULL, 0);
    RAISE EXCEPTION 'PROBE FAIL: outsider reported a desk';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── checkin_apply_scan, as the service role would call it ──
  PERFORM set_config('request.jwt.claims', '', true);
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a1, v_t1, 'checkin', NULL, v_crew, NULL, true, v_d1);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: crew check-in gave %', v_r; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE event_id = v_ev AND desk_id = v_d1;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: desk_id not stored (% rows)', v_c; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a1, v_t1 + interval '30 seconds', 'undo', v_t1, v_crew, NULL, true, v_d1);
  IF v_r <> 'undo' THEN RAISE EXCEPTION 'PROBE FAIL: crew undo of own gave %', v_r; END IF;
  v_n := v_n + 3;

  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t2, 'checkin', NULL, v_org, NULL, true, NULL);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: organizer check-in gave %', v_r; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t2 + interval '30 seconds', 'undo', v_t2, v_crew, NULL, true, v_d1);
  IF v_r <> 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL: crew undo of organizer check-in gave %', v_r; END IF;
  SELECT checked_in_at INTO v_ts FROM leod_checkin_attendees WHERE id = v_a2;
  IF v_ts IS DISTINCT FROM v_t2 THEN RAISE EXCEPTION 'PROBE FAIL: forbidden undo changed checked_in_at to %', v_ts; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_scan_events WHERE attendee_id = v_a2 AND result = 'forbidden';
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: forbidden undo not recorded (% rows)', v_c; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t2 + interval '40 seconds', 'undo', v_t2, v_lead, NULL, true, NULL);
  IF v_r <> 'undo' THEN RAISE EXCEPTION 'PROBE FAIL: lead undo of anyone gave %', v_r; END IF;
  v_n := v_n + 5;

  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a3, v_t3, 'checkin', NULL, v_crew2, NULL, true, v_d2);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: second crew check-in gave %', v_r; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a3, v_t3 + interval '30 seconds', 'undo', v_t3, v_crew, NULL, true, v_d1);
  IF v_r <> 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL: crew undo of another crew gave %', v_r; END IF;
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a3, v_t3 + interval '40 seconds', 'undo', v_t3, v_owner, NULL, true, NULL);
  IF v_r <> 'undo' THEN RAISE EXCEPTION 'PROBE FAIL: owner undo gave %', v_r; END IF;
  v_n := v_n + 3;

  -- The call shape the deployed checkin-record-scans still uses (no p_desk_id).
  SELECT checkin_apply_scan(p_event_id => v_ev, p_client_id => gen_random_uuid(), p_attendee_id => v_a1,
                            p_scanned_at => v_t1 + interval '5 minutes', p_action => 'checkin',
                            p_prev_checked_in_at => NULL, p_operator_id => v_crew, p_scan_point_id => NULL,
                            p_live_time_ok => true) INTO v_r;
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: old call shape gave %', v_r; END IF;
  v_n := v_n + 1;

  -- ── Fix round 1: clients cannot forge a verdict row ──
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t4, 'checkin', NULL, v_crew2, NULL, true, v_d2);
  IF v_r <> 'ok' THEN RAISE EXCEPTION 'PROBE FAIL: re-check-in by second crew gave %', v_r; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO leod_checkin_scan_events (id, event_id, client_id, attendee_id, operator_id, scanned_at, result, is_test)
    VALUES (gen_random_uuid(), v_ev, gen_random_uuid(), v_a2, v_crew, v_t4, 'ok', false);
    RAISE EXCEPTION 'PROBE FAIL: crew forged an ok scan row';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  INSERT INTO leod_checkin_scan_events (id, event_id, client_id, attendee_id, operator_id, scanned_at, result, is_test)
  VALUES (gen_random_uuid(), v_ev, v_cid, NULL, v_crew2, v_t4, 'unknown_token', false);
  RESET ROLE;
  SELECT operator_id INTO v_op FROM leod_checkin_scan_events WHERE client_id = v_cid;
  IF v_op IS DISTINCT FROM v_crew THEN RAISE EXCEPTION 'PROBE FAIL: direct insert kept operator %', v_op; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  v_r := checkin_apply_scan(v_ev, gen_random_uuid(), v_a2, v_t4 + interval '30 seconds', 'undo', v_t4, v_crew, NULL, true, v_d1);
  IF v_r <> 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL: crew undo after forge attempt gave %', v_r; END IF;
  v_n := v_n + 2;

  -- ── Fix round 1: go-live clears test desks only ──
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, is_test)
  VALUES (v_ev, v_d3, 'Live desk', v_crew, false);
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = v_ev;
  SELECT count(*) INTO v_c FROM leod_checkin_desks WHERE event_id = v_ev AND is_test;
  IF v_c <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: % test desks survived go-live', v_c; END IF;
  SELECT count(*) INTO v_c FROM leod_checkin_desks WHERE event_id = v_ev AND NOT is_test;
  IF v_c <> 1 THEN RAISE EXCEPTION 'PROBE FAIL: go-live left % live desks, expected 1', v_c; END IF;
  v_n := v_n + 1;

  RAISE EXCEPTION 'PROBE OK 071: % checks passed (rolled back)', v_n;
END
$probe$;
