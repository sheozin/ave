-- tests/sql/127-webhook-hardening-probe.sql. Ends in 'PROBE OK 127'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_org  uuid;
  v_hook uuid;
  v_n    int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_webhooks WHERE event_id = E;
  -- Any other existing account plays the organizer (the probe is rolled back).
  SELECT id INTO v_org FROM leod_users WHERE id <> v_own LIMIT 1;
  DELETE FROM leod_checkin_operators WHERE event_id = E AND user_id = v_org;
  INSERT INTO leod_checkin_operators (event_id, user_id, role) VALUES (E, v_org, 'organizer');
  -- An organizer adds a webhook.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_webhook_add(E, 'https://hooks.example.com:8080/x', ARRAY['guest.created']); RAISE EXCEPTION 'port accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_webhook_add(E, 'https://user:pw@hooks.example.com/x', ARRAY['guest.created']); RAISE EXCEPTION 'credentials accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  v_hook := (checkin_webhook_add(E, 'https://hooks.example.com:443/x', ARRAY['guest.created']))->>'id';
  PERFORM set_config('request.jwt.claims', '', true);
  IF (SELECT created_by FROM leod_checkin_webhooks WHERE id = v_hook) <> v_org THEN RAISE EXCEPTION 'author not recorded'; END IF;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source, is_test) VALUES (E, 'One', 'G', 'tok-127a', 'import', false);
  IF NOT EXISTS (SELECT 1 FROM checkin_webhooks_due(100) d WHERE d.webhook_id = v_hook) THEN RAISE EXCEPTION 'not due while organizer'; END IF;
  -- The organizer is removed: queued deliveries are held back and new ones not queued.
  DELETE FROM leod_checkin_operators WHERE event_id = E AND user_id = v_org;
  IF EXISTS (SELECT 1 FROM checkin_webhooks_due(100) d WHERE d.webhook_id = v_hook) THEN RAISE EXCEPTION 'still sending to a removed organizer'; END IF;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source, is_test) VALUES (E, 'Two', 'G', 'tok-127b', 'import', false);
  SELECT count(*) INTO v_n FROM leod_checkin_webhook_deliveries WHERE webhook_id = v_hook;
  IF v_n <> 1 THEN RAISE EXCEPTION 'queued after removal: %', v_n; END IF;
  RAISE EXCEPTION 'PROBE OK 127';
END;
$probe$;
