-- tests/sql/085-vip-alerts-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 085'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_ev    uuid;
  v_vip   uuid := gen_random_uuid();
  v_std   uuid := gen_random_uuid();
  v_desk  uuid := gen_random_uuid();
  v_types text[];
  v_a     jsonb;
  v_n     int;
  v_denied int := 0;
  v_t     timestamptz := now() - interval '1 minute';
  r uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_crew, v_view]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 085', current_date, '00:00', '23:59', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count, is_test)
  VALUES (v_ev, v_desk, 'Desk 2', v_crew, now(), 0, true);
  -- The guest list says 'vip ' (lower case, trailing space); the alert list says 'VIP'.
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, company, ticket_type, source, qr_token) VALUES
    (v_vip, v_ev, 'Ewa', 'Sample', 'Contoso Demo', 'vip ', 'import', 'p085a' || replace(gen_random_uuid()::text, '-', '')),
    (v_std, v_ev, 'Jan', 'Plain', NULL, 'attendee', 'import', 'p085b' || replace(gen_random_uuid()::text, '-', ''));

  -- Setter: organizer allowed and normalises; lead refused.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_types := checkin_set_alert_ticket_types(v_ev, ARRAY['VIP', ' vip', '', 'Speaker ']);
  RESET ROLE;
  IF v_types <> ARRAY['VIP', 'Speaker'] THEN RAISE EXCEPTION 'FAIL normalise %', v_types; END IF;
  IF (SELECT status FROM leod_checkin_entitlements WHERE event_id = v_ev) <> 'test' THEN
    RAISE EXCEPTION 'FAIL setter changed status'; END IF;
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_set_alert_ticket_types(v_ev, ARRAY['X']);
    RAISE EXCEPTION 'FAIL lead set types';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Scans (service path): VIP ok -> alert; standard ok -> none; VIP duplicate -> none.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_vip, v_t, 'checkin', NULL, v_crew, NULL, true, v_desk);
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_std, v_t, 'checkin', NULL, v_crew, NULL, true, v_desk);
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_vip, v_t, 'checkin', NULL, v_crew, NULL, true, v_desk);
  SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL alert count %', v_n; END IF;
  IF NOT (SELECT is_test FROM leod_checkin_alerts WHERE event_id = v_ev) THEN RAISE EXCEPTION 'FAIL is_test'; END IF;

  -- Reader: lead sees name, company, desk label, still_in.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_a := checkin_recent_alerts(v_ev);
  SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;  -- RLS: lead reads the row
  RESET ROLE;
  IF v_a->0->>'name' <> 'Ewa Sample' OR v_a->0->>'company' <> 'Contoso Demo' OR v_a->0->>'desk_label' <> 'Desk 2'
     OR v_a->0->>'ticket_type' <> 'vip' OR NOT (v_a->0->>'still_in')::boolean THEN
    RAISE EXCEPTION 'FAIL reader %', v_a; END IF;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL lead rls %', v_n; END IF;

  -- Crew and viewer: reader refused, table rows invisible.
  FOREACH r IN ARRAY ARRAY[v_crew, v_view] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM checkin_recent_alerts(v_ev);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL rls leak to %', r; END IF;
  END LOOP;
  IF v_denied <> 2 THEN RAISE EXCEPTION 'FAIL denied %', v_denied; END IF;

  -- Clients cannot write alerts.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO leod_checkin_alerts (event_id, attendee_id, ticket_type, is_test) VALUES (v_ev, v_std, 'x', true);
    RAISE EXCEPTION 'FAIL client insert';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  -- Undo (lead may undo any): alert stays, still_in false.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM checkin_apply_scan(v_ev, gen_random_uuid(), v_vip, now(), 'undo', v_t, v_lead, NULL, true, NULL);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_a := checkin_recent_alerts(v_ev);
  RESET ROLE;
  IF jsonb_array_length(v_a) <> 1 OR (v_a->0->>'still_in')::boolean THEN RAISE EXCEPTION 'FAIL undo %', v_a; END IF;

  -- Go-live deletes test alerts.
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = v_ev;
  SELECT count(*) INTO v_n FROM leod_checkin_alerts WHERE event_id = v_ev;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL go-live left % alerts', v_n; END IF;

  -- The table is in the Realtime publication.
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'leod_checkin_alerts') THEN
    RAISE EXCEPTION 'FAIL not published'; END IF;

  RAISE EXCEPTION 'PROBE OK 085';
END
$probe$;
