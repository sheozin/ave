-- tests/sql/113-speaker-trusted-probe.sql. Ends in 'PROBE OK 113'.
DO $probe$
DECLARE
  E    CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
  s1 uuid; fake uuid; real uuid;
  v_res jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live', speaker_link = true WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end, status, people, speaker)
  VALUES (E, 911, 'Keynote', '09:00', '09:30', '09:00', '09:30', 'PLANNED', '[{"name":"Ana Kowalska","role":"speaker"}]', 'Ana Kowalska') RETURNING id INTO s1;
  -- Someone registers on the public page under the speaker's name.
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Ana', 'Kowalska', 'impostor@example.invalid', 'tok-fake', 'web', false) RETURNING id INTO fake;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_res := checkin_speaker_links(E);
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'people') x WHERE x->>'name' = 'Ana Kowalska' AND NOT (x->>'on_list')::boolean AND (x->>'self_only')::boolean) THEN RAISE EXCEPTION 'links: %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = fake;
  IF (SELECT speaker_arrived FROM leod_sessions WHERE id = s1) THEN RAISE EXCEPTION 'a self-registered name marked the speaker arrived'; END IF;
  -- A kiosk walk-up is the same.
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source, is_test, checked_in_at)
  VALUES (E, 'Ana', 'Kowalska', 'tok-kiosk', 'kiosk', false, now());
  IF (SELECT speaker_arrived FROM leod_sessions WHERE id = s1) THEN RAISE EXCEPTION 'a kiosk name marked the speaker arrived'; END IF;
  -- The organizer's own guest does.
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Ana', 'Kowalska', 'ana@example.invalid', 'tok-real', 'import', false) RETURNING id INTO real;
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = real;
  IF NOT (SELECT speaker_arrived FROM leod_sessions WHERE id = s1) THEN RAISE EXCEPTION 'listed speaker not arrived'; END IF;
  RAISE EXCEPTION 'PROBE OK 113';
END;
$probe$;
