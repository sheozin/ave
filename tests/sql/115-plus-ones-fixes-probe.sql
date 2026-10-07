-- tests/sql/115-plus-ones-fixes-probe.sql. Ends in 'PROBE OK 115'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
  v_i    int;
  FIVE   CONSTANT jsonb := '[{"first_name":"A","last_name":"A"},{"first_name":"B","last_name":"B"},{"first_name":"C","last_name":"C"},{"first_name":"D","last_name":"D"},{"first_name":"E","last_name":"E"}]';
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'test', registration_approval = false, registration_waitlist = false, registration_plus_ones = 5 WHERE event_id = E;
  DELETE FROM leod_checkin_ticket_types WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);
  -- 1. Four parties of six fill 24 of 25; the fifth does not fit.
  FOR v_i IN 1..4 LOOP
    IF checkin_web_request(v_code, 'P', 'P' || v_i, 'p' || v_i || '@example.invalid', NULL, '{}', repeat('a', 64), NULL, FIVE)->>'status' <> 'registered' THEN RAISE EXCEPTION 'party %', v_i; END IF;
  END LOOP;
  IF checkin_web_request(v_code, 'P', 'P5', 'p5@example.invalid', NULL, '{}', repeat('a', 64), NULL, FIVE)->>'status' <> 'test_cap' THEN RAISE EXCEPTION 'test cap bypassed'; END IF;
  IF (SELECT count(*) FROM leod_checkin_attendees WHERE event_id = E AND is_test) > 25 THEN RAISE EXCEPTION 'over 25'; END IF;
  -- 3. No borrowed consent.
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND source = 'plus_one' AND consent_at IS NOT NULL) THEN RAISE EXCEPTION 'plus-one has consent'; END IF;
  -- 2. A lowered limit applies to requests already waiting.
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_request(v_code, 'Late', 'Change', 'late@example.invalid', NULL, '{}', repeat('b', 64), NULL, FIVE);
  UPDATE leod_checkin_entitlements SET registration_plus_ones = 1 WHERE event_id = E;
  v_res := checkin_web_confirm(v_code, repeat('b', 64));
  IF v_res->>'status' <> 'registered' OR jsonb_array_length(v_res->'plus_ones') <> 1 THEN RAISE EXCEPTION 'limit not applied at confirm: %', v_res; END IF;
  UPDATE leod_checkin_entitlements SET registration_approval = true, registration_plus_ones = 5 WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_request(v_code, 'Held', 'Change', 'heldc@example.invalid', NULL, '{}', repeat('c', 64), NULL, FIVE);
  PERFORM checkin_web_confirm(v_code, repeat('c', 64));
  UPDATE leod_checkin_entitlements SET registration_plus_ones = 0 WHERE event_id = E;
  v_res := checkin_web_release_held(E, (SELECT id FROM leod_checkin_held WHERE event_id = E AND lower(email) = 'heldc@example.invalid'));
  IF jsonb_array_length(v_res->'plus_ones') <> 0 THEN RAISE EXCEPTION 'limit not applied at release: %', v_res; END IF;
  RAISE EXCEPTION 'PROBE OK 115';
END;
$probe$;
