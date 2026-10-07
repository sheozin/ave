-- tests/sql/126-webhooks-probe.sql. Ends in 'PROBE OK 126'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
  v_res jsonb;
  v_hook uuid;
  v_a   uuid;
  v_d   bigint;
  v_n   int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_webhook_add(E, 'https://hooks.example.com/x', ARRAY['guest.created']); RAISE EXCEPTION 'stranger add'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_webhooks_list(E); RAISE EXCEPTION 'stranger list'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  DELETE FROM leod_checkin_webhooks WHERE event_id = E;
  -- Only public https addresses.
  BEGIN PERFORM checkin_webhook_add(E, 'http://hooks.example.com/x', ARRAY['guest.created']); RAISE EXCEPTION 'http accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_webhook_add(E, 'https://169.254.169.254/latest', ARRAY['guest.created']); RAISE EXCEPTION 'ip accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_webhook_add(E, 'https://localhost:8080/x', ARRAY['guest.created']); RAISE EXCEPTION 'localhost accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_webhook_add(E, 'https://hooks.example.com/x', ARRAY['guest.deleted']); RAISE EXCEPTION 'unknown topic accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  v_res := checkin_webhook_add(E, 'https://hooks.example.com/cuedeck', ARRAY['guest.created', 'guest.checked_in']);
  v_hook := v_res->>'id';
  IF v_res->>'secret' !~ '^whsec_[0-9a-f]{48}$' THEN RAISE EXCEPTION 'secret: %', v_res; END IF;
  IF (checkin_webhooks_list(E)->0) ? 'secret' THEN RAISE EXCEPTION 'list shows the secret'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- Live: a new guest and their check-in are queued; test guests are not.
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Hook', 'Guest', 'hook@example.invalid', 'tok-126', 'import', false) RETURNING id INTO v_a;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source, is_test) VALUES (E, 'Test', 'Only', 'tok-126t', 'web', true);
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = v_a;
  SELECT count(*) INTO v_n FROM leod_checkin_webhook_deliveries WHERE webhook_id = v_hook;
  IF v_n <> 2 THEN RAISE EXCEPTION 'queued: %', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_webhook_deliveries WHERE webhook_id = v_hook AND topic = 'guest.checked_in'
                  AND payload->'data'->>'email' = 'hook@example.invalid' AND payload->>'event_id' = E::text) THEN RAISE EXCEPTION 'payload'; END IF;

  -- Retries back off, then fail after six attempts.
  SELECT id INTO v_d FROM leod_checkin_webhook_deliveries WHERE webhook_id = v_hook AND topic = 'guest.created';
  IF checkin_webhook_result(v_d, false, 'HTTP 500') <> 'retry' THEN RAISE EXCEPTION 'retry'; END IF;
  IF (SELECT next_at FROM leod_checkin_webhook_deliveries WHERE id = v_d) < now() + interval '50 seconds' THEN RAISE EXCEPTION 'no backoff'; END IF;
  UPDATE leod_checkin_webhook_deliveries SET attempts = 5 WHERE id = v_d;
  IF checkin_webhook_result(v_d, false, 'HTTP 500') <> 'failed' THEN RAISE EXCEPTION 'not failed after six'; END IF;
  SELECT id INTO v_d FROM leod_checkin_webhook_deliveries WHERE webhook_id = v_hook AND topic = 'guest.checked_in';
  IF checkin_webhook_result(v_d, true, 'HTTP 200') <> 'sent' THEN RAISE EXCEPTION 'sent'; END IF;

  -- G20: an overdue delivery is reported.
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_webhooks_flowing') THEN RAISE EXCEPTION 'G20 before'; END IF;
  INSERT INTO leod_checkin_webhook_deliveries (webhook_id, topic, payload, next_at) VALUES (v_hook, 'guest.created', '{}', now() - interval '1 hour');
  IF (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_webhooks_flowing') THEN RAISE EXCEPTION 'G20 missed it'; END IF;

  IF NOT (SELECT bool_and(ok) FROM checkin_guard_results() WHERE guard IN ('checkin_rpcs_refuse_strangers', 'public_tables_rls_on', 'checkin_tables_not_anon_writable', 'security_definer_search_path')) THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  RAISE EXCEPTION 'PROBE OK 126';
END;
$probe$;
