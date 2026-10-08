-- tests/sql/133-event-teams-server-probe.sql
-- Run after 133. Expected: an error whose message starts with
-- 'PROBE OK 133'. Everything is rolled back by the final RAISE.
-- Before 133 it fails with: function cuedeck_plan_seats(uuid) does not exist.
DO $probe$
DECLARE
  v_pro      uuid := gen_random_uuid();   -- organiser on Pro, company Northwind Events
  v_start    uuid := gen_random_uuid();   -- organiser on Starter, organization Atlas Live
  v_trial    uuid := gen_random_uuid();   -- organiser on a running trial
  v_ended    uuid := gen_random_uuid();   -- organiser whose trial ended
  v_none     uuid := gen_random_uuid();   -- organiser with no subscription row
  v_canc     uuid := gen_random_uuid();   -- organiser on a canceled Pro
  v_stranger uuid := gen_random_uuid();   -- on no event
  v_p        uuid[] := ARRAY(SELECT gen_random_uuid() FROM generate_series(1, 8));
  v_epro uuid; v_estart uuid; v_etrial uuid; v_eended uuid; v_enone uuid; v_ecanc uuid;
  v_res    jsonb;
  v_n      int;
  v_state  text;
  v_msg    text;
  v_failed boolean;
  v_r      record;
  v_i      int;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(v_p || ARRAY[v_pro, v_start, v_trial, v_ended, v_none, v_canc, v_stranger]) AS u;
  INSERT INTO leod_users (id, email, role, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', true
    FROM unnest(v_p || ARRAY[v_pro, v_start, v_trial, v_ended, v_none, v_canc, v_stranger]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;
  UPDATE leod_users SET company_name = 'Northwind Events' WHERE id = v_pro;
  UPDATE leod_users SET company_name = '', organization = 'Atlas Live' WHERE id = v_start;
  UPDATE leod_users SET company_name = NULL, organization = NULL, name = NULL WHERE id = v_trial;
  INSERT INTO leod_subscriptions (director_id, plan, status, trial_ends_at) VALUES
    (v_pro,   'pro',     'active',   NULL),
    (v_start, 'starter', 'active',   NULL),
    (v_trial, 'trial',   'active',   now() + interval '2 days'),
    (v_ended, 'trial',   'active',   now() - interval '1 hour'),
    (v_canc,  'pro',     'canceled', NULL);
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 pro', current_date + 30, '09:00', '18:00', v_pro) RETURNING id INTO v_epro;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 starter', current_date + 30, '09:00', '18:00', v_start) RETURNING id INTO v_estart;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 trial', current_date + 30, '09:00', '18:00', v_trial) RETURNING id INTO v_etrial;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 ended', current_date + 30, '09:00', '18:00', v_ended) RETURNING id INTO v_eended;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 none', current_date + 30, '09:00', '18:00', v_none) RETURNING id INTO v_enone;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by) VALUES ('Probe 133 canceled', current_date + 30, '09:00', '18:00', v_canc) RETURNING id INTO v_ecanc;

  -- 1. seats per event from the owner's plan
  FOR v_r IN SELECT * FROM (VALUES (v_pro, 20), (v_start, 5), (v_trial, NULL), (v_ended, 0), (v_none, NULL), (v_canc, 0)) AS x(owner, expected) LOOP
    IF cuedeck_plan_seats(v_r.owner) IS DISTINCT FROM v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 1: % seats %, expected %', v_r.owner, cuedeck_plan_seats(v_r.owner), v_r.expected;
    END IF;
  END LOOP;
  -- (an unknown plan name cannot be stored: leod_subscriptions_plan_check
  -- allows only trial, perevent, starter, pro and enterprise; the function's
  -- ELSE 0 is a fallback for a future plan added without a seat number)
  v_checks := v_checks + 1;

  -- 2. the membership insert enforces seats: Starter takes 5, the sixth is
  --    refused with seats_full; a suspended member still holds a seat
  FOR v_i IN 1..5 LOOP
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_estart, v_p[v_i], 'av');
  END LOOP;
  v_state := NULL;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_estart, v_p[6], 'av');
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE; v_msg := SQLERRM;
  END;
  IF v_state IS DISTINCT FROM '23514' OR v_msg NOT LIKE 'seats_full%' THEN
    RAISE EXCEPTION 'PROBE FAIL 2: a sixth member on Starter gave % %', coalesce(v_state, 'no error'), v_msg;
  END IF;
  IF cuedeck_event_seats_of(v_estart) IS DISTINCT FROM '{"used": 5, "limit": 5}'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL 2: seats_of %', cuedeck_event_seats_of(v_estart);
  END IF;
  UPDATE leod_event_members SET active = false WHERE event_id = v_estart AND user_id = v_p[1];
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_estart, v_p[6], 'av');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 2: a suspended member freed a seat'; END IF;
  v_checks := v_checks + 1;

  -- 3. a downgrade keeps everyone (Review Focus 5): Pro with 7 members goes
  --    to Starter; nobody loses access, role changes and suspend/reactivate
  --    still work, new members are refused until the plan fits again
  INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[1], 'stage');
  FOR v_i IN 2..7 LOOP
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[v_i], 'av');
  END LOOP;
  UPDATE leod_subscriptions SET plan = 'starter' WHERE director_id = v_pro;
  IF cuedeck_event_seats_of(v_epro) IS DISTINCT FROM '{"used": 7, "limit": 5}'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL 3: seats_of after the downgrade %', cuedeck_event_seats_of(v_epro);
  END IF;
  FOR v_i IN 1..7 LOOP
    IF cuedeck_event_role_of(v_epro, v_p[v_i]) IS NULL THEN RAISE EXCEPTION 'PROBE FAIL 3: member % lost access', v_i; END IF;
  END LOOP;
  UPDATE leod_event_members SET role = 'director' WHERE event_id = v_epro AND user_id = v_p[2];
  UPDATE leod_event_members SET active = false WHERE event_id = v_epro AND user_id = v_p[3];
  UPDATE leod_event_members SET active = true WHERE event_id = v_epro AND user_id = v_p[3];
  IF cuedeck_event_role_of(v_epro, v_p[2]) IS DISTINCT FROM 'director' OR cuedeck_event_role_of(v_epro, v_p[3]) IS DISTINCT FROM 'av' THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a change on an over-full team did not apply';
  END IF;
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[8], 'av');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: a new member joined an over-full team'; END IF;
  UPDATE leod_subscriptions SET plan = 'pro' WHERE director_id = v_pro;
  INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_epro, v_p[8], 'av');
  v_checks := v_checks + 1;

  -- 4. ended plans seat nobody new; no subscription row and a running trial
  --    have no limit
  FOR v_r IN SELECT * FROM (VALUES (v_ecanc, false), (v_eended, false), (v_enone, true), (v_etrial, true)) AS x(ev, allowed) LOOP
    v_failed := false;
    BEGIN
      INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_r.ev, v_p[1], 'director');
    EXCEPTION WHEN check_violation THEN v_failed := true;
    END;
    IF v_failed = v_r.allowed THEN RAISE EXCEPTION 'PROBE FAIL 4: event % allowed % refused %', v_r.ev, v_r.allowed, v_failed; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 5. two invites into the last seat wait for each other (Review Focus 3):
  --    the guard takes a per-event advisory lock before counting, and still
  --    refuses the creator as a member
  IF position('pg_advisory_xact_lock' IN pg_get_functiondef('public.leod_event_members_guard()'::regprocedure)) = 0
     OR position('owner_not_member' IN pg_get_functiondef('public.leod_event_members_guard()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 5: the membership guard lost its lock or its creator check';
  END IF;
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_enone, v_none, 'stage');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: the creator was stored as a member'; END IF;
  v_checks := v_checks + 1;

  -- 6. cuedeck_my_events: every event the caller created or is an active
  --    member of, with the role, the organiser and the organiser's plan
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[1], 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM cuedeck_my_events();
  SELECT to_jsonb(x) INTO v_res FROM cuedeck_my_events() x WHERE x.event_id = v_epro;
  RESET ROLE;
  -- v_p[1]: stage on pro, director on trial and none, suspended on starter (not listed)
  IF v_n <> 3 THEN RAISE EXCEPTION 'PROBE FAIL 6: member sees % events, expected 3', v_n; END IF;
  IF v_res->>'role' IS DISTINCT FROM 'stage' OR (v_res->>'is_owner')::boolean IS DISTINCT FROM false
     OR (v_res->>'owner_id')::uuid IS DISTINCT FROM v_pro OR v_res->>'organiser' IS DISTINCT FROM 'Northwind Events'
     OR v_res->>'plan' IS DISTINCT FROM 'pro' OR v_res->>'plan_status' IS DISTINCT FROM 'active' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: member row %', v_res;
  END IF;
  SET LOCAL ROLE authenticated;
  SELECT to_jsonb(x) INTO v_res FROM cuedeck_my_events() x WHERE x.event_id = v_etrial;
  RESET ROLE;
  IF v_res->>'organiser' IS NOT NULL OR v_res->>'role' IS DISTINCT FROM 'director' OR v_res->>'plan' IS DISTINCT FROM 'trial' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: an organiser with no names shows %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_start, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT to_jsonb(x) INTO v_res FROM cuedeck_my_events() x;
  RESET ROLE;
  IF v_res->>'role' IS DISTINCT FROM 'director' OR (v_res->>'is_owner')::boolean IS DISTINCT FROM true
     OR v_res->>'organiser' IS DISTINCT FROM 'Atlas Live' OR v_res->>'plan' IS DISTINCT FROM 'starter' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: own event row %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stranger, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM cuedeck_my_events();
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: a stranger sees % events', v_n; END IF;
  v_checks := v_checks + 1;

  -- 7. cuedeck_event_team: the event's directors see the team and the seats;
  --    anyone else is refused with 42501
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_pro, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := cuedeck_event_team(v_epro);
  RESET ROLE;
  IF (v_res->>'is_owner')::boolean IS DISTINCT FROM true
     OR v_res->'seats' IS DISTINCT FROM '{"used": 8, "limit": 20}'::jsonb
     OR (v_res->'owner'->>'user_id')::uuid IS DISTINCT FROM v_pro
     OR jsonb_array_length(v_res->'members') <> 8
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_res->'members'->0) k)
        <> ARRAY['active', 'added_at', 'email', 'last_sign_in_at', 'name', 'role', 'user_id']
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_res) k) <> ARRAY['is_owner', 'members', 'owner', 'seats'] THEN
    RAISE EXCEPTION 'PROBE FAIL 7: the creator got %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[2], 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := cuedeck_event_team(v_epro);
  RESET ROLE;
  IF (v_res->>'is_owner')::boolean IS DISTINCT FROM false OR jsonb_array_length(v_res->'members') <> 8 THEN
    RAISE EXCEPTION 'PROBE FAIL 7: an invited director got %', v_res;
  END IF;
  FOR v_r IN SELECT * FROM (VALUES (v_p[1], v_epro), (v_stranger, v_epro), (v_p[1], v_estart), (v_pro, v_estart)) AS x(uid, ev) LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM cuedeck_event_team(v_r.ev);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 7: % read the team of %', v_r.uid, v_r.ev; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 8. first login: no founder welcome for a members-only account; an
  --    organiser gets it; the id must be the caller's own
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[4], 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := handle_first_login(v_p[4]);
  RESET ROLE;
  IF v_res IS DISTINCT FROM '{"first_login": true, "welcome_email_queued": false}'::jsonb
     OR EXISTS (SELECT 1 FROM welcome_email_trigger WHERE user_id = v_p[4])
     OR (SELECT first_login_at FROM leod_users WHERE id = v_p[4]) IS NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 8: members-only first login gave %', v_res;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_none, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := handle_first_login(v_none);
  RESET ROLE;
  IF v_res IS DISTINCT FROM '{"first_login": true, "welcome_email_queued": true}'::jsonb
     OR NOT EXISTS (SELECT 1 FROM welcome_email_trigger WHERE user_id = v_none) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: an organiser''s first login gave %', v_res;
  END IF;
  FOR v_r IN SELECT * FROM (VALUES (json_build_object('sub', v_p[5], 'role', 'authenticated')::text),
                                   ('{"role":"authenticated"}')) AS x(claims) LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', v_r.claims, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM handle_first_login(v_pro);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 8: handle_first_login ran for someone else (%)', v_r.claims; END IF;
  END LOOP;
  IF (SELECT first_login_at FROM leod_users WHERE id = v_pro) IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 8: the refused calls touched the organiser';
  END IF;
  v_checks := v_checks + 1;

  -- 9. grants
  IF has_function_privilege('anon', 'public.cuedeck_plan_seats(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_plan_seats(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_event_seats_of(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_event_seats_of(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cuedeck_event_seats_of(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_my_events()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cuedeck_my_events()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_event_team(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cuedeck_event_team(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.handle_first_login(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.handle_first_login(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 9: grants';
  END IF;
  v_checks := v_checks + 1;

  -- 10. guards: checkin_rpcs_refuse_strangers now also calls
  --     cuedeck_event_team as a stranger and must see 42501
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 10: check-in guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                          FROM checkin_guard_results()
                                                         WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                                         'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  IF EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE NOT ok) THEN
    RAISE EXCEPTION 'PROBE FAIL 10: %', (SELECT string_agg(guard || ': ' || detail, '; ') FROM cuedeck_guard_results() WHERE NOT ok);
  END IF;
  v_checks := v_checks + 1;

  -- 11. direct client log inserts carry the caller as operator (security
  --     review, fix 2): a member's insert with no operator or someone else's
  --     is refused by event_log_member_insert; with their own id it is
  --     accepted and stamped with their role on this event (stage, though
  --     their account's global role is director). SECURITY DEFINER writers
  --     (owner postgres, RLS not forced) are not subject to the policy.
  FOR v_r IN SELECT * FROM (VALUES (NULL::uuid), (v_pro)) AS x(op) LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[1], 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      INSERT INTO leod_event_log (event_id, action, operator_id, operator_role) VALUES (v_epro, 'PROBE_133_FORGED', v_r.op, 'director');
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 11: a member logged as operator %', coalesce(v_r.op::text, 'NULL'); END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_p[1], 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_event_log (event_id, action, operator_id, operator_role) VALUES (v_epro, 'PROBE_133_OWN', v_p[1], 'director');
  RESET ROLE;
  IF (SELECT operator_role FROM leod_event_log WHERE event_id = v_epro AND action = 'PROBE_133_OWN' AND operator_id = v_p[1]) IS DISTINCT FROM 'stage' THEN
    RAISE EXCEPTION 'PROBE FAIL 11: own log row stamped %',
      (SELECT operator_role FROM leod_event_log WHERE event_id = v_epro AND action = 'PROBE_133_OWN');
  END IF;
  IF EXISTS (SELECT 1 FROM leod_event_log WHERE action = 'PROBE_133_FORGED') THEN
    RAISE EXCEPTION 'PROBE FAIL 11: a forged row was stored';
  END IF;
  v_checks := v_checks + 1;

  -- 12. the invite rate-limit count (invite-operator: MEMBER_INVITED rows of
  --     one event owner in the last 24 h) has its partial index
  IF NOT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE schemaname = 'public' AND tablename = 'leod_event_log'
                    AND indexname = 'idx_log_member_invited'
                    AND indexdef LIKE '%(payload ->> ''event_owner''::text)%'
                    AND indexdef LIKE '%ts DESC%'
                    AND indexdef LIKE '%WHERE (action = ''MEMBER_INVITED''::text)%') THEN
    RAISE EXCEPTION 'PROBE FAIL 12: idx_log_member_invited missing or wrong shape: %',
      coalesce((SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_log_member_invited'), 'none');
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 133: % checks passed (rolled back)', v_checks;
END
$probe$;
