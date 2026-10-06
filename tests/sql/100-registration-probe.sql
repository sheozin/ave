-- tests/sql/100-registration-probe.sql
-- Probe for migration 100 (public registration page). Runs against the
-- linked project and ends in RAISE EXCEPTION 'PROBE OK 100', so nothing it
-- writes survives. Run after the migration, or prepend the migration file to
-- dry-run it:  cat supabase/migrations/100_*.sql tests/sql/100-*.sql > /tmp/x.sql
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_cfg  jsonb;
  v_code text;
  v_res  jsonb;
  v_n    int;
  v_ok   boolean;
  k      int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;

  -- 1. A stranger is refused by both organizer RPCs.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM checkin_set_registration(E, true, NULL, NULL, '[]');
    RAISE EXCEPTION 'stranger was allowed to set registration';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM checkin_new_registration_code(E);
    RAISE EXCEPTION 'stranger was allowed a new code';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- 2. The owner turns it on with two questions and gets a code.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_cfg := checkin_set_registration(E, true, NULL, NULL,
    '[{"id":"diet","label":"  Dietary needs ","type":"text","required":false},
      {"id":"track","label":"Track","type":"choice","required":true,"options":[" Tech ","Business"]}]');
  v_code := v_cfg->>'code';
  IF v_code !~ '^[A-HJ-NP-Z2-9]{10}$' THEN RAISE EXCEPTION 'bad code %', v_code; END IF;
  IF v_cfg #>> '{questions,0,label}' <> 'Dietary needs' OR v_cfg #>> '{questions,1,options,0}' <> 'Tech' THEN
    RAISE EXCEPTION 'questions not normalised: %', v_cfg->'questions';
  END IF;

  -- 3. Invalid question sets are refused.
  FOREACH v_res IN ARRAY ARRAY[
    '[{"id":"A B","label":"x","type":"text","required":true}]'::jsonb,
    '[{"id":"a","label":"","type":"text","required":true}]',
    '[{"id":"a","label":"x","type":"date","required":true}]',
    '[{"id":"a","label":"x","type":"choice","required":true,"options":[]}]',
    '[{"id":"a","label":"x","type":"text","required":true},{"id":"a","label":"y","type":"text","required":true}]',
    '[{"id":"a","label":"x","type":"text"}]',
    '[1,2,3,4,5,6]'] LOOP
    BEGIN
      PERFORM checkin_set_registration(E, true, NULL, NULL, v_res);
      RAISE EXCEPTION 'accepted bad questions %', v_res;
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;

  -- Turning off and on keeps the same link; a new code replaces it.
  PERFORM checkin_set_registration(E, false, NULL, NULL, v_cfg->'questions');
  IF (checkin_set_registration(E, true, NULL, NULL, v_cfg->'questions'))->>'code' <> v_code THEN
    RAISE EXCEPTION 'code changed on re-enable';
  END IF;
  IF checkin_new_registration_code(E) = v_code THEN RAISE EXCEPTION 'new code equals old'; END IF;
  SELECT registration_code INTO v_code FROM leod_checkin_entitlements WHERE event_id = E;

  -- 4. Registration (service path: no JWT claims).
  PERFORM set_config('request.jwt.claims', '', true);
  v_res := checkin_web_register('ZZZZZZZZZZ', 'A', 'B', 'probe@example.invalid', NULL, '{}');
  IF v_res->>'status' <> 'not_found' THEN RAISE EXCEPTION 'unknown code: %', v_res; END IF;

  v_res := checkin_web_register(v_code, ' Probe ', ' Guest ', ' Probe.Guest@Example.invalid ', ' ', '{"diet":"none"}');
  IF v_res->>'status' <> 'registered' OR (v_res->>'test')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'register: %', v_res; END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_attendees
   WHERE id = (v_res #>> '{attendee,id}')::uuid AND source = 'web' AND is_test AND consent_at IS NOT NULL
     AND first_name = 'Probe' AND company IS NULL AND custom_fields->>'diet' = 'none';
  IF v_n <> 1 THEN RAISE EXCEPTION 'stored row wrong'; END IF;

  v_res := checkin_web_register(v_code, 'Someone', 'Else', 'probe.guest@example.INVALID', NULL, '{}');
  IF v_res->>'status' <> 'duplicate' OR v_res #>> '{attendee,first_name}' <> 'Probe' THEN RAISE EXCEPTION 'duplicate: %', v_res; END IF;

  -- Capacity: set it to the current count, a new address is refused, the returning one is not.
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND is_test;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, v_n, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_register(v_code, 'New', 'Person', 'new.person@example.invalid', NULL, '{}')->>'status' <> 'full' THEN
    RAISE EXCEPTION 'capacity not enforced';
  END IF;
  IF checkin_web_register(v_code, 'Probe', 'Guest', 'probe.guest@example.invalid', NULL, '{}')->>'status' <> 'duplicate' THEN
    RAISE EXCEPTION 'returning guest blocked by capacity';
  END IF;

  -- Closed by the organizer's time.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, NULL, now() - interval '1 minute', '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_register(v_code, 'Late', 'Comer', 'late@example.invalid', NULL, '{}')->>'status' <> 'closed' THEN
    RAISE EXCEPTION 'closing time not enforced';
  END IF;

  -- Disabled means not found.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, false, NULL, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  IF checkin_web_register(v_code, 'Off', 'Line', 'off@example.invalid', NULL, '{}')->>'status' <> 'not_found' THEN
    RAISE EXCEPTION 'disabled page still registers';
  END IF;

  -- Test cap: 25 test web registrations.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration(E, true, NULL, NULL, '[]');
  PERFORM set_config('request.jwt.claims', '', true);
  FOR k IN 1..30 LOOP
    v_res := checkin_web_register(v_code, 'Cap', 'Test' || k, 'cap' || k || '@example.invalid', NULL, '{}');
    EXIT WHEN v_res->>'status' <> 'registered';
  END LOOP;
  IF v_res->>'status' <> 'test_cap' THEN RAISE EXCEPTION 'test cap: %', v_res; END IF;
  SELECT count(*) INTO v_n FROM leod_checkin_attendees WHERE event_id = E AND is_test AND source = 'web';
  IF v_n <> 25 THEN RAISE EXCEPTION 'test web rows %', v_n; END IF;

  -- 5. Rate limit: 5 per IP per 10 minutes; a short hash is refused.
  FOR k IN 1..5 LOOP
    IF NOT checkin_web_rate_check(E, repeat('a', 64)) THEN RAISE EXCEPTION 'rate refused early at %', k; END IF;
  END LOOP;
  IF checkin_web_rate_check(E, repeat('a', 64)) THEN RAISE EXCEPTION 'rate limit not enforced'; END IF;
  IF NOT checkin_web_rate_check(E, repeat('b', 64)) THEN RAISE EXCEPTION 'other IP blocked'; END IF;
  IF checkin_web_rate_check(E, 'short') THEN RAISE EXCEPTION 'short hash accepted'; END IF;

  -- 6. Grants: the public paths are service-role only.
  IF has_function_privilege('authenticated', 'checkin_web_register(text,text,text,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'checkin_web_register(text,text,text,text,text,jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'checkin_web_rate_check(uuid,text)', 'EXECUTE')
     OR has_table_privilege('anon', 'leod_checkin_web_attempts', 'SELECT') THEN
    RAISE EXCEPTION 'public path exposed';
  END IF;

  -- 7. Dashboard counts web registrations.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  IF (checkin_event_stats(E) #>> '{by_source,web}')::int < 25 THEN RAISE EXCEPTION 'stats web: %', checkin_event_stats(E)->'by_source'; END IF;

  -- 8. Guard G10 still passes with the new organizer RPCs in scope.
  SELECT ok INTO v_ok FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers';
  IF v_ok IS NOT TRUE THEN RAISE EXCEPTION 'G10 failed: %', (SELECT detail FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers'); END IF;

  RAISE EXCEPTION 'PROBE OK 100';
END;
$probe$;
