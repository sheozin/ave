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

  -- Registration itself moved to checkin_web_request / checkin_web_confirm in
  -- 101; see tests/sql/101-registration-probe.sql.

  RAISE EXCEPTION 'PROBE OK 100';
END;
$probe$;
