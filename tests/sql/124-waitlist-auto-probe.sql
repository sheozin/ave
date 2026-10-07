-- tests/sql/124-waitlist-auto-probe.sql. Ends in 'PROBE OK 124'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
  v_res jsonb;
  v_n   int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_waitlist_auto(E, true); RAISE EXCEPTION 'stranger'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', '', true);

  UPDATE leod_checkin_entitlements SET status = 'live', registration_plus_ones = 2, waitlist_auto = false, waitlist_checked_at = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  DELETE FROM leod_checkin_held WHERE event_id = E;
  DELETE FROM leod_checkin_web_orders WHERE event_id = E;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  SELECT E, 'G', 'G' || g, 'g' || g || '@example.invalid', 'tok-124-' || g, 'import', false FROM generate_series(1, 5) g;
  UPDATE leod_checkin_entitlements SET registration_capacity = 6 WHERE event_id = E;   -- one place free
  -- Waiting: a party of three first, then a solo guest.
  INSERT INTO leod_checkin_held (event_id, kind, first_name, last_name, email, is_test, consent_at, plus_ones, created_at)
  VALUES (E, 'waitlist', 'Party', 'Three', 'party@example.invalid', false, now(), '[{"first_name":"A","last_name":"A"},{"first_name":"B","last_name":"B"}]', now() - interval '2 hours'),
         (E, 'waitlist', 'Solo', 'One', 'solo@example.invalid', false, now(), '[]', now() - interval '1 hour');

  -- One place: the party of three does not fit, and the solo guest does not jump them.
  v_res := checkin_web_waitlist_fill(E);
  IF jsonb_array_length(v_res) <> 0 THEN RAISE EXCEPTION 'queue jumped: %', v_res; END IF;
  -- Not due while the first party does not fit (and not due while auto is off).
  IF EXISTS (SELECT 1 FROM checkin_web_waitlist_due() d WHERE d.event_id = E) THEN RAISE EXCEPTION 'due while off'; END IF;

  -- Three places: the party moves up, with their plus-ones; the solo guest still waits (no room left).
  UPDATE leod_checkin_entitlements SET registration_capacity = 8, waitlist_auto = true, waitlist_checked_at = NULL WHERE event_id = E;
  IF NOT EXISTS (SELECT 1 FROM checkin_web_waitlist_due() d WHERE d.event_id = E) THEN RAISE EXCEPTION 'not due'; END IF;
  -- G19 sees free places nobody has looked at.
  IF (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_waitlist_moving') THEN RAISE EXCEPTION 'G19 missed it'; END IF;
  v_res := checkin_web_waitlist_fill(E);
  IF jsonb_array_length(v_res) <> 1 OR jsonb_array_length(v_res->0->'plus_ones') <> 2 THEN RAISE EXCEPTION 'party: %', v_res; END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND NOT is_test;
  IF v_n <> 8 THEN RAISE EXCEPTION 'over or under capacity: %', v_n; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_held WHERE event_id = E AND email = 'solo@example.invalid') THEN RAISE EXCEPTION 'solo released past capacity'; END IF;
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_waitlist_moving') THEN RAISE EXCEPTION 'G19 after fill'; END IF;

  -- An open order holds its place: the waitlist does not take it.
  UPDATE leod_checkin_entitlements SET registration_capacity = 9 WHERE event_id = E;
  INSERT INTO leod_checkin_payout_accounts (user_id, stripe_account_id, charges_enabled) VALUES (v_own, 'acct_PROBE124test', true) ON CONFLICT (user_id) DO NOTHING;
  INSERT INTO leod_checkin_web_orders (event_id, ticket_name, token_hashes, first_name, last_name, email, amount_cents, currency, stripe_account_id, expires_at)
  VALUES (E, 'Paid', ARRAY[repeat('9', 64)], 'Pay', 'Ing', 'paying@example.invalid', 2000, 'eur', 'acct_PROBE124test', now() + interval '30 minutes');
  IF jsonb_array_length(checkin_web_waitlist_fill(E)) <> 0 THEN RAISE EXCEPTION 'took a place held by an order'; END IF;
  RAISE EXCEPTION 'PROBE OK 124';
END;
$probe$;
