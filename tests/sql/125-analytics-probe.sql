-- tests/sql/125-analytics-probe.sql. Ends in 'PROBE OK 125'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_code text;
  v_res  jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_registration_analytics(E); RAISE EXCEPTION 'stranger'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_code := (checkin_set_registration(E, true, NULL, NULL, '[]'))->>'code';
  PERFORM set_config('request.jwt.claims', '', true);
  UPDATE leod_checkin_entitlements SET status = 'live' WHERE event_id = E;
  DELETE FROM leod_checkin_web_views WHERE event_id = E; DELETE FROM leod_checkin_web_seen WHERE event_id = E;
  DELETE FROM leod_checkin_attendees WHERE event_id = E;
  -- Three visits: two people, one of them twice (counted once), plus junk that counts nothing.
  PERFORM checkin_web_count_view(v_code, 'direct', repeat('a', 64));
  PERFORM checkin_web_count_view(v_code, 'linkedin', repeat('a', 64));
  PERFORM checkin_web_count_view(v_code, 'embed', repeat('b', 64));
  PERFORM checkin_web_count_view(v_code, 'Bad Source!', repeat('c', 64));
  PERFORM checkin_web_count_view(v_code, 'direct', 'not-a-hash');
  INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, email, qr_token, source, is_test, reg_source, checked_in_at)
  VALUES (E, 'A', 'A', 'a@example.invalid', 'tok-125a', 'web', false, 'embed', now()),
         (E, 'B', 'B', 'b@example.invalid', 'tok-125b', 'web', false, NULL, NULL),
         (E, 'C', 'C', 'c@example.invalid', 'tok-125c', 'import', false, NULL, NULL);
  BEGIN
    INSERT INTO leod_checkin_attendees (event_id, first_name, last_name, qr_token, source, is_test, reg_source) VALUES (E, 'X', 'X', 'tok-125x', 'web', false, 'Not Valid');
    RAISE EXCEPTION 'bad source stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_res := checkin_registration_analytics(E);
  IF (v_res->>'visitors')::int <> 2 THEN RAISE EXCEPTION 'visitors: %', v_res->'visitors'; END IF;
  IF (v_res->'guests'->>'registered')::int <> 2 OR (v_res->'guests'->>'checked_in')::int <> 1 OR (v_res->'guests'->>'imported')::int <> 1 THEN RAISE EXCEPTION 'guests: %', v_res->'guests'; END IF;
  IF NOT v_res->'registrations_by_source' @> '[{"source":"embed","n":1},{"source":"direct","n":1}]' THEN RAISE EXCEPTION 'sources: %', v_res->'registrations_by_source'; END IF;
  IF NOT (SELECT bool_and(ok) FROM checkin_guard_results() WHERE guard IN ('checkin_rpcs_refuse_strangers', 'checkin_web_paths_private', 'public_tables_rls_on')) THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  RAISE EXCEPTION 'PROBE OK 125';
END;
$probe$;
