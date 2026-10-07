-- tests/sql/121-invitation-address-limits-probe.sql. Ends in 'PROBE OK 121'.
DO $probe$
DECLARE
  E    CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_g  uuid;
  v_g2 uuid;
BEGIN
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Gina', 'Guest', 'gina@example.invalid', 'tok-121a', 'import', false) RETURNING id INTO v_g;
  IF checkin_web_invite_issue(E, v_g, repeat('1', 64))->>'status' <> 'issued' THEN RAISE EXCEPTION 'first'; END IF;
  -- Removed and added again: a new record, the same address, no fresh allowance.
  DELETE FROM leod_checkin_attendees WHERE id = v_g;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Gina', 'Guest', 'GINA@example.invalid', 'tok-121b', 'import', false) RETURNING id INTO v_g2;
  IF checkin_web_invite_issue(E, v_g2, repeat('2', 64))->>'status' <> 'too_soon' THEN RAISE EXCEPTION 're-added guest got a fresh allowance'; END IF;
  -- Five a day per address.
  UPDATE leod_checkin_web_mail SET sent_at = now() - interval '1 hour' WHERE event_id = E;
  INSERT INTO leod_checkin_web_mail (email_key, event_id, kind, sent_at)
  SELECT checkin_web_email_key('gina@example.invalid'), E, 'invite', now() - interval '2 hours' FROM generate_series(1, 4);
  IF checkin_web_invite_issue(E, v_g2, repeat('3', 64))->>'status' <> 'limit' THEN RAISE EXCEPTION 'no daily limit per address'; END IF;
  RAISE EXCEPTION 'PROBE OK 121';
END;
$probe$;
