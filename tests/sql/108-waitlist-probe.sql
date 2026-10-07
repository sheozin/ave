-- tests/sql/108-waitlist-probe.sql: waitlist and approval. Ends in 'PROBE OK 108'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
  v_n    int;
  v_id   uuid;
  v_ok   boolean;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_registration_flow(E, true, false); RAISE EXCEPTION 'stranger set flow'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_held_list(E); RAISE EXCEPTION 'stranger listed held'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_held_remove(E, gen_random_uuid()); RAISE EXCEPTION 'stranger removed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  DELETE FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  v_code := (checkin_set_registration(E, true, 1, NULL, '[]'))->>'code';
  PERFORM checkin_set_registration_flow(E, true, false);
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── test mode ──
  IF checkin_web_request(v_code, 'First', 'In', 'first.in@example.invalid', NULL, '{}', repeat('a', 64))->>'status' <> 'registered' THEN RAISE EXCEPTION 'first in'; END IF;
  v_res := checkin_web_request(v_code, 'Wait', 'Er', 'wait.er@example.invalid', NULL, '{}', repeat('b', 64));
  IF v_res->>'status' <> 'waitlisted' THEN RAISE EXCEPTION 'test waitlist: %', v_res; END IF;
  -- A listed address gets the same answer and nothing is held for it.
  IF checkin_web_request(v_code, 'First', 'In', 'first.in@example.invalid', NULL, '{}', repeat('c', 64))->>'status' <> 'waitlisted' THEN RAISE EXCEPTION 'listed address answered differently'; END IF;
  IF (SELECT count(*) FROM leod_checkin_held WHERE event_id = E AND lower(email) = 'first.in@example.invalid') <> 0 THEN RAISE EXCEPTION 'listed address held'; END IF;

  -- Approval (not full): held as approval.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, NULL, NULL, '[]');
  PERFORM checkin_set_registration_flow(E, false, true);
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_request(v_code, 'Appr', 'Ove', 'appr.ove@example.invalid', NULL, '{}', repeat('d', 64))->>'status' <> 'awaiting_approval' THEN RAISE EXCEPTION 'approval'; END IF;

  -- Organizer sees both, removes one, the service releases the other.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_res := checkin_held_list(E);
  IF jsonb_array_length(v_res) <> 2 THEN RAISE EXCEPTION 'held list: %', v_res; END IF;
  SELECT id INTO v_id FROM leod_checkin_held WHERE event_id = E AND lower(email) = 'wait.er@example.invalid';
  IF NOT checkin_held_remove(E, v_id) THEN RAISE EXCEPTION 'remove'; END IF;
  SELECT id INTO v_id FROM leod_checkin_held WHERE event_id = E AND lower(email) = 'appr.ove@example.invalid';
  PERFORM set_config('request.jwt.claims', '', true);
  v_res := checkin_web_release_held(E, v_id);
  IF v_res->>'status' <> 'released' OR v_res->>'kind' <> 'approval' OR NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'appr.ove@example.invalid' AND source = 'web') THEN
    RAISE EXCEPTION 'release: %', v_res;
  END IF;
  IF checkin_web_release_held(E, v_id)->>'status' <> 'not_found' THEN RAISE EXCEPTION 'released twice'; END IF;

  -- ── live: waitlist after confirm, with a position ──
  INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, is_test, consent_at) VALUES (E, 'waitlist', 'T', 'T', 'test.held@example.invalid', true, now());
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  IF EXISTS (SELECT 1 FROM leod_checkin_held WHERE event_id = E AND is_test) THEN RAISE EXCEPTION 'test held rows survived go-live'; END IF;
  DELETE FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND NOT is_test;
  PERFORM checkin_set_registration(E, true, GREATEST(v_n, 1), NULL, '[]');
  PERFORM checkin_set_registration_flow(E, true, false);
  PERFORM set_config('request.jwt.claims', '', true);
  IF v_n = 0 THEN
    INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
    VALUES (E, 'Fill', 'Er', 'fill.er@example.invalid', replace(gen_random_uuid()::text, '-', ''), 'import', false);
  END IF;
  v_res := checkin_web_request(v_code, 'Live', 'Wait', 'live.wait@example.invalid', NULL, '{}', repeat('e', 64));
  IF v_res->>'status' <> 'pending' OR v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'live full + waitlist must still take the request: %', v_res; END IF;
  v_res := checkin_web_confirm(v_code, repeat('e', 64));
  IF v_res->>'status' <> 'waitlisted' OR (v_res->>'position')::int < 1 THEN RAISE EXCEPTION 'live waitlisted: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_held WHERE event_id = E AND kind = 'waitlist' AND NOT is_test AND lower(email) = 'live.wait@example.invalid') THEN RAISE EXCEPTION 'not held'; END IF;
  -- Without a waitlist, full is full.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration_flow(E, false, false);
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_request(v_code, 'No', 'Wait', 'no.wait@example.invalid', NULL, '{}', repeat('f', 64))->>'status' <> 'full' THEN RAISE EXCEPTION 'full without waitlist'; END IF;

  -- The guards this migration touches (the probe flips the event to live
  -- without a purchase, which the billing guard rightly reports).
  SELECT bool_and(ok) INTO v_ok FROM checkin_guard_results() WHERE guard IN ('checkin_rpcs_refuse_strangers', 'checkin_web_paths_private', 'admin_rpcs_not_anon');
  IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok AND guard <> 'live_events_have_purchase'); END IF;
  RAISE EXCEPTION 'PROBE OK 108';
END;
$probe$;
