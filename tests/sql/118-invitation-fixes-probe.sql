-- tests/sql/118-invitation-fixes-probe.sql. Ends in 'PROBE OK 118'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_g    uuid;
  v_res  jsonb;
  H1 CONSTANT text := repeat('1', 64);
  H2 CONSTANT text := repeat('2', 64);
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live', registration_mode = 'invite', registration_approval = false,
         registration_plus_ones = 2, registration_capacity = NULL, registration_closes_at = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Gina', 'Guest', 'gina@example.invalid', 'tok-118', 'import', false) RETURNING id INTO v_g;
  PERFORM checkin_web_invite_issue(E, v_g, H1);
  v_res := checkin_web_rsvp(v_code, H1, true, '[{"first_name":"A","last_name":"A"},{"first_name":"B","last_name":"B"}]');
  IF jsonb_array_length(v_res->'plus_ones') <> 2 THEN RAISE EXCEPTION 'setup: %', v_res; END IF;
  -- 1. Full event: answering again with the same two keeps them; three would not fit but the two stay.
  UPDATE leod_checkin_entitlements SET registration_capacity = 3 WHERE event_id = E;
  v_res := checkin_web_rsvp(v_code, H1, true, '[{"first_name":"A","last_name":"A"},{"first_name":"B","last_name":"B"}]');
  IF v_res->>'status' <> 'going' THEN RAISE EXCEPTION 'same party refused on a full event: %', v_res; END IF;
  UPDATE leod_checkin_entitlements SET registration_capacity = 2 WHERE event_id = E;
  v_res := checkin_web_rsvp(v_code, H1, true, '[{"first_name":"C","last_name":"C"},{"first_name":"D","last_name":"D"}]');
  IF v_res->>'status' <> 'no_room_for_plus_ones' THEN RAISE EXCEPTION 'over capacity: %', v_res; END IF;
  IF (SELECT count(*) FROM leod_checkin_attendees WHERE plus_one_of = v_g) <> 2 THEN RAISE EXCEPTION 'a refused answer deleted plus-ones'; END IF;
  -- 2. The deadline holds for going, not for not going.
  UPDATE leod_checkin_entitlements SET registration_capacity = NULL, registration_closes_at = now() - interval '1 minute' WHERE event_id = E;
  IF checkin_web_rsvp(v_code, H1, true, '[]')->>'status' <> 'closed' THEN RAISE EXCEPTION 'deadline ignored'; END IF;
  IF checkin_web_rsvp(v_code, H1, false, '[]')->>'status' <> 'not_going' THEN RAISE EXCEPTION 'not going after deadline'; END IF;
  -- 3. A resend keeps the old link; a failed resend restores it alone.
  PERFORM checkin_web_invite_issue(E, v_g, H2);
  IF checkin_web_invite_view(v_code, H1)->>'status' <> 'ok' OR checkin_web_invite_view(v_code, H2)->>'status' <> 'ok' THEN RAISE EXCEPTION 'both links should work'; END IF;
  PERFORM checkin_web_invite_unissue(v_g, H2);
  IF checkin_web_invite_view(v_code, H1)->>'status' <> 'ok' OR checkin_web_invite_view(v_code, H2)->>'status' <> 'invalid' THEN RAISE EXCEPTION 'failed resend not restored'; END IF;
  RAISE EXCEPTION 'PROBE OK 118';
END;
$probe$;
