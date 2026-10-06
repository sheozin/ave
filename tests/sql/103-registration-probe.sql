-- tests/sql/103-registration-probe.sql
-- Probe for migration 103 (third security review). Ends in 'PROBE OK 103'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
  v_n    int;
  v_ok   boolean;
  k      int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);

  -- F4: a full test event answers 'full' for a listed and an unlisted address alike.
  PERFORM checkin_web_request(v_code, 'L', 'Isted', 'listed.f4@example.invalid', NULL, '{}', repeat('a', 64));
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, v_n, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_request(v_code, 'L', 'Isted', 'listed.f4@example.invalid', NULL, '{}', repeat('b', 64))->>'status' <> 'full'
     OR checkin_web_request(v_code, 'N', 'Ew', 'new.f4@example.invalid', NULL, '{}', repeat('c', 64))->>'status' <> 'full' THEN
    RAISE EXCEPTION 'F4: full answer depends on the address';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, NULL, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);

  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;

  -- F3: a resend keeps the first details, and both links work.
  v_res := checkin_web_request(v_code, 'Maya', 'Real', 'f3@example.invalid', 'Contoso', '{}', repeat('1', 64));
  IF v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'F3 setup: %', v_res; END IF;
  UPDATE leod_checkin_web_pending SET last_sent_at = now() - interval '11 minutes' WHERE event_id = E;
  v_res := checkin_web_request(v_code, 'Evil', 'Name', 'f3@example.invalid', 'Attacker', '{}', repeat('2', 64));
  IF v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'F3 resend: %', v_res; END IF;
  IF checkin_web_pending_preview(v_code, repeat('2', 64))->>'first_name' <> 'Maya'
     OR checkin_web_pending_preview(v_code, repeat('1', 64))->>'company' <> 'Contoso' THEN
    RAISE EXCEPTION 'F3: details overwritten or old link dead';
  END IF;
  -- Decline with the old link deletes the request; both links then fail.
  IF checkin_web_decline(v_code, repeat('1', 64))->>'status' <> 'declined' THEN RAISE EXCEPTION 'decline'; END IF;
  IF checkin_web_pending_preview(v_code, repeat('2', 64))->>'status' <> 'invalid' THEN RAISE EXCEPTION 'declined request still live'; END IF;
  IF checkin_web_decline(v_code, repeat('9', 64))->>'status' <> 'invalid' THEN RAISE EXCEPTION 'decline without token'; END IF;

  -- Confirm still works with the current token.
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  v_res := checkin_web_request(v_code, 'Ok', 'Guest', 'f3ok@example.invalid', NULL, '{}', repeat('3', 64));
  IF checkin_web_confirm(v_code, repeat('3', 64))->>'status' <> 'registered' THEN RAISE EXCEPTION 'confirm broke'; END IF;

  -- F7: a failed send refunds the budget and reopens the gap.
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_request(v_code, 'F', 'Seven', 'f7@example.invalid', NULL, '{}', repeat('4', 64));
  SELECT count(*) INTO v_n FROM leod_checkin_web_mail WHERE event_id = E;
  PERFORM checkin_web_send_failed(v_code, repeat('4', 64));
  IF (SELECT count(*) FROM leod_checkin_web_mail WHERE event_id = E) <> v_n - 1 THEN RAISE EXCEPTION 'F7: budget not refunded'; END IF;
  IF checkin_web_request(v_code, 'F', 'Seven', 'f7@example.invalid', NULL, '{}', repeat('5', 64))->>'send' <> 'true' THEN
    RAISE EXCEPTION 'F7: gap not reopened';
  END IF;

  -- F1: per-event hourly cap of 150, recorded, and G15 notices.
  DELETE FROM leod_checkin_web_trips;
  INSERT INTO leod_checkin_web_mail (email_key, event_id) SELECT md5(g::text), E FROM generate_series(1, 150) g;
  v_res := checkin_web_request(v_code, 'Cap', 'Hit', 'cap.hit@example.invalid', NULL, '{}', repeat('6', 64));
  IF v_res->>'status' <> 'pending' OR v_res->>'send' <> 'false' THEN RAISE EXCEPTION 'F1 cap: %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_web_trips WHERE event_id = E) THEN RAISE EXCEPTION 'F1 trip not recorded'; END IF;
  SELECT ok INTO v_ok FROM checkin_guard_results() WHERE guard = 'checkin_web_mail_cap_not_hit';
  IF v_ok THEN RAISE EXCEPTION 'G15 did not notice'; END IF;

  -- F2: token limiter is per IP, 60 per 10 minutes, and spends nothing from the event budget.
  DELETE FROM leod_checkin_web_attempts WHERE event_id = E;
  FOR k IN 1..60 LOOP
    IF NOT checkin_web_token_rate_check(repeat('e', 64)) THEN RAISE EXCEPTION 'token limit early at %', k; END IF;
  END LOOP;
  IF checkin_web_token_rate_check(repeat('e', 64)) THEN RAISE EXCEPTION 'token limit not enforced'; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_web_attempts WHERE event_id = E) THEN RAISE EXCEPTION 'token checks spent the event budget'; END IF;
  -- Register limit per (event, IP) is now 30.
  FOR k IN 1..30 LOOP
    IF NOT checkin_web_rate_check(E, repeat('f', 64)) THEN RAISE EXCEPTION 'register limit early at %', k; END IF;
  END LOOP;
  IF checkin_web_rate_check(E, repeat('f', 64)) THEN RAISE EXCEPTION 'register limit not enforced'; END IF;

  -- G14 still passes with the new tables, sequences and functions; G15 passes with no trips.
  DELETE FROM leod_checkin_web_trips;
  SELECT bool_and(ok) INTO v_ok FROM checkin_guard_results() WHERE guard IN ('checkin_web_paths_private', 'checkin_web_mail_cap_not_hit', 'checkin_rpcs_refuse_strangers');
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;

  RAISE EXCEPTION 'PROBE OK 103';
END;
$probe$;
