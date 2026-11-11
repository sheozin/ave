-- Probe for 168: a new guest takes the spelling the event already uses, and
-- G23 catches a split made by an update. Ends in an exception so nothing stays.
DO $$
DECLARE
  v_ev uuid;
  v_a  uuid;
  v_t  text;
  r    record;
BEGIN
  -- A finished event refuses new guests, so probe one that is still open.
  SELECT a.event_id INTO v_ev
    FROM leod_checkin_attendees a JOIN leod_events e ON e.id = a.event_id
   WHERE COALESCE(checkin_finishes_at(e.date, e.timezone) > now(), true)
   LIMIT 1;
  IF v_ev IS NULL THEN RAISE EXCEPTION 'PROBE FAIL 0: no open event with guests to probe'; END IF;

  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source, ticket_type)
  VALUES (v_ev, 'Probe', 'One', 'p168a' || replace(gen_random_uuid()::text, '-', ''), 'import', 'ProbeType168');
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source, ticket_type)
  VALUES (v_ev, 'Probe', 'Two', 'p168b' || replace(gen_random_uuid()::text, '-', ''), 'kiosk', 'probetype168')
  RETURNING id, ticket_type INTO v_a, v_t;
  IF v_t <> 'ProbeType168' THEN RAISE EXCEPTION 'PROBE FAIL 1: second spelling kept as %', v_t; END IF;

  UPDATE leod_checkin_attendees SET ticket_type = 'PROBETYPE168' WHERE id = v_a;
  SELECT * INTO r FROM checkin_guard_results() WHERE guard = 'ticket_types_one_spelling';
  IF r IS NULL OR r.ok OR position(v_ev::text IN r.detail) = 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 2: split not caught (%)', coalesce(r.detail, 'guard missing');
  END IF;

  IF has_function_privilege('anon', 'public.checkin_ticket_type_spelling()', 'execute')
     OR has_function_privilege('authenticated', 'public.checkin_ticket_type_spelling()', 'execute') THEN
    RAISE EXCEPTION 'PROBE FAIL 3: trigger function callable by clients';
  END IF;
  RAISE EXCEPTION 'PROBE OK 168 (%)', r.detail;
END $$;
