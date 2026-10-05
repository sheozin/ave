-- tests/sql/088-report-probe.sql
-- Run with `supabase db query --linked -f` or execute_sql. Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 088'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_test  uuid;
  v_early uuid;
  v_desk  uuid := gen_random_uuid();
  v_t     timestamptz := date_trunc('hour', now()) - interval '4 days';
  v_r     jsonb;
  v_denied int := 0;
  r uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_org, v_lead, v_view, v_out]) u;
  -- Event 4 days ago: its window closed a day ago, so the report is due.
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 088', (now() AT TIME ZONE 'Europe/Warsaw')::date - 4, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'live');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_view, 'viewer');
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, is_test) VALUES (v_ev, v_desk, 'Front desk', v_lead, false);
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, company, ticket_type, source, qr_token, checked_in_at)
  SELECT v_ev, 'P' || i, 'Probe', c, tt, src, 'p088' || i || replace(gen_random_uuid()::text, '-', ''), t
    FROM (VALUES (1, 'Acme', 'VIP', 'import', v_t), (2, 'acme', 'VIP', 'import', NULL::timestamptz),
                 (3, 'Zeta', 'attendee', 'import', v_t + interval '5 minutes'),
                 (4, NULL, 'attendee', 'walk_in', v_t + interval '40 minutes'),
                 (5, NULL, '', 'import', NULL)) v(i, c, tt, src, t);
  -- One on-time and one late (offline) desk scan.
  INSERT INTO leod_checkin_scan_events (id, event_id, client_id, attendee_id, operator_id, scanned_at, received_at, result, is_test, desk_id)
  VALUES (gen_random_uuid(), v_ev, gen_random_uuid(), NULL, v_lead, v_t, v_t + interval '2 seconds', 'ok', false, v_desk),
         (gen_random_uuid(), v_ev, gen_random_uuid(), NULL, v_lead, v_t + interval '5 minutes', v_t + interval '9 minutes', 'ok', false, v_desk);
  -- A test-mode event with the same timing never comes due.
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 088 test', (now() AT TIME ZONE 'Europe/Warsaw')::date - 4, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_test;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_test, true, 'test');
  -- A live event whose window closes tomorrow is not due yet.
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 088 early', (now() AT TIME ZONE 'Europe/Warsaw')::date - 1, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_early;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_early, true, 'live');

  -- A live event with an unknown timezone must not break the due list (090).
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 088 bad tz', (now() AT TIME ZONE 'Europe/Warsaw')::date - 4, '09:00', '18:00', 'Not/AZone', v_owner, 'checkin')
  RETURNING id INTO r;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (r, true, 'live');

  -- Due list and the one-time claim.
  IF NOT EXISTS (SELECT 1 FROM checkin_reports_due() WHERE event_id = v_ev AND owner_id = v_owner) THEN
    RAISE EXCEPTION 'FAIL not due'; END IF;
  IF EXISTS (SELECT 1 FROM checkin_reports_due() WHERE event_id IN (v_test, v_early)) THEN
    RAISE EXCEPTION 'FAIL test or early event due'; END IF;
  IF NOT checkin_claim_report(v_ev) THEN RAISE EXCEPTION 'FAIL first claim'; END IF;
  IF checkin_claim_report(v_ev) THEN RAISE EXCEPTION 'FAIL second claim won'; END IF;
  IF EXISTS (SELECT 1 FROM checkin_reports_due() WHERE event_id = v_ev) THEN RAISE EXCEPTION 'FAIL still due after claim'; END IF;
  PERFORM checkin_unclaim_report(v_ev);
  IF NOT EXISTS (SELECT 1 FROM checkin_reports_due() WHERE event_id = v_ev) THEN RAISE EXCEPTION 'FAIL unclaim'; END IF;
  IF checkin_claim_report(v_test) THEN RAISE EXCEPTION 'FAIL claimed a test event'; END IF;

  -- Organizer: full report with companies and desk labels.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_r := checkin_event_report(v_ev);
  RESET ROLE;
  IF (v_r->>'registered')::int <> 5 OR (v_r->>'checked_in')::int <> 3 OR (v_r->>'walk_ins')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL totals %', v_r; END IF;
  IF v_r->'by_ticket'->0->>'ticket_type' <> 'VIP' OR (v_r->'by_ticket'->0->>'no_shows')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL by_ticket %', v_r->'by_ticket'; END IF;
  IF NOT (v_r->'by_ticket') @> '[{"ticket_type":"No ticket type"}]' THEN RAISE EXCEPTION 'FAIL blank ticket type'; END IF;
  IF (v_r->'peak'->>'n')::int <> 2 THEN RAISE EXCEPTION 'FAIL peak %', v_r->'peak'; END IF;
  IF (v_r->'offline'->>'late_checkins')::int <> 1 OR (v_r->'offline'->>'longest_delay_s')::int <> 240 THEN
    RAISE EXCEPTION 'FAIL offline %', v_r->'offline'; END IF;
  IF v_r->'desks'->0->>'label' <> 'Front desk' OR (v_r->'desks'->0->>'checkins')::int <> 2 THEN
    RAISE EXCEPTION 'FAIL desks %', v_r->'desks'; END IF;
  IF jsonb_array_length(v_r->'companies') <> 1 OR lower(v_r->'companies'->0->>'company') <> 'acme' THEN
    RAISE EXCEPTION 'FAIL companies %', v_r->'companies'; END IF;
  IF v_r->>'role' <> 'organizer' THEN RAISE EXCEPTION 'FAIL role %', v_r->>'role'; END IF;

  -- Viewer: no companies, no desk labels.
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_r := checkin_event_report(v_ev);
  RESET ROLE;
  IF v_r ? 'companies' OR v_r->'desks'->0->>'label' IS NOT NULL THEN RAISE EXCEPTION 'FAIL viewer sees people data %', v_r; END IF;
  IF v_r::text ~* 'acme|zeta|Front desk' THEN RAISE EXCEPTION 'FAIL viewer text leak'; END IF;

  -- Lead and a stranger: refused. Clients cannot call the service functions.
  FOREACH r IN ARRAY ARRAY[v_lead, v_out] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM checkin_event_report(v_ev);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    BEGIN
      PERFORM checkin_claim_report(v_ev);
      RAISE EXCEPTION 'FAIL client claimed';
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
  END LOOP;
  IF v_denied <> 4 THEN RAISE EXCEPTION 'FAIL denied %', v_denied; END IF;

  RAISE EXCEPTION 'PROBE OK 088';
END
$probe$;
