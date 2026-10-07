-- tests/sql/122-page-language-probe.sql. Ends in 'PROBE OK 122'.
DO $probe$
DECLARE
  E CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_registration_language(E, 'pl'); RAISE EXCEPTION 'stranger'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_registration_language(E, 'xx'); RAISE EXCEPTION 'xx accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  IF checkin_set_registration_language(E, 'ar') <> 'ar' THEN RAISE EXCEPTION 'set'; END IF;
  IF (SELECT registration_language FROM leod_checkin_entitlements WHERE event_id = E) <> 'ar' THEN RAISE EXCEPTION 'stored'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers') THEN RAISE EXCEPTION 'G10'; END IF;
  RAISE EXCEPTION 'PROBE OK 122';
END;
$probe$;
