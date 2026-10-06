-- tests/sql/102-registration-probe.sql
-- Probe for migration 102. Ends in RAISE EXCEPTION 'PROBE OK 102'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
  v_ok   boolean;
  k      int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);

  -- Test mode returns no token or code, and the same status shape for a duplicate.
  v_res := checkin_web_request(v_code, 'T', 'G', 'tm.probe@example.invalid', NULL, '{}', repeat('a', 64));
  IF v_res ? 'qr_token' OR v_res->>'status' <> 'registered' THEN RAISE EXCEPTION 'test answer: %', v_res; END IF;

  -- Gmail folding: dots, +tags, case and googlemail.com are one address.
  IF checkin_web_email_key('V.I.C.Tim+x@GoogleMail.com') <> checkin_web_email_key('victim@gmail.com') THEN
    RAISE EXCEPTION 'gmail not folded';
  END IF;
  IF checkin_web_email_key('v.ictim@example.com') = checkin_web_email_key('victim@example.com') THEN
    RAISE EXCEPTION 'dots folded outside gmail';
  END IF;

  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  DELETE FROM leod_checkin_web_mail WHERE email_key = checkin_web_email_key('victim@gmail.com');

  -- Per-event budget: 3 for this event, across dot variants.
  FOR k IN 1..3 LOOP
    UPDATE leod_checkin_web_pending SET last_sent_at = now() - interval '11 minutes' WHERE event_id = E;
    v_res := checkin_web_request(v_code, 'V', 'T', (ARRAY['v.ictim', 'vi.ctim', 'vic.tim'])[k] || '@gmail.com', NULL, '{}', repeat(k::text, 64));
    IF v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'event budget refused early at %: %', k, v_res; END IF;
  END LOOP;
  v_res := checkin_web_request(v_code, 'V', 'T', 'Vict.Im@googlemail.com', NULL, '{}', repeat('9', 64));
  IF v_res->>'send' <> 'false' THEN RAISE EXCEPTION 'dot variant escaped the budget: %', v_res; END IF;

  -- Global budget: 10 across events. Simulate 7 sends recorded for other events.
  INSERT INTO leod_checkin_web_mail (email_key, event_id)
  SELECT checkin_web_email_key('victim@gmail.com'), gen_random_uuid() FROM generate_series(1, 7);
  DELETE FROM leod_checkin_web_mail WHERE email_key = checkin_web_email_key('victim@gmail.com') AND event_id = E;
  UPDATE leod_checkin_web_pending SET last_sent_at = now() - interval '11 minutes' WHERE event_id = E;
  INSERT INTO leod_checkin_web_mail (email_key, event_id)
  SELECT checkin_web_email_key('victim@gmail.com'), gen_random_uuid() FROM generate_series(1, 3);
  v_res := checkin_web_request(v_code, 'V', 'T', 'victim@gmail.com', NULL, '{}', repeat('8', 64));
  IF v_res->>'send' <> 'false' THEN RAISE EXCEPTION 'global budget not enforced: %', v_res; END IF;

  -- Preview: the token holder sees the pending details; anyone else sees invalid.
  DELETE FROM leod_checkin_web_mail WHERE email_key = checkin_web_email_key('preview@example.invalid');
  v_res := checkin_web_request(v_code, 'Maya', 'Lindqvist', 'preview@example.invalid', 'Contoso', '{}', repeat('7', 64));
  IF v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'preview setup: %', v_res; END IF;
  v_res := checkin_web_pending_preview(v_code, repeat('7', 64));
  IF v_res->>'first_name' <> 'Maya' OR v_res->>'company' <> 'Contoso' THEN RAISE EXCEPTION 'preview: %', v_res; END IF;
  IF checkin_web_pending_preview(v_code, repeat('6', 64))->>'status' <> 'invalid' THEN RAISE EXCEPTION 'preview without token'; END IF;
  IF checkin_web_pending_preview('ZZZZZZZZZZ', repeat('7', 64))->>'status' <> 'invalid' THEN RAISE EXCEPTION 'preview other code'; END IF;

  -- G14 passes, and catches a granted sequence.
  SELECT ok INTO v_ok FROM checkin_guard_results() WHERE guard = 'checkin_web_paths_private';
  IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'G14: %', (SELECT detail FROM checkin_guard_results() WHERE guard = 'checkin_web_paths_private'); END IF;
  GRANT USAGE ON SEQUENCE leod_checkin_web_mail_id_seq TO authenticated;
  SELECT ok INTO v_ok FROM checkin_guard_results() WHERE guard = 'checkin_web_paths_private';
  IF v_ok THEN RAISE EXCEPTION 'G14 missed a granted sequence'; END IF;

  RAISE EXCEPTION 'PROBE OK 102';
END;
$probe$;
