-- tests/sql/101-registration-probe.sql
-- Probe for migration 101 (double opt-in). Ends in RAISE EXCEPTION
-- 'PROBE OK 101', so nothing it writes survives. Dry-run before applying:
--   cat supabase/migrations/101_*.sql tests/sql/101-*.sql > /tmp/x.sql
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

  -- ── test mode: immediate, no pending row, no mail log ──
  v_res := checkin_web_request(v_code, 'Test', 'Guest', 'test.guest@example.invalid', NULL, '{}', repeat('a', 64));
  IF v_res->>'status' <> 'registered' OR length(v_res->>'qr_token') <> 32 THEN RAISE EXCEPTION 'test register: %', v_res; END IF;
  IF checkin_web_request(v_code, 'Test', 'Guest', 'TEST.guest@example.invalid', NULL, '{}', repeat('b', 64))->>'status' <> 'duplicate' THEN
    RAISE EXCEPTION 'test duplicate';
  END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_web_pending WHERE event_id = E) THEN
    RAISE EXCEPTION 'test mode wrote a pending row';
  END IF;

  -- ── live ──
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E AND is_test;   -- as go-live does

  v_res := checkin_web_request(v_code, ' Maya ', 'Lindqvist', 'Maya.Probe@example.invalid', ' Contoso ', '{"diet":{"label":"Diet","value":"none"}}', repeat('1', 64));
  IF v_res->>'status' <> 'pending' OR (v_res->>'send')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'live request: %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND lower(email) = 'maya.probe@example.invalid') THEN
    RAISE EXCEPTION 'unconfirmed request reached the guest list';
  END IF;
  -- Within 10 minutes: no second email, and the first link still stands.
  v_res := checkin_web_request(v_code, 'Maya', 'Lindqvist', 'maya.probe@example.invalid', NULL, '{}', repeat('2', 64));
  IF v_res->>'send' <> 'false' THEN RAISE EXCEPTION 'resend inside the gap: %', v_res; END IF;
  IF checkin_web_confirm(v_code, repeat('2', 64))->>'status' <> 'invalid' THEN RAISE EXCEPTION 'unsent token accepted'; END IF;
  IF checkin_web_confirm(v_code, repeat('f', 64))->>'status' <> 'invalid' THEN RAISE EXCEPTION 'wrong token accepted'; END IF;
  IF checkin_web_confirm('ZZZZZZZZZZ', repeat('1', 64))->>'status' <> 'not_found' THEN RAISE EXCEPTION 'unknown code'; END IF;

  v_res := checkin_web_confirm(v_code, repeat('1', 64));
  IF v_res->>'status' <> 'registered' OR v_res->>'first_name' <> 'Maya' THEN RAISE EXCEPTION 'confirm: %', v_res; END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_attendees
   WHERE event_id = E AND lower(email) = 'maya.probe@example.invalid' AND source = 'web' AND NOT is_test
     AND consent_at IS NOT NULL AND company = 'Contoso' AND custom_fields #>> '{diet,value}' = 'none';
  IF v_n <> 1 THEN RAISE EXCEPTION 'confirmed row wrong'; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_web_pending WHERE event_id = E) THEN RAISE EXCEPTION 'pending row left behind'; END IF;
  IF checkin_web_confirm(v_code, repeat('1', 64))->>'status' <> 'invalid' THEN RAISE EXCEPTION 'link worked twice'; END IF;

  -- An address already on the list gets the same answer as a new one, and
  -- confirming says "already" (the QR is re-sent to that owner).
  UPDATE leod_checkin_web_mail SET sent_at = now() - interval '1 hour';  -- keep the per-recipient budget out of this step
  v_res := checkin_web_request(v_code, 'Other', 'Name', 'maya.probe@example.invalid', NULL, '{}', repeat('3', 64));
  IF v_res->>'status' <> 'pending' OR v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'listed address answered differently: %', v_res; END IF;
  v_res := checkin_web_confirm(v_code, repeat('3', 64));
  IF v_res->>'status' <> 'already' OR v_res #>> '{attendee,first_name}' <> 'Maya' THEN RAISE EXCEPTION 'already: %', v_res; END IF;

  -- Per-recipient budget: 3 confirmation emails per folded address per 24 h.
  DELETE FROM leod_checkin_web_mail WHERE email_key = checkin_web_email_key('bomb@example.invalid');
  FOR k IN 1..3 LOOP
    UPDATE leod_checkin_web_pending SET last_sent_at = now() - interval '11 minutes' WHERE event_id = E;
    v_res := checkin_web_request(v_code, 'B', 'B', 'bomb+' || k || '@example.invalid', NULL, '{}', repeat(k::text, 63) || 'x');
    IF v_res->>'send' <> 'true' THEN RAISE EXCEPTION 'budget refused early at %: %', k, v_res; END IF;
  END LOOP;
  v_res := checkin_web_request(v_code, 'B', 'B', 'BOMB+zz@example.invalid', NULL, '{}', repeat('9', 64));
  IF v_res->>'status' <> 'pending' OR v_res->>'send' <> 'false' THEN RAISE EXCEPTION 'plus-tag folded budget not enforced: %', v_res; END IF;

  -- Capacity: the same 'full' for a listed and an unlisted address.
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND NOT is_test;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, v_n, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_request(v_code, 'M', 'L', 'maya.probe@example.invalid', NULL, '{}', repeat('4', 64))->>'status' <> 'full'
     OR checkin_web_request(v_code, 'N', 'P', 'nobody.here@example.invalid', NULL, '{}', repeat('5', 64))->>'status' <> 'full' THEN
    RAISE EXCEPTION 'capacity answer differs by address';
  END IF;

  -- Rate limit: 20 per (event, IP) per 10 minutes.
  DELETE FROM leod_checkin_web_attempts WHERE event_id = E;
  FOR k IN 1..20 LOOP
    IF NOT checkin_web_rate_check(E, repeat('c', 64)) THEN RAISE EXCEPTION 'rate refused early at %', k; END IF;
  END LOOP;
  IF checkin_web_rate_check(E, repeat('c', 64)) THEN RAISE EXCEPTION 'rate limit not enforced'; END IF;
  IF NOT checkin_web_rate_check(E, repeat('d', 64)) THEN RAISE EXCEPTION 'other IP blocked'; END IF;

  -- Prune: an unconfirmed request older than 48 h is deleted.
  UPDATE leod_checkin_web_pending SET last_sent_at = now() - interval '49 hours' WHERE event_id = E;
  PERFORM checkin_web_prune();
  IF EXISTS (SELECT 1 FROM leod_checkin_web_pending WHERE event_id = E) THEN RAISE EXCEPTION 'prune left rows'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-web-prune') THEN RAISE EXCEPTION 'prune not scheduled'; END IF;

  -- Guards: G14 and G10 pass.
  SELECT bool_and(ok) INTO v_ok FROM checkin_guard_results() WHERE guard IN ('checkin_web_paths_private', 'checkin_rpcs_refuse_strangers');
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results()
                                   WHERE guard IN ('checkin_web_paths_private', 'checkin_rpcs_refuse_strangers'));
  END IF;
  -- G14 must catch a mistake: grant one function and it fails.
  GRANT EXECUTE ON FUNCTION checkin_web_prune() TO authenticated;
  SELECT ok INTO v_ok FROM checkin_guard_results() WHERE guard = 'checkin_web_paths_private';
  IF v_ok THEN RAISE EXCEPTION 'G14 did not notice a granted web function'; END IF;

  RAISE EXCEPTION 'PROBE OK 101';
END;
$probe$;
