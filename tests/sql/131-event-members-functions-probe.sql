-- tests/sql/131-event-members-functions-probe.sql
-- Run after 131 (and again after 133). Expected: an error whose message
-- starts with 'PROBE OK 131'. Everything is rolled back by the final RAISE.
-- Before 130 is applied it fails with: relation "leod_event_members" does
-- not exist; after 130 and before 131 with PROBE FAIL 1 (rpc_apply_delay
-- still reads leod_users.invited_by, so the stage member is refused).
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();   -- creates v_ev
  v_stage  uuid := gen_random_uuid();   -- stage member of v_ev (global role director)
  v_av     uuid := gen_random_uuid();   -- av member of v_ev
  v_sign   uuid := gen_random_uuid();   -- signage member of v_ev
  v_off    uuid := gen_random_uuid();   -- stage member of v_ev, suspended
  v_legacy uuid := gen_random_uuid();   -- invited_by = v_owner, no membership
  v_other  uuid := gen_random_uuid();   -- creates v_ev2, has no members
  v_ev     uuid;
  v_ev2    uuid;
  v_s1     uuid;
  v_s2     uuid;
  v_disp   uuid;
  v_disp2  uuid;
  v_secret text;
  v_nonce  text := md5(random()::text) || md5(random()::text);
  v_res    text;
  v_ok     boolean;
  v_role   text;
  v_ids    uuid[];
  v_n      int;
  v_failed boolean;
  v_r      record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u;
  INSERT INTO leod_users (id, email, role, invited_by, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', CASE WHEN u = v_legacy THEN v_owner END, true
    FROM unnest(ARRAY[v_owner, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;
  INSERT INTO leod_subscriptions (director_id, plan, status) VALUES (v_owner, 'pro', 'active');

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 131', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 131 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_s1;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev2, 1, 'Probe other live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_s2;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'Probe TV') RETURNING id INTO v_disp;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev2, 'Probe other TV') RETURNING id INTO v_disp2;
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_ev, v_stage, 'stage',   true),
    (v_ev, v_av,    'av',      true),
    (v_ev, v_sign,  'signage', true),
    (v_ev, v_off,   'stage',   false);

  -- 1. rpc_apply_delay: the creator and the stage member delay, signed in or
  --    through the service role naming them; av, the suspended member, the
  --    invited_by link alone, a stranger and a member naming someone else
  --    are refused (42501)
  FOR v_r IN SELECT * FROM (VALUES
      (v_owner,  NULL::uuid, 'authenticated', true),
      (v_stage,  NULL::uuid, 'authenticated', true),
      (NULL,     v_stage,    'service_role',  true),
      (v_av,     NULL::uuid, 'authenticated', false),
      (v_off,    NULL::uuid, 'authenticated', false),
      (v_legacy, NULL::uuid, 'authenticated', false),
      (v_other,  NULL::uuid, 'authenticated', false),
      (NULL,     v_av,       'service_role',  false),
      (NULL,     v_legacy,   'service_role',  false),
      (v_stage,  v_owner,    'authenticated', false)) AS x(sub, op, role, allowed)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims',
                       (CASE WHEN v_r.sub IS NULL THEN json_build_object('role', v_r.role)
                             ELSE json_build_object('sub', v_r.sub, 'role', v_r.role) END)::text, true);
    BEGIN
      IF v_r.role = 'authenticated' THEN SET LOCAL ROLE authenticated; ELSE SET LOCAL ROLE service_role; END IF;
      PERFORM rpc_apply_delay(v_s1, 1, v_r.op, 'director');
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF v_failed = v_r.allowed THEN
      RAISE EXCEPTION 'PROBE FAIL 1: sub % op % as %: allowed % but refused %', v_r.sub, v_r.op, v_r.role, v_r.allowed, v_failed;
    END IF;
  END LOOP;
  v_failed := false;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM rpc_apply_delay(v_s2, 1, NULL, 'director');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 1: a member delayed another organiser''s session'; END IF;
  IF (SELECT cumulative_delay FROM leod_sessions WHERE id = v_s1) <> 3 THEN
    RAISE EXCEPTION 'PROBE FAIL 1: expected 3 minutes from the 3 allowed calls, got %',
      (SELECT cumulative_delay FROM leod_sessions WHERE id = v_s1);
  END IF;
  v_checks := v_checks + 1;

  -- 2. display_pair_link: director and signage link; av, the suspended
  --    member, the invited_by link alone and a stranger get 'forbidden';
  --    a member never links another organiser's display
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF display_pair_start('PRB732', v_nonce) IS DISTINCT FROM true
     OR display_pair_start('PRB733', v_nonce) IS DISTINCT FROM true
     OR display_pair_start('PRB734', v_nonce) IS DISTINCT FROM true THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 2: display_pair_start';
  END IF;
  RESET ROLE;
  FOR v_r IN SELECT * FROM (VALUES (v_av), (v_off), (v_legacy), (v_other)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_res := display_pair_link('PRB732', v_disp);
    RESET ROLE;
    IF v_res IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL 2: % got %', v_r.uid, v_res; END IF;
  END LOOP;
  IF (SELECT display_id FROM leod_signage_pairing WHERE code = 'PRB732') IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 2: a refused caller linked the code';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB732', v_disp);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'linked' THEN RAISE EXCEPTION 'PROBE FAIL 2: signage got %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB733', v_disp);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'linked' THEN RAISE EXCEPTION 'PROBE FAIL 2: the creator got %', v_res; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB734', v_disp2);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL 2: signage linked another organiser''s display: %', v_res; END IF;
  v_checks := v_checks + 1;

  -- 3. display_rotate_secret: director and signage rotate; everyone else
  --    gets false and the key does not change
  SELECT display_secret INTO v_secret FROM leod_signage_displays WHERE id = v_disp;
  FOR v_r IN SELECT * FROM (VALUES (v_av), (v_off), (v_legacy), (v_other), (v_stage)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := display_rotate_secret(v_disp);
    RESET ROLE;
    IF v_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'PROBE FAIL 3: % rotated the key', v_r.uid; END IF;
  END LOOP;
  IF (SELECT display_secret FROM leod_signage_displays WHERE id = v_disp) <> v_secret THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a refused rotate changed the key';
  END IF;
  FOR v_r IN SELECT * FROM (VALUES (v_sign), (v_owner)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_ok := display_rotate_secret(v_disp);
    RESET ROLE;
    IF v_ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'PROBE FAIL 3: % could not rotate', v_r.uid; END IF;
  END LOOP;
  IF (SELECT display_secret FROM leod_signage_displays WHERE id = v_disp) = v_secret THEN
    RAISE EXCEPTION 'PROBE FAIL 3: the key did not change';
  END IF;
  v_checks := v_checks + 1;

  -- 4. the log stamps the role on THIS event (Review Focus 1): the stage
  --    member's global role is director and the row says stage; a row with
  --    no event keeps the account's own role, as before
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_event_log (event_id, action, operator_id, operator_role) VALUES (v_ev, 'PROBE_131', v_stage, 'director');
  RESET ROLE;
  SELECT operator_role INTO v_role FROM leod_event_log WHERE event_id = v_ev AND action = 'PROBE_131';
  IF v_role IS DISTINCT FROM 'stage' THEN RAISE EXCEPTION 'PROBE FAIL 4: event row stamped %', v_role; END IF;
  SELECT operator_role INTO v_role FROM leod_event_log
   WHERE event_id = v_ev AND action = 'DELAY_APPLIED' AND operator_id = v_stage ORDER BY id DESC LIMIT 1;
  IF v_role IS DISTINCT FROM 'stage' THEN RAISE EXCEPTION 'PROBE FAIL 4: the delay by stage was stamped %', v_role; END IF;
  INSERT INTO leod_event_log (event_id, action, operator_id, operator_role) VALUES (NULL, 'PROBE_131_ACCOUNT', v_stage, 'stage');
  SELECT operator_role INTO v_role FROM leod_event_log WHERE action = 'PROBE_131_ACCOUNT' AND operator_id = v_stage;
  IF v_role IS DISTINCT FROM 'director' THEN RAISE EXCEPTION 'PROBE FAIL 4: account-level row stamped %', v_role; END IF;
  v_checks := v_checks + 1;

  -- 5. get_operators_with_last_seen (consoles before Release B): the creator
  --    sees themself and the event's members with their event roles, and
  --    nobody else; someone who directs no event is refused
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(o.id ORDER BY o.id) INTO v_ids FROM get_operators_with_last_seen() o;
  SELECT o.role INTO v_role FROM get_operators_with_last_seen() o WHERE o.id = v_stage;
  RESET ROLE;
  IF v_ids IS DISTINCT FROM (SELECT array_agg(u ORDER BY u) FROM unnest(ARRAY[v_owner, v_stage, v_av, v_sign, v_off]) u) THEN
    RAISE EXCEPTION 'PROBE FAIL 5: the creator sees %', v_ids;
  END IF;
  IF v_role IS DISTINCT FROM 'stage' THEN RAISE EXCEPTION 'PROBE FAIL 5: role shown %', v_role; END IF;
  FOR v_r IN SELECT * FROM (VALUES (v_stage), (v_legacy)) AS x(uid) LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM * FROM get_operators_with_last_seen();
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: % (directs no event) got the list', v_r.uid; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT array_agg(o.id) INTO v_ids FROM get_operators_with_last_seen() o;
  RESET ROLE;
  IF v_ids IS DISTINCT FROM ARRAY[v_other] THEN RAISE EXCEPTION 'PROBE FAIL 5: an organiser with no team sees %', v_ids; END IF;
  v_checks := v_checks + 1;

  -- 6. get_subscription_for_user: the caller's own plan only; a member never
  --    resolves to the owner's (spec §6)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM get_subscription_for_user();
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: a member got % subscription rows', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT plan INTO v_role FROM get_subscription_for_user();
  RESET ROLE;
  IF v_role IS DISTINCT FROM 'pro' THEN RAISE EXCEPTION 'PROBE FAIL 6: the owner got %', v_role; END IF;
  v_checks := v_checks + 1;

  -- 7. grants, and none of the six reads invited_by any more
  IF has_function_privilege('anon', 'public.rpc_apply_delay(uuid,integer,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.display_pair_link(text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.display_rotate_secret(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_operators_with_last_seen()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.get_subscription_for_user()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.rpc_apply_delay(uuid,integer,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_pair_link(text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_rotate_secret(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_operators_with_last_seen()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.get_subscription_for_user()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.validate_event_log_role()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 7: grants';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'public'
                AND p.proname IN ('rpc_apply_delay', 'display_pair_link', 'display_rotate_secret', 'validate_event_log_role',
                                  'get_operators_with_last_seen', 'get_subscription_for_user')
                AND p.prosrc LIKE '%invited_by%') THEN
    RAISE EXCEPTION 'PROBE FAIL 7: a rewritten function still reads invited_by';
  END IF;
  v_checks := v_checks + 1;

  -- 8. guards that must stay green
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 8: guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                FROM checkin_guard_results()
                                               WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                               'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 131: % checks passed (rolled back)', v_checks;
END
$probe$;
