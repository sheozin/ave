-- tests/sql/111-badge-design-probe.sql. Ends in 'PROBE OK 111'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
  v_res jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_badge_design(E, '{"w":100,"h":70}'); RAISE EXCEPTION 'stranger saved'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  -- Unknown keys are dropped, values are checked.
  v_res := checkin_set_badge_design(E, '{"w":148,"h":105,"band":true,"qr":true,"name":"split","align":"left","company":false,"evil":"<script>","colors":{"VIP":"#c9a227"}}');
  IF v_res ? 'evil' OR (v_res->>'w')::int <> 148 OR v_res->>'name' <> 'split' OR (v_res->>'company')::boolean OR v_res->'colors'->>'VIP' <> '#C9A227' THEN RAISE EXCEPTION 'normalized: %', v_res; END IF;
  IF (SELECT badge_design FROM leod_checkin_entitlements WHERE event_id = E) <> v_res THEN RAISE EXCEPTION 'not stored'; END IF;
  BEGIN PERFORM checkin_set_badge_design(E, '{"w":20,"h":70}'); RAISE EXCEPTION 'tiny accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_set_badge_design(E, '{"w":100,"h":70,"colors":{"VIP":"red;}body{"}}'); RAISE EXCEPTION 'bad colour accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  -- NULL goes back to the default badge.
  v_res := checkin_set_badge_design(E, NULL);
  IF v_res IS NOT NULL OR (SELECT badge_design FROM leod_checkin_entitlements WHERE event_id = E) IS NOT NULL THEN RAISE EXCEPTION 'reset: % / %', v_res, (SELECT badge_design FROM leod_checkin_entitlements WHERE event_id = E); END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers') THEN RAISE EXCEPTION 'G10'; END IF;
  RAISE EXCEPTION 'PROBE OK 111';
END;
$probe$;
