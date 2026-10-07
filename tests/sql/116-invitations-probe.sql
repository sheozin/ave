-- tests/sql/116-invitations-probe.sql. Ends in 'PROBE OK 116'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
  v_g    uuid;
  v_web  uuid;
  H1     CONSTANT text := repeat('1', 64);
  H2     CONSTANT text := repeat('2', 64);
  i      int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live', registration_approval = false, registration_waitlist = false,
         registration_plus_ones = 2, registration_capacity = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_ticket_types WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_registration_mode(E, 'invite'); RAISE EXCEPTION 'stranger mode'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_invite_status(E); RAISE EXCEPTION 'stranger status'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM checkin_set_registration_mode(E, 'invite');
  PERFORM set_config('request.jwt.claims', '', true);

  -- The public form is closed to registrations; with approval it takes requests.
  IF checkin_web_request(v_code, 'Walk', 'Up', 'walkup@example.invalid', NULL, '{}', repeat('a', 64))->>'status' <> 'invite_only' THEN RAISE EXCEPTION 'open while invite-only'; END IF;
  UPDATE leod_checkin_entitlements SET registration_approval = true WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  IF checkin_web_request(v_code, 'Asks', 'Nicely', 'asks@example.invalid', NULL, '{}', repeat('b', 64))->>'send' <> 'true' THEN RAISE EXCEPTION 'request with approval'; END IF;
  IF checkin_web_confirm(v_code, repeat('b', 64))->>'status' <> 'awaiting_approval' THEN RAISE EXCEPTION 'request not held'; END IF;
  UPDATE leod_checkin_entitlements SET registration_approval = false WHERE event_id = E;

  -- Only the organizer's own guests with an email can be invited.
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Gina', 'Guest', 'gina@example.invalid', 'tok-inv-1', 'import', false) RETURNING id INTO v_g;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Self', 'Reg', 'self@example.invalid', 'tok-inv-2', 'web', false) RETURNING id INTO v_web;
  IF checkin_web_invite_issue(E, v_web, H1)->>'status' <> 'not_invitable' THEN RAISE EXCEPTION 'self-registration invited'; END IF;
  IF checkin_web_invite_issue(E, v_g, H1)->>'status' <> 'issued' THEN RAISE EXCEPTION 'issue'; END IF;
  -- Sending again: the previous link keeps working beside the new one (118);
  -- a second resend retires the oldest.
  UPDATE leod_checkin_web_invites SET sent_at = now() - interval '11 minutes' WHERE attendee_id = v_g;  -- (120) past the 10 minute gap
  UPDATE leod_checkin_web_mail SET sent_at = sent_at - interval '11 minutes' WHERE event_id = E AND kind = 'invite';  -- (121) the address limit too
  PERFORM checkin_web_invite_issue(E, v_g, H2);
  IF checkin_web_invite_view(v_code, H1)->>'status' <> 'ok' THEN RAISE EXCEPTION 'previous link dropped on resend'; END IF;
  UPDATE leod_checkin_web_invites SET sent_at = now() - interval '11 minutes' WHERE attendee_id = v_g;  -- (120) past the 10 minute gap
  UPDATE leod_checkin_web_mail SET sent_at = sent_at - interval '11 minutes' WHERE event_id = E AND kind = 'invite';  -- (121) the address limit too
  PERFORM checkin_web_invite_issue(E, v_g, repeat('3', 64));
  IF checkin_web_invite_view(v_code, H1)->>'status' <> 'invalid' THEN RAISE EXCEPTION 'oldest link still works'; END IF;
  UPDATE leod_checkin_web_invites SET sent_at = now() - interval '11 minutes' WHERE attendee_id = v_g;  -- (120) past the 10 minute gap
  UPDATE leod_checkin_web_mail SET sent_at = sent_at - interval '11 minutes' WHERE event_id = E AND kind = 'invite';  -- (121) the address limit too
  PERFORM checkin_web_invite_issue(E, v_g, H2);
  v_res := checkin_web_invite_view(v_code, H2);
  IF v_res->>'first_name' <> 'Gina' OR (v_res->>'plus_max')::int <> 2 OR v_res->>'rsvp' IS NOT NULL THEN RAISE EXCEPTION 'view: %', v_res; END IF;

  -- Going with two plus-ones (three named, the limit keeps two).
  v_res := checkin_web_rsvp(v_code, H2, true, '[{"first_name":"A","last_name":"A"},{"first_name":"B","last_name":"B"},{"first_name":"C","last_name":"C"}]');
  IF v_res->>'status' <> 'going' OR jsonb_array_length(v_res->'plus_ones') <> 2 THEN RAISE EXCEPTION 'going: %', v_res; END IF;
  -- Changing the answer replaces them; not going removes them.
  v_res := checkin_web_rsvp(v_code, H2, true, '[{"first_name":"Z","last_name":"Z"}]');
  IF (SELECT count(*) FROM leod_checkin_attendees WHERE plus_one_of = v_g) <> 1 THEN RAISE EXCEPTION 'replace'; END IF;
  v_res := checkin_web_rsvp(v_code, H2, false, '[]');
  IF v_res->>'status' <> 'not_going' OR EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE plus_one_of = v_g) THEN RAISE EXCEPTION 'not going'; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE id = v_g) THEN RAISE EXCEPTION 'guest removed on not going'; END IF;

  -- No room: the answer is recorded, the plus-ones are not added.
  UPDATE leod_checkin_entitlements SET registration_capacity = (SELECT count(*) FROM leod_checkin_attendees WHERE event_id = E AND NOT is_test) WHERE event_id = E;
  IF checkin_web_rsvp(v_code, H2, true, '[{"first_name":"Y","last_name":"Y"}]')->>'status' <> 'no_room_for_plus_ones' THEN RAISE EXCEPTION 'capacity'; END IF;
  IF (SELECT rsvp FROM leod_checkin_web_invites WHERE attendee_id = v_g) <> 'going' THEN RAISE EXCEPTION 'rsvp not kept'; END IF;

  -- The organizer sees the answers.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  IF checkin_invite_status(E)->(v_g::text)->>'rsvp' <> 'going' THEN RAISE EXCEPTION 'status'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  IF NOT (SELECT bool_and(ok) FROM checkin_guard_results() WHERE guard IN ('checkin_rpcs_refuse_strangers', 'checkin_web_paths_private')) THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  -- Test mode: held guests count toward the 25 free test registrations.
  UPDATE leod_checkin_entitlements SET status = 'test', registration_mode = 'open', registration_approval = true, registration_capacity = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  DELETE FROM leod_checkin_held WHERE event_id = E;
  FOR i IN 1..8 LOOP
    v_res := checkin_web_request(v_code, 'H', 'H' || i, 'h' || i || '@example.invalid', NULL, '{}', repeat('d', 64), NULL,
               '[{"first_name":"A","last_name":"A"},{"first_name":"B","last_name":"B"}]');
    IF i <= 8 AND v_res->>'status' NOT IN ('awaiting_approval', 'test_cap') THEN RAISE EXCEPTION 'held %: %', i, v_res; END IF;
  END LOOP;
  IF (SELECT sum(1 + jsonb_array_length(plus_ones)) FROM leod_checkin_held WHERE event_id = E AND is_test) > 25 THEN RAISE EXCEPTION 'held test rows over the cap'; END IF;
  RAISE EXCEPTION 'PROBE OK 116';
END;
$probe$;
