-- tests/sql/117-plus-one-ticket-type-probe.sql. Ends in 'PROBE OK 117'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_vip  uuid;
  v_res  jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live', registration_mode = 'open', registration_approval = false, registration_waitlist = false,
         registration_plus_ones = 2, registration_capacity = NULL WHERE event_id = E;
  DELETE FROM leod_checkin_ticket_types WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  DELETE FROM leod_checkin_web_mail WHERE event_id = E;
  INSERT INTO leod_checkin_ticket_types (event_id, name, price_cents, currency, quantity) VALUES (E, 'VIP', 0, 'eur', 1) RETURNING id INTO v_vip;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM checkin_web_request(v_code, 'Vera', 'Vip', 'vera@example.invalid', NULL, '{}', repeat('a', 64), v_vip,
    '[{"first_name":"Tag","last_name":"Along"},{"first_name":"Also","last_name":"Here"}]');
  v_res := checkin_web_confirm(v_code, repeat('a', 64));
  IF v_res->>'status' <> 'registered' OR jsonb_array_length(v_res->'plus_ones') <> 2 THEN RAISE EXCEPTION 'confirm: %', v_res; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE event_id = E AND source = 'plus_one' AND (ticket_type <> 'Guest' OR ticket_type_id IS NOT NULL)) THEN
    RAISE EXCEPTION 'a plus-one borrowed the VIP ticket';
  END IF;
  -- The one VIP place went to Vera alone.
  IF (SELECT count(*) FROM leod_checkin_attendees WHERE ticket_type_id = v_vip) <> 1 THEN RAISE EXCEPTION 'VIP quantity overrun'; END IF;
  RAISE EXCEPTION 'PROBE OK 117';
END;
$probe$;
