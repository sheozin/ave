-- tests/sql/114-plus-ones-probe.sql. Ends in 'PROBE OK 114'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
  v_n    int;
  v_host uuid;
  v_held uuid;
  TWO    CONSTANT jsonb := '[{"first_name":"Ola","last_name":"Nowak"},{"first_name":"Jan","last_name":"Kim"}]';
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'test', registration_approval = false, registration_waitlist = false WHERE event_id = E;
  DELETE FROM leod_checkin_ticket_types WHERE event_id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_plus_ones(E, 2); RAISE EXCEPTION 'stranger set'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_plus_ones(E, 9); RAISE EXCEPTION 'nine accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM checkin_set_plus_ones(E, 1);
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);

  -- The limit holds whatever is sent: one of two plus-ones is kept.
  IF jsonb_array_length(checkin_web_plus_ones(TWO, 1)) <> 1 OR jsonb_array_length(checkin_web_plus_ones('"x"', 3)) <> 0 THEN RAISE EXCEPTION 'plus_ones shape'; END IF;

  -- Test mode: the guest and one plus-one, the plus-one tied to them.
  IF checkin_web_request(v_code, 'Maya', 'L', 'maya@example.invalid', NULL, '{}', repeat('a', 64), NULL, TWO)->>'status' <> 'registered' THEN RAISE EXCEPTION 'test register'; END IF;
  SELECT id INTO v_host FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'maya@example.invalid';
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE plus_one_of = v_host AND source = 'plus_one' AND email IS NULL AND is_test;
  IF v_n <> 1 THEN RAISE EXCEPTION 'test plus-ones: %', v_n; END IF;

  -- Live: capacity counts the party.
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND NOT is_test;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, v_n + 1, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_request(v_code, 'Two', 'People', 'two@example.invalid', NULL, '{}', repeat('b', 64), NULL, TWO)->>'status' <> 'full' THEN RAISE EXCEPTION 'party of two fit one place'; END IF;
  IF checkin_web_request(v_code, 'Solo', 'Guest', 'solo@example.invalid', NULL, '{}', repeat('c', 64), NULL, '[]')->>'send' <> 'true' THEN RAISE EXCEPTION 'solo request'; END IF;

  -- Room for two: confirm creates the guest and the plus-one.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, v_n + 3, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_request(v_code, 'Pair', 'Lead', 'pair@example.invalid', NULL, '{}', repeat('d', 64), NULL, TWO)->>'send' <> 'true' THEN RAISE EXCEPTION 'pair request'; END IF;
  v_res := checkin_web_confirm(v_code, repeat('d', 64));
  IF v_res->>'status' <> 'registered' OR jsonb_array_length(v_res->'plus_ones') <> 1 OR v_res->'plus_ones'->0->>'qr_token' IS NULL THEN RAISE EXCEPTION 'confirm: %', v_res; END IF;
  -- Removing the guest removes their plus-one.
  DELETE FROM leod_checkin_attendees WHERE id = (v_res->'attendee'->>'id')::uuid;
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE id = (v_res->'plus_ones'->0->>'id')::uuid) THEN RAISE EXCEPTION 'orphan plus-one'; END IF;

  -- Approval: the plus-ones wait with the guest and come with them.
  UPDATE leod_checkin_entitlements SET registration_approval = true, registration_capacity = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_request(v_code, 'Held', 'Guest', 'held@example.invalid', NULL, '{}', repeat('e', 64), NULL, TWO);
  IF checkin_web_confirm(v_code, repeat('e', 64))->>'status' <> 'awaiting_approval' THEN RAISE EXCEPTION 'approval'; END IF;
  SELECT id INTO v_held FROM leod_checkin_held WHERE event_id = E AND lower(email) = 'held@example.invalid' AND jsonb_array_length(plus_ones) = 1;
  IF v_held IS NULL THEN RAISE EXCEPTION 'held without plus-ones'; END IF;
  v_res := checkin_web_release_held(E, v_held);
  IF v_res->>'status' <> 'released' OR jsonb_array_length(v_res->'plus_ones') <> 1 THEN RAISE EXCEPTION 'release: %', v_res; END IF;

  -- A paid ticket takes no plus-ones.
  INSERT INTO leod_checkin_payout_accounts (user_id, stripe_account_id, charges_enabled) VALUES (v_own, 'acct_PROBE114test', true) ON CONFLICT (user_id) DO UPDATE SET charges_enabled = true;
  UPDATE leod_checkin_entitlements SET registration_approval = false WHERE event_id = E;
  INSERT INTO leod_checkin_ticket_types (event_id, name, price_cents, currency) VALUES (E, 'Paid', 2000, 'eur');
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_request(v_code, 'Payer', 'One', 'payer@example.invalid', NULL, '{}', repeat('f', 64),
    (SELECT id FROM leod_checkin_ticket_types WHERE event_id = E AND name = 'Paid'), TWO);
  IF (SELECT jsonb_array_length(plus_ones) FROM leod_checkin_web_pending WHERE event_id = E AND lower(email) = 'payer@example.invalid') <> 0 THEN RAISE EXCEPTION 'paid kept plus-ones'; END IF;

  IF NOT (SELECT bool_and(ok) FROM checkin_guard_results() WHERE guard IN ('checkin_rpcs_refuse_strangers', 'checkin_web_paths_private')) THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  RAISE EXCEPTION 'PROBE OK 114';
END;
$probe$;
