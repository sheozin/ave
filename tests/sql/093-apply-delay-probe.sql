-- tests/sql/093-apply-delay-probe.sql
-- Run after 093. Expected: an error whose message starts with 'PROBE OK 093'.
-- Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner   uuid := gen_random_uuid();
  v_stage   uuid := gen_random_uuid();   -- stage operator invited by v_owner
  v_av      uuid := gen_random_uuid();   -- av operator invited by v_owner
  v_dead    uuid := gen_random_uuid();   -- director invited by v_owner, deactivated
  v_other   uuid := gen_random_uuid();   -- unrelated account
  v_ev      uuid;
  v_s1 uuid; v_s2 uuid; v_s3 uuid; v_s4 uuid; v_s5 uuid; v_s6 uuid;
  v_res     jsonb;
  v_r       record;
  v_n       int;
  v_failed  boolean;
  v_checks  int := 0;
  v_sig     text := 'public.rpc_apply_delay(uuid, integer, uuid, text)';
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_stage, v_av, v_dead, v_other]) AS u;
  -- on live, the auth.users trigger has already created the rows
  INSERT INTO leod_users (id, email, role, invited_by, active) VALUES
    (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'director', NULL,    true),
    (v_stage, 'probe-' || v_stage || '@cuedeck-test.io', 'stage',    v_owner, true),
    (v_av,    'probe-' || v_av    || '@cuedeck-test.io', 'av',       v_owner, true),
    (v_dead,  'probe-' || v_dead  || '@cuedeck-test.io', 'director', v_owner, false),
    (v_other, 'probe-' || v_other || '@cuedeck-test.io', 'director', NULL,    true)
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 093', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;

  -- Running order:
  --   1 Opening   ENDED                    (before the target: untouched)
  --   2 Keynote   LIVE      target
  --   3 Panel     CANCELLED anchor         (skipped, does not stop the walk)
  --   4 Break     PLANNED                  (shifted)
  --   5 Lunch     READY     anchor         (stops the walk, not shifted)
  --   6 Closing   PLANNED                  (after the anchor: untouched)
  INSERT INTO leod_sessions (event_id, sort_order, title, status, is_anchor,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Opening', 'ENDED',     false, '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_s1;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, is_anchor,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 2, 'Keynote', 'LIVE',      false, '09:30', '10:30', '09:30', '10:30') RETURNING id INTO v_s2;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, is_anchor,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 3, 'Panel',   'CANCELLED', true,  '10:30', '11:00', '10:30', '11:00') RETURNING id INTO v_s3;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, is_anchor,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 4, 'Break',   'PLANNED',   false, '11:00', '11:15', '11:00', '11:15') RETURNING id INTO v_s4;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, is_anchor,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 5, 'Lunch',   'READY',     true,  '12:00', '13:00', '12:00', '13:00') RETURNING id INTO v_s5;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, is_anchor,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 6, 'Closing', 'PLANNED',   false, '13:00', '13:30', '13:00', '13:30') RETURNING id INTO v_s6;

  -- 1. grants: anon cannot execute, PUBLIC has no entry; authenticated and service_role can
  IF has_function_privilege('anon', v_sig, 'EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode((SELECT coalesce(proacl, acldefault('f', proowner))
                                            FROM pg_proc WHERE oid = v_sig::regprocedure)) a
                 WHERE a.grantee = 0)
     OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('service_role', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 1: grants';
  END IF;
  v_failed := false;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM rpc_apply_delay(v_s2, 5, v_owner, NULL);
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 1: anon executed it'; END IF;
  v_checks := v_checks + 1;

  -- 2. refused callers change nothing: unrelated user, deactivated
  --    director, av, a stage user naming the owner as p_operator_id, and
  --    the service role acting for an unrelated user
  FOR v_r IN SELECT * FROM (VALUES
      (v_other, NULL::uuid, 'authenticated', 'unrelated'),
      (v_dead,  NULL::uuid, 'authenticated', 'deactivated'),
      (v_av,    NULL::uuid, 'authenticated', 'av'),
      (v_other, v_owner,    'authenticated', 'unrelated naming the owner'),
      (NULL,    v_other,    'service_role',  'service role for unrelated'),
      (NULL,    v_dead,     'service_role',  'service role for deactivated')) AS x(sub, op, role, label)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims',
                       (CASE WHEN v_r.sub IS NULL THEN json_build_object('role', v_r.role)
                             ELSE json_build_object('sub', v_r.sub, 'role', v_r.role) END)::text, true);
    BEGIN
      IF v_r.role = 'authenticated' THEN SET LOCAL ROLE authenticated; ELSE SET LOCAL ROLE service_role; END IF;
      PERFORM rpc_apply_delay(v_s2, 5, v_r.op, 'director');
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 2: % was allowed', v_r.label; END IF;
  END LOOP;
  -- an authenticated JWT without a user id cannot borrow p_operator_id
  v_failed := false;
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM rpc_apply_delay(v_s2, 5, v_owner, 'director');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 2: no uid borrowed the owner'; END IF;
  IF EXISTS (SELECT 1 FROM leod_sessions WHERE event_id = v_ev AND (version <> 1 OR cumulative_delay <> 0))
     OR EXISTS (SELECT 1 FROM leod_event_log WHERE event_id = v_ev) THEN
    RAISE EXCEPTION 'PROBE FAIL 2: a refused call changed something';
  END IF;
  v_checks := v_checks + 1;

  -- 3. the stage operator delays the Keynote by 10: cascade, anchors, versions
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := rpc_apply_delay(v_s2, 10, NULL, 'stage');
  RESET ROLE;
  IF v_res IS DISTINCT FROM jsonb_build_object('ok', true, 'affected', 2, 'minutes', 10) THEN
    RAISE EXCEPTION 'PROBE FAIL 3: returned %', v_res;
  END IF;
  -- shifted: Keynote (target) and Break
  IF NOT EXISTS (SELECT 1 FROM leod_sessions WHERE id = v_s2 AND scheduled_start = '09:40' AND scheduled_end = '10:40'
                   AND delay_minutes = 10 AND cumulative_delay = 10 AND version = 2)
     OR NOT EXISTS (SELECT 1 FROM leod_sessions WHERE id = v_s4 AND scheduled_start = '11:10' AND scheduled_end = '11:25'
                   AND delay_minutes = 0 AND cumulative_delay = 10 AND version = 2) THEN
    RAISE EXCEPTION 'PROBE FAIL 3: target or follower not shifted correctly';
  END IF;
  -- untouched: ENDED before, CANCELLED anchor in the walk, the live anchor, after it
  SELECT count(*) INTO v_n FROM leod_sessions
   WHERE id IN (v_s1, v_s3, v_s5, v_s6)
     AND version = 1 AND cumulative_delay = 0 AND delay_minutes = 0
     AND scheduled_start = planned_start AND scheduled_end = planned_end;
  IF v_n <> 4 THEN RAISE EXCEPTION 'PROBE FAIL 3: % of 4 sessions untouched', v_n; END IF;
  v_checks := v_checks + 1;

  -- 4. one event log row, with the real caller and role
  SELECT count(*) INTO v_n FROM leod_event_log
   WHERE event_id = v_ev AND session_id = v_s2 AND action = 'DELAY_APPLIED'
     AND operator_id = v_stage AND operator_role = 'stage'
     AND payload->>'minutes' = '10' AND payload->>'affected' = '2'
     AND payload->'session_ids' = jsonb_build_array(v_s2, v_s4)
     AND payload->>'stopped_at_anchor' = v_s5::text;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 4: % matching log rows', v_n; END IF;
  v_checks := v_checks + 1;

  -- 5. the Edge Function path: service role acting for the owner; delaying
  --    the anchor itself shifts it and walks on to the end
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
  SET LOCAL ROLE service_role;
  v_res := rpc_apply_delay(v_s5, 5, v_owner, 'director');
  RESET ROLE;
  IF (v_res->>'affected')::int <> 2
     OR NOT EXISTS (SELECT 1 FROM leod_sessions WHERE id = v_s5 AND scheduled_start = '12:05'
                      AND delay_minutes = 5 AND cumulative_delay = 5 AND version = 2)
     OR NOT EXISTS (SELECT 1 FROM leod_sessions WHERE id = v_s6 AND scheduled_start = '13:05'
                      AND delay_minutes = 0 AND cumulative_delay = 5 AND version = 2)
     OR NOT EXISTS (SELECT 1 FROM leod_event_log WHERE event_id = v_ev AND session_id = v_s5
                      AND operator_id = v_owner AND action = 'DELAY_APPLIED') THEN
    RAISE EXCEPTION 'PROBE FAIL 5: service-role delay for the owner: %', v_res;
  END IF;
  v_checks := v_checks + 1;

  -- 6. bad minutes are refused
  v_failed := false;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM rpc_apply_delay(v_s2, 0, NULL, NULL);
  EXCEPTION WHEN invalid_parameter_value THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 6: 0 minutes accepted'; END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 093: % checks passed', v_checks;
END
$probe$;
