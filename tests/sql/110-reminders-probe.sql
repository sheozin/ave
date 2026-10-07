-- tests/sql/110-reminders-probe.sql: reminder and thank-you claims, settings, G17. Ends in 'PROBE OK 110'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
  v_res jsonb;
  v_n   int;
  a1 uuid; a2 uuid; a3 uuid; a4 uuid;
  v_doors timestamptz;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;

  -- ── strangers ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_reminders(E, true, NULL, true, NULL, NULL); RAISE EXCEPTION 'stranger set'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM checkin_reminder_status(E); RAISE EXCEPTION 'stranger status'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- ── owner: settings ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_reminders(E, true, NULL, true, NULL, 'javascript:alert(1)'); RAISE EXCEPTION 'bad link accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_set_reminders(E, true, repeat('x', 601), true, NULL, NULL); RAISE EXCEPTION 'long note accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  v_res := checkin_set_reminders(E, true, '  Bring your laptop.  ', true, 'Slides are online.', 'https://example.com/slides');
  IF v_res->>'reminder_message' <> 'Bring your laptop.' OR v_res->>'thankyou_link' <> 'https://example.com/slides' THEN RAISE EXCEPTION 'settings: %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── a live event whose doors open in 10 hours (UTC) ──
  UPDATE leod_events SET timezone = 'UTC', date = (now() + interval '10 hours')::date,
         event_start = (now() + interval '10 hours')::time, event_end = (now() + interval '12 hours')::time WHERE id = E;
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  DELETE FROM leod_checkin_reminder_sends WHERE event_id = E;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test, created_at)
  VALUES (E, 'Ann', 'A', 'ann@example.invalid', 'tok-a1', 'import', false, now() - interval '2 days') RETURNING id INTO a1;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test, created_at)
  VALUES (E, 'Ben', 'B', 'ben@example.invalid', 'tok-a2', 'import', false, now() - interval '2 days') RETURNING id INTO a2;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'No', 'Mail', NULL, 'tok-a3', 'import', false) RETURNING id INTO a3;
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test)
  VALUES (E, 'Tess', 'Test', 'tess@example.invalid', 'tok-a4', 'web', true) RETURNING id INTO a4;

  -- Claims: the two real guests with email, once each.
  SELECT count(*) INTO v_n FROM checkin_claim_reminders(100) c WHERE c.event_id = E AND c.kind = 'reminder';
  IF v_n <> 2 THEN RAISE EXCEPTION 'first claim: % rows', v_n; END IF;
  SELECT count(*) INTO v_n FROM checkin_claim_reminders(100) c WHERE c.event_id = E;
  IF v_n <> 0 THEN RAISE EXCEPTION 'claimed twice: %', v_n; END IF;
  -- A failed send gives the claim back; the next run retries it.
  PERFORM checkin_unclaim_reminder(a2, 'reminder');
  SELECT count(*) INTO v_n FROM checkin_claim_reminders(100) c WHERE c.event_id = E AND c.attendee_id = a2;
  IF v_n <> 1 THEN RAISE EXCEPTION 'retry after unclaim: %', v_n; END IF;
  -- No thank-you before the event.
  IF EXISTS (SELECT 1 FROM leod_checkin_reminder_sends WHERE event_id = E AND kind = 'thankyou') THEN RAISE EXCEPTION 'early thank-you'; END IF;

  -- Status for the organizer.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_res := checkin_reminder_status(E);
  IF (v_res->>'reminder_sent')::int <> 2 OR (v_res->>'reminder_from')::timestamptz > now() THEN RAISE EXCEPTION 'status: %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', '', true);

  -- ── G17: doors opened, one guest never got theirs ──
  UPDATE leod_events SET date = (now() - interval '1 hour')::date, event_start = (now() - interval '1 hour')::time,
         event_end = (now() + interval '1 hour')::time WHERE id = E;
  DELETE FROM leod_checkin_reminder_sends WHERE attendee_id = a1;
  IF (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_reminders_sent') THEN RAISE EXCEPTION 'G17 missed an unsent reminder'; END IF;
  -- Nothing is claimed once doors have opened.
  SELECT count(*) INTO v_n FROM checkin_claim_reminders(100) c WHERE c.event_id = E;
  IF v_n <> 0 THEN RAISE EXCEPTION 'reminder after doors: %', v_n; END IF;
  INSERT INTO leod_checkin_reminder_sends (attendee_id, kind, event_id) VALUES (a1, 'reminder', E);
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_reminders_sent') THEN RAISE EXCEPTION 'G17 after send'; END IF;

  -- ── thank-you: ended 3 hours ago, only guests who came ──
  UPDATE leod_events SET date = (now() - interval '6 hours')::date, event_start = (now() - interval '6 hours')::time,
         event_end = (now() - interval '3 hours')::time WHERE id = E;
  UPDATE leod_checkin_attendees SET checked_in_at = now() - interval '5 hours' WHERE id = a1;
  SELECT count(*) INTO v_n FROM checkin_claim_reminders(100) c WHERE c.event_id = E AND c.kind = 'thankyou' AND c.attendee_id = a1;
  IF v_n <> 1 THEN RAISE EXCEPTION 'thank-you to the guest who came: %', v_n; END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_reminder_sends WHERE kind = 'thankyou' AND attendee_id IN (a2, a3, a4)) THEN RAISE EXCEPTION 'thank-you to someone who did not come'; END IF;

  -- ── off, or test mode: nothing ──
  DELETE FROM leod_checkin_reminder_sends WHERE event_id = E;
  UPDATE leod_checkin_entitlements SET thankyou_enabled = false WHERE event_id = E;
  SELECT count(*) INTO v_n FROM checkin_claim_reminders(100) c WHERE c.event_id = E;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sent while off: %', v_n; END IF;
  UPDATE leod_checkin_entitlements SET thankyou_enabled = true, status = 'test' WHERE event_id = E;
  SELECT count(*) INTO v_n FROM checkin_claim_reminders(100) c WHERE c.event_id = E;
  IF v_n <> 0 THEN RAISE EXCEPTION 'sent in test mode: %', v_n; END IF;

  -- An event ending after midnight ends the next day.
  IF checkin_event_ends('2026-10-10', '20:00', '02:00', 'UTC') <> '2026-10-11 02:00+00' THEN RAISE EXCEPTION 'past midnight end'; END IF;

  IF NOT (SELECT bool_and(ok) FROM checkin_guard_results()
           WHERE guard IN ('checkin_rpcs_refuse_strangers', 'public_tables_rls_on', 'checkin_tables_not_anon_writable', 'security_definer_search_path')) THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  RAISE EXCEPTION 'PROBE OK 110';
END;
$probe$;
