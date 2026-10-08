-- tests/sql/128-white-label-probe.sql. Ends in 'PROBE OK 128'.
DO $probe$
DECLARE
  E CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  IF (SELECT white_label FROM leod_checkin_entitlements WHERE event_id = E) THEN RAISE EXCEPTION 'default on'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_white_label(E, true); RAISE EXCEPTION 'stranger'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_white_label(E, NULL); RAISE EXCEPTION 'null accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  IF checkin_set_white_label(E, true) IS NOT TRUE THEN RAISE EXCEPTION 'set'; END IF;
  IF NOT (SELECT white_label FROM leod_checkin_entitlements WHERE event_id = E) THEN RAISE EXCEPTION 'stored'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers') THEN RAISE EXCEPTION 'G10'; END IF;
  RAISE EXCEPTION 'PROBE OK 128';
END;
$probe$;
