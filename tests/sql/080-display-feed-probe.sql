-- tests/sql/080-display-feed-probe.sql
-- Run after 080. Expected: an error whose message starts with 'PROBE OK 080'.
-- Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner    uuid := gen_random_uuid();
  v_other    uuid := gen_random_uuid();
  v_ev       uuid;
  v_ev2      uuid;
  v_disp     uuid;
  v_disp2    uuid;
  v_secret   text;
  v_secret2  text;
  v_feed     jsonb;
  v_res      jsonb;
  v_ok       boolean;
  v_n        int;
  v_seen     timestamptz;
  v_nonce    text := md5(random()::text) || md5(random()::text);
  v_checks   int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_other]) AS u;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 080', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 080 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;

  INSERT INTO leod_sessions (event_id, sort_order, title, speaker, room, notes,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev,  2, 'Probe second', 'Speaker B', 'Hall A', 'PROBE-PRIVATE-NOTE', '10:00', '11:00', '10:00', '11:00'),
         (v_ev,  1, 'Probe first',  'Speaker A', 'Hall A', NULL,                 '09:00', '10:00', '09:00', '10:00'),
         (v_ev2, 1, 'PROBE-OTHER-EVENT', NULL, NULL, NULL,                       '09:00', '10:00', '09:00', '10:00');

  INSERT INTO leod_signage_sponsors (event_id, name, active) VALUES
    (v_ev, 'Probe sponsor on', true), (v_ev, 'Probe sponsor off', false), (v_ev2, 'PROBE-OTHER-SPONSOR', true);

  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev,  'Probe TV')
    RETURNING id, display_secret INTO v_disp, v_secret;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev2, 'Probe other TV')
    RETURNING id, display_secret INTO v_disp2, v_secret2;

  -- 1. existing rows and new rows get a 48-hex secret
  IF v_secret !~ '^[0-9a-f]{48}$' OR v_secret = v_secret2 THEN
    RAISE EXCEPTION 'PROBE FAIL 1: secret is %', v_secret;
  END IF;
  IF EXISTS (SELECT 1 FROM leod_signage_displays WHERE display_secret IS NULL OR display_secret !~ '^[0-9a-f]{48}$') THEN
    RAISE EXCEPTION 'PROBE FAIL 1: a display has no valid secret';
  END IF;
  v_checks := v_checks + 1;

  -- 2. anon with the right secret gets this event's feed
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp, v_secret);
  RESET ROLE;
  IF v_feed IS NULL
     OR jsonb_array_length(v_feed->'sessions') <> 2
     OR v_feed->'sessions'->0->>'title' <> 'Probe first'
     OR v_feed->'event'->>'name' <> 'Probe 080'
     OR v_feed->'display'->>'id' <> v_disp::text
     OR jsonb_array_length(v_feed->'sponsors') <> 1
     OR v_feed->>'server_time' IS NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 2: feed is %', v_feed;
  END IF;
  v_checks := v_checks + 1;

  -- 3. nothing private: no notes, no secret, no other event
  IF v_feed::text LIKE '%PROBE-PRIVATE-NOTE%'
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(v_feed->'sessions') s WHERE s ? 'notes')
     OR v_feed->'display' ? 'display_secret'
     OR v_feed::text LIKE '%' || v_secret || '%'
     OR v_feed::text LIKE '%PROBE-OTHER%' THEN
    RAISE EXCEPTION 'PROBE FAIL 3: feed leaks: %', v_feed;
  END IF;
  v_checks := v_checks + 1;

  -- 4. wrong secret, another display's secret, unknown id, null: all NULL
  SET LOCAL ROLE anon;
  IF display_feed(v_disp, repeat('0', 48)) IS NOT NULL
     OR display_feed(v_disp, v_secret2) IS NOT NULL
     OR display_feed(gen_random_uuid(), v_secret) IS NOT NULL
     OR display_feed(v_disp, NULL) IS NOT NULL
     OR display_feed(NULL, v_secret) IS NOT NULL THEN
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 4: a bad id/secret pair returned a feed';
  END IF;
  RESET ROLE;
  v_checks := v_checks + 1;

  -- 5. the feed is the heartbeat
  SELECT last_seen_at INTO v_seen FROM leod_signage_displays WHERE id = v_disp;
  IF v_seen IS NULL THEN RAISE EXCEPTION 'PROBE FAIL 5: last_seen_at not set'; END IF;
  v_checks := v_checks + 1;

  -- 6. anon cannot read or heartbeat displays directly any more
  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO v_n FROM leod_signage_displays;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: anon sees % displays', v_n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  IF has_table_privilege('anon', 'public.leod_signage_displays', 'SELECT')
     OR has_column_privilege('anon', 'public.leod_signage_displays', 'last_seen_at', 'UPDATE') THEN
    RAISE EXCEPTION 'PROBE FAIL 6: anon still holds display privileges';
  END IF;
  v_checks := v_checks + 1;

  -- 7. another signed-in user cannot read this event's display (or its secret)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_signage_displays WHERE id = v_disp;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 7: other user sees the display'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_signage_displays WHERE id = v_disp AND display_secret = v_secret;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 7: owner cannot read own display secret'; END IF;
  v_checks := v_checks + 1;

  -- 8. pair_start validates and refuses a live duplicate
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  v_ok := display_pair_start('PRB234', v_nonce);
  IF v_ok IS DISTINCT FROM true
     OR display_pair_start('PRB234', v_nonce) IS DISTINCT FROM false
     OR display_pair_start('prb235', v_nonce) IS DISTINCT FROM false
     OR display_pair_start('PRB0O1', v_nonce) IS DISTINCT FROM false
     OR display_pair_start('PRB236', 'not-hex') IS DISTINCT FROM false
     OR display_pair_start('PRB236', repeat('a', 31)) IS DISTINCT FROM false THEN
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 8: pair_start validation';
  END IF;
  -- nothing linked yet
  IF display_pair_poll('PRB234', v_nonce) IS NOT NULL THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 8: poll before link returned data';
  END IF;
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM leod_signage_pairing WHERE code = 'PRB234' AND device_nonce_hash = v_nonce) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: nonce stored in clear';
  END IF;
  v_checks := v_checks + 1;

  -- 9. another user cannot link the code to a display they do not own, nor change the nonce
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE leod_signage_pairing SET display_id = v_disp, event_id = v_ev WHERE code = 'PRB234';
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 9: other user linked a foreign display';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  -- even the owner, whose link would pass the policy, cannot touch other columns
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE leod_signage_pairing SET display_id = v_disp, event_id = v_ev, device_nonce_hash = 'x' WHERE code = 'PRB234';
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 9: authenticated changed the nonce hash';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  v_checks := v_checks + 1;

  -- 10. the owner finds the code and links it (console pairDisplayByCode)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_signage_pairing WHERE code = 'PRB234' AND display_id IS NULL;
  IF v_n <> 1 THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 10: owner cannot find the code'; END IF;
  UPDATE leod_signage_pairing SET display_id = v_disp, event_id = v_ev WHERE code = 'PRB234';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 10: owner link updated % rows', v_n; END IF;
  v_checks := v_checks + 1;

  -- 11. only the device holding the nonce learns the secret
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF display_pair_poll('PRB234', md5('wrong') || md5('nonce')) IS NOT NULL
     OR display_pair_poll('PRB234', NULL) IS NOT NULL THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 11: wrong nonce returned data';
  END IF;
  v_res := display_pair_poll('PRB234', v_nonce);
  RESET ROLE;
  IF v_res->>'display_id' IS DISTINCT FROM v_disp::text OR v_res->>'secret' IS DISTINCT FROM v_secret THEN
    RAISE EXCEPTION 'PROBE FAIL 11: right nonce returned %', v_res;
  END IF;
  v_checks := v_checks + 1;

  -- 12. the three functions are callable by anon and authenticated, not PUBLIC
  IF NOT (has_function_privilege('anon', 'public.display_feed(uuid,text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.display_pair_start(text,text)', 'EXECUTE')
      AND has_function_privilege('anon', 'public.display_pair_poll(text,text)', 'EXECUTE'))
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.proname IN ('display_feed','display_pair_start','display_pair_poll')
                   AND p.pronamespace = 'public'::regnamespace AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PROBE FAIL 12: function grants';
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 080: % checks passed (rolled back)', v_checks;
END
$probe$;
