-- tests/sql/149-guest-invite-status-probe.sql. Ends in 'PROBE OK 149'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid; v_att uuid; v_st jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, source, is_test, qr_token)
  VALUES (E, 'Probe', 'Guest', 'probe149@cuedeck-test.io', 'import', false, md5(random()::text) || md5(random()::text)) RETURNING id INTO v_att;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  IF (checkin_web_invite_issue(E, v_att, md5('a') || md5('b')))->>'status' <> 'issued' THEN RAISE EXCEPTION 'issue'; END IF;
  v_st := checkin_invite_status(E)->(v_att::text);
  IF (v_st->>'sent_count')::int <> 1 OR v_st->>'sent_at' IS NULL OR v_st->'revoked_at' <> 'null'::jsonb THEN RAISE EXCEPTION 'status after issue: %', v_st; END IF;
  IF NOT checkin_invite_revoke(E, v_att) THEN RAISE EXCEPTION 'revoke'; END IF;
  v_st := checkin_invite_status(E)->(v_att::text);
  IF v_st->>'revoked_at' IS NULL THEN RAISE EXCEPTION 'revoked not recorded: %', v_st; END IF;
  -- A new invitation (past the 10-minute gap) makes the link work again.
  UPDATE leod_checkin_web_invites SET sent_at = now() - interval '11 minutes' WHERE attendee_id = v_att;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E AND kind = 'invite' AND email_key = checkin_web_email_key('probe149@cuedeck-test.io');
  IF (checkin_web_invite_issue(E, v_att, md5('c') || md5('d')))->>'status' <> 'issued' THEN RAISE EXCEPTION 'reissue'; END IF;
  v_st := checkin_invite_status(E)->(v_att::text);
  IF v_st->'revoked_at' <> 'null'::jsonb OR (v_st->>'sent_count')::int <> 2 THEN RAISE EXCEPTION 'after reissue: %', v_st; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE EXCEPTION 'PROBE OK 149';
END;
$probe$;
