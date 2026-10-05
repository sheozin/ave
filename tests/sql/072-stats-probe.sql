-- tests/sql/072-stats-probe.sql
-- Run with execute_sql (one statement). Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 072'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_lead  uuid := gen_random_uuid();
  v_crew  uuid := gen_random_uuid();
  v_view  uuid := gen_random_uuid();
  v_out   uuid := gen_random_uuid();
  v_ev    uuid;
  v_a1    uuid := gen_random_uuid();
  v_a3    uuid := gen_random_uuid();
  v_d     uuid := gen_random_uuid();
  v_dt    uuid := gen_random_uuid();
  v_d2    uuid := gen_random_uuid();
  v_kA    int;
  v_kB    int;
  v_t0    timestamptz := to_timestamp(floor(extract(epoch FROM now() - interval '2 hours') / 900) * 900);
  v_t1    timestamptz := date_trunc('minute', now()) - interval '60 minutes';
  v_s     jsonb;
  v_n     int := 0;
  -- Strings no viewer or desk staff may receive: guest names, companies
  -- and emails, desk and kiosk labels, operator emails, the desk ids and
  -- the desk operator's user id.
  v_people text;
  v_ids    text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_lead, v_crew, v_view, v_out]) AS u;
  -- The organizer has a name, so the desk panel can show it.
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  VALUES (v_org, 'probe-' || v_org || '@cuedeck-test.io', 'authenticated', 'authenticated',
          '{"checkin_staff":"true","name":"Ola Organizer"}'::jsonb);
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 072', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin')
  RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'live');
  INSERT INTO leod_checkin_operators (event_id, user_id, role)
  VALUES (v_ev, v_org, 'organizer'), (v_ev, v_lead, 'lead'), (v_ev, v_crew, 'crew'), (v_ev, v_view, 'viewer');
  -- Five guests. Names, companies and emails are unique strings so the
  -- probe can prove none of them reaches a viewer.
  INSERT INTO leod_checkin_attendees (id, event_id, first_name, last_name, company, email, ticket_type, source, qr_token, qr_email_sent_at, checked_in_at) VALUES
    (v_a1, v_ev, 'Zelda', 'Uniquename', 'Zcorp Probe', 'zelda.probe@example.invalid', 'attendee', 'import', 'z1' || replace(gen_random_uuid()::text, '-', ''), now(), v_t0 + interval '1 minute'),
    (gen_random_uuid(), v_ev, 'Yann', 'Uniquename', NULL, 'yann.probe@example.invalid', 'attendee', 'import', 'z2' || replace(gen_random_uuid()::text, '-', ''), NULL, v_t0 + interval '16 minutes'),
    (v_a3, v_ev, 'Xena', 'Uniquename', NULL, NULL, 'VIP', 'kiosk', 'z3' || replace(gen_random_uuid()::text, '-', ''), NULL, NULL),
    (gen_random_uuid(), v_ev, 'Will', 'Uniquename', NULL, 'will.probe@example.invalid', 'VIP', 'walk_in', 'z4' || replace(gen_random_uuid()::text, '-', ''), NULL, NULL),
    (gen_random_uuid(), v_ev, 'Vera', 'Uniquename', NULL, 'vera.probe@example.invalid', 'attendee', 'import', 'z5' || replace(gen_random_uuid()::text, '-', ''), NULL, date_trunc('minute', now()) - interval '2 minutes');
  -- One desk, one kiosk, and a desk history with two offline gaps:
  -- on time, 3 late (ok, ok, duplicate), on time, 1 late (ok).
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count)
  VALUES (v_ev, v_d, 'Desk 1', v_lead, now() - interval '30 seconds', 0);
  -- A second desk with the SAME label (labels are not unique), 7 pending
  -- and one late 'ok' scan of its own: its row, speed and gap must line
  -- up under one k, distinct from the first desk's.
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count)
  VALUES (v_ev, v_d2, 'Desk 1', v_org, now() - interval '200 seconds', 7);
  -- A test desk left behind on a live event (go-live deletes these; the
  -- function must hide it anyway), with one late 'ok' scan of its own.
  INSERT INTO leod_checkin_desks (event_id, desk_id, label, operator_id, last_seen_at, pending_count, is_test)
  VALUES (v_ev, v_dt, 'Ztestdesk', v_lead, now() - interval '5 seconds', 0, true);
  INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash, last_seen_at)
  VALUES (v_ev, 'Lobby kiosk', 'kiosk', 'probe' || gen_random_uuid(), now() - interval '12 seconds');
  INSERT INTO leod_checkin_scan_events (id, event_id, client_id, attendee_id, scanned_at, received_at, result, desk_id) VALUES
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1,                         v_t1,                                          'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '1 minute',  v_t1 + interval '6 minutes',                  'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '2 minutes', v_t1 + interval '6 minutes',                  'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '3 minutes', v_t1 + interval '6 minutes',                  'duplicate', v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '4 minutes', v_t1 + interval '4 minutes 10 seconds',       'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '5 minutes', v_t1 + interval '9 minutes',                  'ok',        v_d),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '7 minutes', v_t1 + interval '20 minutes',                 'ok',        v_dt),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a1, v_t1 + interval '30 minutes', v_t1 + interval '40 minutes',                'ok',        v_d2),
    -- Xena was checked in and then undone (checked_in_at is NULL): the
    -- 'ok' scan must not make her count.
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a3, now() - interval '3 minutes', now() - interval '3 minutes', 'ok',   NULL),
    (gen_random_uuid(), v_ev, gen_random_uuid(), v_a3, now() - interval '1 minute',  now() - interval '1 minute',  'undo', NULL);

  v_people := '(Uniquename|Zelda|Zcorp|probe@example|cuedeck-test|Desk 1|Ztestdesk|Lobby kiosk|Ola Organizer|Unnamed|desk_id|operator)';
  v_ids    := '(' || v_d || '|' || v_d2 || '|' || v_dt || '|' || v_lead || '|' || v_org || ')';

  -- ── grants ──
  IF has_function_privilege('anon', 'checkin_event_stats(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'PROBE FAIL: anon may execute'; END IF;
  IF NOT has_function_privilege('authenticated', 'checkin_event_stats(uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'PROBE FAIL: authenticated may not execute'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
              WHERE p.oid = 'checkin_event_stats(uuid)'::regprocedure AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PROBE FAIL: PUBLIC may execute'; END IF;
  v_n := v_n + 3;

  -- ── viewer: counts only ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_view, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->>'role' <> 'viewer' THEN RAISE EXCEPTION 'PROBE FAIL: role %', v_s->>'role'; END IF;
  IF (v_s->>'registered')::int <> 5 THEN RAISE EXCEPTION 'PROBE FAIL: registered %', v_s->>'registered'; END IF;
  IF (v_s->>'checked_in')::int <> 3 THEN RAISE EXCEPTION 'PROBE FAIL: checked_in % (undone check-in counted?)', v_s->>'checked_in'; END IF;
  IF (v_s->>'walk_ins')::int <> 2 THEN RAISE EXCEPTION 'PROBE FAIL: walk_ins %', v_s->>'walk_ins'; END IF;
  IF v_s->'by_source' <> '{"import":3,"kiosk":1,"walk_in":1}'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: by_source %', v_s->'by_source'; END IF;
  IF v_s->'qr' <> '{"sent":1,"not_sent":3,"no_email":1}'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: qr %', v_s->'qr'; END IF;
  IF v_s->'by_ticket' <> '[{"ticket_type":"attendee","registered":3,"checked_in":3},{"ticket_type":"VIP","registered":2,"checked_in":0}]'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL: by_ticket %', v_s->'by_ticket'; END IF;
  IF jsonb_array_length(v_s->'arrivals') <> 3 THEN RAISE EXCEPTION 'PROBE FAIL: arrivals %', v_s->'arrivals'; END IF;
  IF (v_s->'arrivals'->0->>'t')::bigint % 900 <> 0 THEN RAISE EXCEPTION 'PROBE FAIL: bucket not on 15 minutes'; END IF;
  IF jsonb_array_length(v_s->'last_25_min') <> 25 THEN RAISE EXCEPTION 'PROBE FAIL: last_25_min length'; END IF;
  IF (v_s->'last_25_min'->>22)::int <> 1 OR (v_s->'last_25_min'->>21)::int <> 0 THEN
    RAISE EXCEPTION 'PROBE FAIL: last_25_min % (undone check-in counted?)', v_s->'last_25_min'; END IF;
  IF v_s->'ops' <> 'null'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: viewer got ops'; END IF;
  IF v_s::text ~ v_people THEN RAISE EXCEPTION 'PROBE FAIL: people or desk data reached a viewer: %', v_s; END IF;
  IF v_s::text ~ v_ids THEN RAISE EXCEPTION 'PROBE FAIL: an id reached a viewer'; END IF;
  v_n := v_n + 14;

  -- ── crew: full numbers, no desk panel ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_crew, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->>'role' <> 'crew' OR (v_s->>'checked_in')::int <> 3 THEN RAISE EXCEPTION 'PROBE FAIL: crew got % / %', v_s->>'role', v_s->>'checked_in'; END IF;
  IF v_s->'ops' <> 'null'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: crew got ops'; END IF;
  IF v_s::text ~ v_people OR v_s::text ~ v_ids THEN RAISE EXCEPTION 'PROBE FAIL: people, desk data or ids reached desk staff'; END IF;
  v_n := v_n + 3;

  -- ── lead: desk panel ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_lead, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->'ops' = 'null'::jsonb THEN RAISE EXCEPTION 'PROBE FAIL: lead got no ops'; END IF;
  IF jsonb_array_length(v_s->'ops'->'desks') <> 2
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_s->'ops'->'desks') e WHERE e->>'label' <> 'Desk 1') THEN
    RAISE EXCEPTION 'PROBE FAIL: desks % (test desk shown on a live event?)', v_s->'ops'->'desks'; END IF;
  SELECT (e->>'k')::int INTO v_kA FROM jsonb_array_elements(v_s->'ops'->'desks') e WHERE (e->>'pending_count')::int = 0;
  SELECT (e->>'k')::int INTO v_kB FROM jsonb_array_elements(v_s->'ops'->'desks') e WHERE (e->>'pending_count')::int = 7;
  IF v_kA IS NULL OR v_kB IS NULL OR v_kA = v_kB THEN
    RAISE EXCEPTION 'PROBE FAIL: same-label desks need distinct k: %', v_s->'ops'->'desks'; END IF;
  IF (SELECT (e->>'seconds_since_seen')::int FROM jsonb_array_elements(v_s->'ops'->'desks') e WHERE (e->>'k')::int = v_kA) NOT BETWEEN 25 AND 40 THEN
    RAISE EXCEPTION 'PROBE FAIL: seconds_since_seen %', v_s->'ops'->'desks'; END IF;
  IF (SELECT e->>'operator' FROM jsonb_array_elements(v_s->'ops'->'desks') e WHERE (e->>'k')::int = v_kA) <> 'Unnamed'
     OR (SELECT e->>'operator' FROM jsonb_array_elements(v_s->'ops'->'desks') e WHERE (e->>'k')::int = v_kB) <> 'Ola Organizer' THEN
    RAISE EXCEPTION 'PROBE FAIL: operator names %', v_s->'ops'->'desks'; END IF;
  IF jsonb_array_length(v_s->'ops'->'kiosks') <> 1 OR v_s->'ops'->'kiosks'->0->>'label' <> 'Lobby kiosk' THEN
    RAISE EXCEPTION 'PROBE FAIL: kiosks %', v_s->'ops'->'kiosks'; END IF;
  IF jsonb_array_length(v_s->'ops'->'gaps') <> 3 THEN RAISE EXCEPTION 'PROBE FAIL: gaps % (test desk gap shown?)', v_s->'ops'->'gaps'; END IF;
  -- Desk A: two gaps, newest first (1 ok at t1+5, then 2 ok over t1+1..t1+3).
  IF (SELECT jsonb_agg(jsonb_build_array(e->>'synced_ok', (e->>'start_at')::timestamptz, (e->>'end_at')::timestamptz) ORDER BY (e->>'start_at')::timestamptz DESC)
        FROM jsonb_array_elements(v_s->'ops'->'gaps') e WHERE (e->>'k')::int = v_kA)
     IS DISTINCT FROM jsonb_build_array(
        jsonb_build_array('1', v_t1 + interval '5 minutes', v_t1 + interval '5 minutes'),
        jsonb_build_array('2', v_t1 + interval '1 minute', v_t1 + interval '3 minutes')) THEN
    RAISE EXCEPTION 'PROBE FAIL: desk A gaps % (k %)', v_s->'ops'->'gaps', v_kA; END IF;
  -- Desk B: its one gap, under its own k.
  IF (SELECT count(*) FROM jsonb_array_elements(v_s->'ops'->'gaps') e
       WHERE (e->>'k')::int = v_kB AND (e->>'synced_ok')::int = 1
         AND (e->>'start_at')::timestamptz = v_t1 + interval '30 minutes') <> 1
     OR (v_s->'ops'->'gaps'->0->>'k')::int <> v_kB THEN
    RAISE EXCEPTION 'PROBE FAIL: desk B gap % (k %)', v_s->'ops'->'gaps', v_kB; END IF;
  IF jsonb_array_length(v_s->'ops'->'speeds') <> 2
     OR (SELECT count(*) FROM jsonb_array_elements(v_s->'ops'->'speeds') e
          WHERE (e->>'k')::int = v_kA AND e->>'label' = 'Desk 1'
            AND (e->>'busiest_15')::int = 5 AND (e->>'active_minutes')::int = 5) <> 1
     OR (SELECT count(*) FROM jsonb_array_elements(v_s->'ops'->'speeds') e
          WHERE (e->>'k')::int = v_kB AND (e->>'busiest_15')::int = 1 AND (e->>'active_minutes')::int = 1) <> 1 THEN
    RAISE EXCEPTION 'PROBE FAIL: speeds % (kA %, kB %)', v_s->'ops'->'speeds', v_kA, v_kB; END IF;
  -- No desk_id key and no desk or user id anywhere; no operator email.
  IF v_s::text ~ 'desk_id' OR v_s::text ~ v_ids THEN
    RAISE EXCEPTION 'PROBE FAIL: a desk_id or user id reached the lead: %', v_s->'ops'; END IF;
  IF v_s::text ~ 'cuedeck-test' THEN RAISE EXCEPTION 'PROBE FAIL: an operator email reached the lead'; END IF;
  IF v_s::text ~ 'Ztestdesk' THEN RAISE EXCEPTION 'PROBE FAIL: test desk shown on a live event'; END IF;
  IF v_s::text ~ '(Uniquename|Zelda|Zcorp|probe@example)' THEN RAISE EXCEPTION 'PROBE FAIL: guest data reached the lead'; END IF;
  v_n := v_n + 14;

  -- ── organizer (not the owner): desk panel ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->>'role' <> 'organizer' OR v_s->'ops' = 'null'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL: organizer got % / %', v_s->>'role', v_s->'ops'; END IF;
  v_n := v_n + 1;

  -- ── owner, with no operator row at all ──
  DELETE FROM leod_checkin_operators WHERE event_id = v_ev AND user_id = v_owner;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_s := checkin_event_stats(v_ev);
  RESET ROLE;
  IF v_s->>'role' <> 'owner' OR v_s->'ops' = 'null'::jsonb OR v_s->>'status' <> 'live' THEN
    RAISE EXCEPTION 'PROBE FAIL: owner got % / % / %', v_s->>'role', v_s->'ops', v_s->>'status'; END IF;
  v_n := v_n + 1;

  -- ── outsider ──
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_out, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_s := checkin_event_stats(v_ev);
    RAISE EXCEPTION 'PROBE FAIL: outsider read stats';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  -- ── signed out ──
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  BEGIN
    v_s := checkin_event_stats(v_ev);
    RAISE EXCEPTION 'PROBE FAIL: no uid read stats';
  EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1;
  END;
  RESET ROLE;

  RAISE EXCEPTION 'PROBE OK 072: % checks passed (rolled back)', v_n;
END
$probe$;
