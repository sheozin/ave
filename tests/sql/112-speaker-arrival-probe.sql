-- tests/sql/112-speaker-arrival-probe.sql. Ends in 'PROBE OK 112'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid;
  ana uuid; ben uuid; tess uuid; wis uuid;
  v_res jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  IF checkin_norm_name('  Dr. Anna  Wiśniewska ') <> 'anna wisniewska' THEN RAISE EXCEPTION 'norm: %', checkin_norm_name('  Dr. Anna  Wiśniewska '); END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_speaker_links(E); RAISE EXCEPTION 'stranger links'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_set_speaker_link(E, false); RAISE EXCEPTION 'stranger set'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', '', true);

  UPDATE leod_checkin_entitlements SET status = 'live', speaker_link = true WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end, status, people, speaker)
  VALUES (E, 901, 'Keynote', '09:00', '09:30', '09:00', '09:30', 'PLANNED', '[{"name":"Dr. Ana Kowalska","company":"X","role":"speaker"}]', 'Dr. Ana Kowalska') RETURNING id INTO s1;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end, status, people, speaker)
  VALUES (E, 902, 'Panel', '10:00', '11:00', '10:00', '11:00', 'PLANNED', '[{"name":"Ana Kowalska","role":"panelist"},{"name":"Ben Lee","role":"moderator"}]', 'Ben Lee (moderator), Ana Kowalska') RETURNING id INTO s2;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end, status, people, speaker)
  VALUES (E, 903, 'Fireside', '12:00', '12:30', '12:00', '12:30', 'PLANNED', '[]', 'Anna Wiśniewska') RETURNING id INTO s3;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end, status, people, speaker)
  VALUES (E, 904, 'Done', '08:00', '08:30', '08:00', '08:30', 'ENDED', '[{"name":"Ana Kowalska","role":"speaker"}]', 'Ana Kowalska') RETURNING id INTO s4;

  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Ana', 'Kowalska', 'ana@example.invalid', 'tok-sp-1', 'import', false) RETURNING id INTO ana;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Ben', 'Lee', 'ben@example.invalid', 'tok-sp-2', 'import', false) RETURNING id INTO ben;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Anna', 'Wisniewska', NULL, 'tok-sp-3', 'import', false) RETURNING id INTO wis;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Ben', 'Lee', 'ben.test@example.invalid', 'tok-sp-4', 'web', true) RETURNING id INTO tess;

  -- The organizer sees who is linked before the day.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_res := checkin_speaker_links(E);
  IF NOT (v_res->>'enabled')::boolean OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_res->'people') x WHERE x->>'name' = 'Ben Lee' AND (x->>'on_list')::boolean AND NOT (x->>'arrived')::boolean) THEN
    RAISE EXCEPTION 'links: %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- A test guest with a speaker's name changes nothing.
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = tess;
  IF (SELECT speaker_arrived FROM leod_sessions WHERE id = s2) THEN RAISE EXCEPTION 'test guest marked a session'; END IF;

  -- Ana arrives: her keynote is arrived; the panel waits for Ben; the ended session is left alone.
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = ana;
  IF NOT (SELECT speaker_arrived FROM leod_sessions WHERE id = s1) THEN RAISE EXCEPTION 'keynote not arrived'; END IF;
  IF (SELECT speaker_arrived FROM leod_sessions WHERE id = s2) THEN RAISE EXCEPTION 'panel arrived with Ben missing'; END IF;
  IF COALESCE((SELECT speaker_arrived FROM leod_sessions WHERE id = s4), false) THEN RAISE EXCEPTION 'ended session touched'; END IF;
  IF (SELECT count(*) FROM leod_event_log WHERE session_id IN (s1, s2) AND action = 'SPEAKER_CHECKED_IN') <> 2 THEN RAISE EXCEPTION 'log rows'; END IF;
  -- Ben arrives: the panel is complete.
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = ben;
  IF NOT (SELECT speaker_arrived FROM leod_sessions WHERE id = s2) THEN RAISE EXCEPTION 'panel not arrived'; END IF;

  -- Accents do not matter; and with the setting off nothing happens.
  UPDATE leod_checkin_entitlements SET speaker_link = false WHERE event_id = E;
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = wis;
  IF (SELECT speaker_arrived FROM leod_sessions WHERE id = s3) THEN RAISE EXCEPTION 'linked while off'; END IF;
  UPDATE leod_checkin_attendees SET checked_in_at = NULL WHERE id = wis;
  UPDATE leod_checkin_entitlements SET speaker_link = true WHERE event_id = E;
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = wis;
  IF NOT (SELECT speaker_arrived FROM leod_sessions WHERE id = s3) THEN RAISE EXCEPTION 'accented speaker text not matched'; END IF;

  -- A failing link never blocks the check-in, and G18 sees it.
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_speaker_link_ok') THEN RAISE EXCEPTION 'G18 before'; END IF;
  UPDATE leod_sessions SET people = '[{"name": 5}]'::jsonb, speaker_arrived = false WHERE id = s4;
  UPDATE leod_sessions SET status = 'PLANNED' WHERE id = s4;
  ALTER TABLE leod_event_log ADD CONSTRAINT probe_block_log CHECK (action <> 'SPEAKER_CHECKED_IN') NOT VALID;
  UPDATE leod_checkin_attendees SET checked_in_at = NULL WHERE id = ben;
  UPDATE leod_sessions SET people = '[{"name":"Ben Lee","role":"speaker"}]'::jsonb WHERE id = s4;
  UPDATE leod_checkin_attendees SET checked_in_at = now() WHERE id = ben;
  IF (SELECT checked_in_at FROM leod_checkin_attendees WHERE id = ben) IS NULL THEN RAISE EXCEPTION 'check-in blocked'; END IF;
  IF (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_speaker_link_ok') THEN RAISE EXCEPTION 'G18 missed the error'; END IF;
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers') THEN RAISE EXCEPTION 'G10'; END IF;
  RAISE EXCEPTION 'PROBE OK 112';
END;
$probe$;
