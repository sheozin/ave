-- tests/sql/147-badge-divider-probe.sql. Ends in 'PROBE OK 147'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid; v_res jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_res := checkin_set_badge_design(E, '{"template":"visa-next-full","divider":false}');
  IF (v_res->>'divider')::boolean OR v_res->>'template' <> 'visa-next-full' THEN RAISE EXCEPTION 'off: %', v_res; END IF;
  v_res := checkin_set_badge_design(E, '{"template":"visa-next-full"}');
  IF NOT (v_res->>'divider')::boolean THEN RAISE EXCEPTION 'default: %', v_res; END IF;
  v_res := checkin_set_badge_design(E, '{"template":"visa-next-full","divider":"no"}');
  IF NOT (v_res->>'divider')::boolean THEN RAISE EXCEPTION 'junk is not false: %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE EXCEPTION 'PROBE OK 147';
END;
$probe$;
