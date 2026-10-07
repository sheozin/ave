-- tests/sql/120-invitation-limits-probe.sql. Ends in 'PROBE OK 120'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_g    uuid;
  i      int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live', registration_mode = 'open', registration_approval = false, registration_closes_at = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Gina', 'Guest', 'gina@example.invalid', 'tok-120', 'import', false) RETURNING id INTO v_g;
  IF checkin_web_invite_issue(E, v_g, repeat('1', 64))->>'status' <> 'issued' THEN RAISE EXCEPTION 'first'; END IF;
  IF checkin_web_invite_issue(E, v_g, repeat('2', 64))->>'status' <> 'too_soon' THEN RAISE EXCEPTION 'no 10 minute gap'; END IF;
  UPDATE leod_checkin_web_invites SET sent_at = now() - interval '11 minutes', sent_count = 5 WHERE attendee_id = v_g;
  IF checkin_web_invite_issue(E, v_g, repeat('3', 64))->>'status' <> 'limit' THEN RAISE EXCEPTION 'no total limit'; END IF;
  -- The event cap.
  UPDATE leod_checkin_web_invites SET sent_count = 1 WHERE attendee_id = v_g;
  INSERT INTO leod_checkin_web_mail (email_key, event_id, kind) SELECT 'k' || g, E, 'invite' FROM generate_series(1, 1000) g;
  IF checkin_web_invite_issue(E, v_g, repeat('4', 64))->>'status' <> 'daily_cap' THEN RAISE EXCEPTION 'no event cap'; END IF;
  -- 1,000 invitations do not use the registration page's hourly cap.
  IF checkin_web_request(v_code, 'Reg', 'Ular', 'regular@example.invalid', NULL, '{}', repeat('5', 64))->>'send' <> 'true' THEN RAISE EXCEPTION 'invitations blocked a registration'; END IF;
  RAISE EXCEPTION 'PROBE OK 120';
END;
$probe$;
