-- tests/sql/119-invitation-revoke-probe.sql. Ends in 'PROBE OK 119'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_g    uuid;
  H1 CONSTANT text := repeat('1', 64);
  H2 CONSTANT text := repeat('2', 64);
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live', registration_closes_at = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Gina', 'Guest', 'gina@example.invalid', 'tok-119', 'import', false) RETURNING id INTO v_g;
  PERFORM checkin_web_invite_issue(E, v_g, H1);
  PERFORM checkin_web_rsvp(v_code, H1, true, '[]');
  UPDATE leod_checkin_web_invites SET sent_at = now() - interval '11 minutes' WHERE attendee_id = v_g;  -- (120) past the 10 minute gap
  PERFORM checkin_web_invite_issue(E, v_g, H2);
  IF checkin_web_invite_view(v_code, H1)->>'status' <> 'ok' THEN RAISE EXCEPTION 'previous link within 48 h'; END IF;
  -- After 48 hours only the latest link works.
  UPDATE leod_checkin_web_invites SET sent_at = now() - interval '49 hours' WHERE attendee_id = v_g;
  IF checkin_web_invite_view(v_code, H1)->>'status' <> 'invalid' THEN RAISE EXCEPTION 'previous link outlived 48 h'; END IF;
  IF checkin_web_rsvp(v_code, H1, false, '[]')->>'status' <> 'invalid' THEN RAISE EXCEPTION 'rsvp on an expired link'; END IF;
  -- Strangers cannot cancel; the organizer can, and every link dies.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_invite_revoke(E, v_g); RAISE EXCEPTION 'stranger revoked'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  IF NOT checkin_invite_revoke(E, v_g) THEN RAISE EXCEPTION 'revoke'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_invite_view(v_code, H2)->>'status' <> 'invalid' THEN RAISE EXCEPTION 'latest link survived revoke'; END IF;
  IF (SELECT rsvp FROM leod_checkin_web_invites WHERE attendee_id = v_g) <> 'going' THEN RAISE EXCEPTION 'answer lost on revoke'; END IF;
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers') THEN RAISE EXCEPTION 'G10'; END IF;
  RAISE EXCEPTION 'PROBE OK 119';
END;
$probe$;
