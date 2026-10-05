-- tests/sql/084-company-board-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 084'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_ev    uuid;
  v_b     jsonb;
  v_denied int := 0;
  r uuid;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_lead, v_crew, v_view]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 084', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'live');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  -- Acme: 3 spellings, 4 people, 1 in. Zeta: 2 people, 0 in. Solo: 1, 1 in.
  -- Two with no company (null, blank) must not appear.
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, company, ticket_type, source, qr_token, checked_in_at)
  SELECT v_ev, 'P' || i, 'Probe', c, 'attendee', 'import', 'p084' || i || replace(gen_random_uuid()::text, '-', ''), t
    FROM (VALUES (1, 'Acme', now() - interval '5 minutes'), (2, ' ACME ', NULL), (3, 'acme  corp', NULL),
                 (4, 'Acme', NULL), (5, 'Zeta', NULL), (6, 'Zeta', NULL), (7, 'Solo', now() - interval '1 minute'),
                 (8, NULL, NULL), (9, '  ', NULL)) v(i, c, t);

  -- Owner, then lead: allowed.
  FOREACH r IN ARRAY ARRAY[v_owner, v_lead] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_b := checkin_company_board(v_ev);
    RESET ROLE;
  END LOOP;
  -- 'acme  corp' is a different company (whitespace collapses, words stay).
  IF jsonb_array_length(v_b) <> 4 THEN RAISE EXCEPTION 'FAIL rows %', v_b; END IF;
  IF v_b->0->>'company' <> 'Acme' OR (v_b->0->>'expected')::int <> 3 OR (v_b->0->>'arrived')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL acme merge/sort %', v_b->0; END IF;
  IF v_b->1->>'company' <> 'Zeta' OR (v_b->1->>'arrived')::int <> 0 OR v_b->1->>'last_arrival_at' IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL zeta %', v_b->1; END IF;
  IF v_b::text ~* 'probe|P1' THEN RAISE EXCEPTION 'FAIL names leaked'; END IF;

  -- Crew and viewer: refused.
  FOREACH r IN ARRAY ARRAY[v_crew, v_view] LOOP
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', r, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    BEGIN
      PERFORM checkin_company_board(v_ev);
    EXCEPTION WHEN insufficient_privilege THEN v_denied := v_denied + 1;
    END;
    RESET ROLE;
  END LOOP;
  IF v_denied <> 2 THEN RAISE EXCEPTION 'FAIL denied %', v_denied; END IF;

  RAISE EXCEPTION 'PROBE OK 084';
END
$probe$;
