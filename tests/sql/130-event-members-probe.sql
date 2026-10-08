-- tests/sql/130-event-members-probe.sql
-- Run after 130 (and again after 133). Expected: an error whose message
-- starts with 'PROBE OK 130'. Everything is rolled back by the final RAISE.
-- Before 130 is applied it fails with: relation "leod_event_members" does not exist.
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();   -- creates v_ev: its director by creation
  v_dir    uuid := gen_random_uuid();   -- director member of v_ev
  v_stage  uuid := gen_random_uuid();   -- stage member of v_ev
  v_av     uuid := gen_random_uuid();   -- av member of v_ev
  v_sign   uuid := gen_random_uuid();   -- signage member of v_ev
  v_off    uuid := gen_random_uuid();   -- director member of v_ev, suspended
  v_legacy uuid := gen_random_uuid();   -- leod_users.invited_by = v_owner and no membership
  v_other  uuid := gen_random_uuid();   -- another organiser, creates v_ev2
  v_banned uuid := gen_random_uuid();   -- signage member of v_ev, account suspended by an admin (leod_users.active = false)
  v_banown uuid := gen_random_uuid();   -- creates v_ev4, account suspended by an admin
  v_ev4    uuid;
  v_ev     uuid;
  v_ev2    uuid;
  v_ev3    uuid;
  v_sid    uuid;
  v_disp   uuid;
  v_spon   uuid;
  v_role   text;
  v_state  text;
  v_n      int;
  v_m      int;
  v_failed boolean;
  v_r      record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_dir, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u;
  -- every account's global role is the signup default (director): roles now
  -- come from memberships. The old invited_by link is set on v_legacy only,
  -- to prove it no longer gives anything.
  INSERT INTO leod_users (id, email, role, invited_by, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', CASE WHEN u = v_legacy THEN v_owner END, true
    FROM unnest(ARRAY[v_owner, v_dir, v_stage, v_av, v_sign, v_off, v_legacy, v_other]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 130', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 130 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe session', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sid;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'Probe TV') RETURNING id INTO v_disp;
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_ev, 'Probe sponsor') RETURNING id INTO v_spon;
  INSERT INTO leod_reports (event_id, report_data) VALUES (v_ev, '{}');
  INSERT INTO leod_event_members (event_id, user_id, role, active, invited_by) VALUES
    (v_ev, v_dir,   'director', true,  v_owner),
    (v_ev, v_stage, 'stage',    true,  v_owner),
    (v_ev, v_av,    'av',       true,  v_owner),
    (v_ev, v_sign,  'signage',  true,  v_owner),
    (v_ev, v_off,   'director', false, v_owner);

  -- 1. the resolver: the creator is director; members have their role on
  --    their event only; suspended members, the invited_by link alone and
  --    strangers have nothing; a signed-in caller with no user id has nothing
  FOR v_r IN SELECT * FROM (VALUES
      (v_owner, v_ev, 'director'), (v_dir, v_ev, 'director'), (v_stage, v_ev, 'stage'), (v_av, v_ev, 'av'),
      (v_sign, v_ev, 'signage'), (v_off, v_ev, NULL), (v_legacy, v_ev, NULL), (v_other, v_ev, NULL),
      (v_other, v_ev2, 'director'), (v_dir, v_ev2, NULL)) AS x(uid, ev, expected)
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    v_role := cuedeck_event_role(v_r.ev);
    RESET ROLE;
    IF v_role IS DISTINCT FROM v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 1: % on % got %, expected %', v_r.uid, v_r.ev, v_role, v_r.expected;
    END IF;
    IF cuedeck_event_role_of(v_r.ev, v_r.uid) IS DISTINCT FROM v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 1: cuedeck_event_role_of disagrees for %', v_r.uid;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_role := cuedeck_event_role(v_ev);
  RESET ROLE;
  IF v_role IS NOT NULL THEN RAISE EXCEPTION 'PROBE FAIL 1: no user id got %', v_role; END IF;
  v_checks := v_checks + 1;

  -- 1b. an account suspended by an admin (leod_users.active = false, set by
  --     admin-manage-user) has no member role anywhere, even with an active
  --     membership: it reads and writes nothing of the event. The creator
  --     branch does not look at the account flag (unchanged from before 130).
  -- Set up as the database itself: live's leod_users_guard_privileged lets
  -- only admins and the system set active = false, and live's signup trigger
  -- has already made the leod_users row the upsert below updates.
  PERFORM set_config('request.jwt.claims', '', true);
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated' FROM unnest(ARRAY[v_banned, v_banown]) AS u;
  INSERT INTO leod_users (id, email, role, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', false FROM unnest(ARRAY[v_banned, v_banown]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES (v_ev, v_banned, 'signage', true);
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 130 suspended owner', current_date + 30, '09:00', '18:00', v_banown) RETURNING id INTO v_ev4;
  IF cuedeck_event_role_of(v_ev, v_banned) IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 1b: a suspended account resolves to %', cuedeck_event_role_of(v_ev, v_banned);
  END IF;
  IF cuedeck_event_role_of(v_ev4, v_banown) IS DISTINCT FROM 'director' THEN
    RAISE EXCEPTION 'PROBE FAIL 1b: a suspended creator resolves to %', cuedeck_event_role_of(v_ev4, v_banown);
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_banned, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_role := cuedeck_event_role(v_ev);
  SELECT (SELECT count(*) FROM leod_events WHERE id = v_ev)
       + (SELECT count(*) FROM leod_sessions WHERE event_id = v_ev)
       + (SELECT count(*) FROM leod_signage_displays WHERE event_id = v_ev)
       + (SELECT count(*) FROM leod_event_members WHERE event_id = v_ev)
    INTO v_n;
  UPDATE leod_signage_displays SET name = name WHERE id = v_disp;
  GET DIAGNOSTICS v_m = ROW_COUNT;
  RESET ROLE;
  IF v_role IS NOT NULL OR v_n <> 0 OR v_m <> 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 1b: the suspended account got role %, read % rows, updated % displays', v_role, v_n, v_m;
  END IF;
  -- out of the way of the roster counts below
  DELETE FROM leod_event_members WHERE event_id = v_ev AND user_id = v_banned;
  v_checks := v_checks + 1;

  -- 2. the table: one membership per person and event, six roles only, the
  --    creator never a member, event and person fixed once written
  v_state := NULL;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_ev, v_dir, 'stage');
  EXCEPTION WHEN unique_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23505' THEN
    RAISE EXCEPTION 'PROBE FAIL 2: a second membership on one event gave %', coalesce(v_state, 'no error');
  END IF;
  FOR v_r IN SELECT * FROM (VALUES ('admin'), ('pending'), ('checkin_staff'), ('')) AS x(r) LOOP
    v_state := NULL;
    BEGIN
      INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_ev, v_legacy, v_r.r);
    EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
    END;
    IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: role "%" accepted', v_r.r; END IF;
  END LOOP;
  v_state := NULL;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_ev, v_owner, 'stage');
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: the creator was stored as a member'; END IF;
  v_state := NULL;
  BEGIN
    UPDATE leod_event_members SET user_id = v_owner WHERE event_id = v_ev AND user_id = v_stage;
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: a membership moved to another person'; END IF;
  v_state := NULL;
  BEGIN
    UPDATE leod_event_members SET event_id = v_ev2 WHERE event_id = v_ev AND user_id = v_stage;
  EXCEPTION WHEN check_violation THEN v_state := SQLSTATE;
  END;
  IF v_state IS DISTINCT FROM '23514' THEN RAISE EXCEPTION 'PROBE FAIL 2: a membership moved to another event'; END IF;
  IF cuedeck_event_role_of(v_ev, v_owner) IS DISTINCT FROM 'director' THEN RAISE EXCEPTION 'PROBE FAIL 2: creator demoted'; END IF;
  v_checks := v_checks + 1;

  -- 3. members read their event's roster (suspended, legacy and strangers do
  --    not); nobody signed in writes it, not even the creator
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 5), (v_stage, 5), (v_off, 0), (v_legacy, 0), (v_other, 0)) AS x(uid, expected) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT count(*) INTO v_n FROM leod_event_members WHERE event_id = v_ev;
    RESET ROLE;
    IF v_n <> v_r.expected THEN RAISE EXCEPTION 'PROBE FAIL 3: % reads % roster rows, expected %', v_r.uid, v_n, v_r.expected; END IF;
  END LOOP;
  FOR v_r IN SELECT * FROM (VALUES
      (v_owner, 'INSERT INTO leod_event_members (event_id, user_id, role) VALUES ($1, $2, ''stage'')'),
      (v_dir,   'UPDATE leod_event_members SET role = ''director'' WHERE event_id = $1'),
      (v_owner, 'DELETE FROM leod_event_members WHERE event_id = $1'),
      (v_stage, 'UPDATE leod_event_members SET active = true WHERE event_id = $1')) AS x(uid, stmt)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE v_r.stmt USING v_ev, v_legacy;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: a client write ran: %', v_r.stmt; END IF;
  END LOOP;
  IF (SELECT count(*) FROM leod_event_members WHERE event_id = v_ev) <> 5
     OR NOT EXISTS (SELECT 1 FROM leod_event_members WHERE event_id = v_ev AND user_id = v_off AND NOT active) THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a refused write changed the roster';
  END IF;
  v_checks := v_checks + 1;

  -- 4. reads follow the resolver: the event row, its sessions, reports,
  --    displays and sponsors (one row each) for every member; nothing for
  --    the suspended member, the invited_by link alone, or a stranger
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 5), (v_dir, 5), (v_stage, 5), (v_av, 5), (v_sign, 5),
                                   (v_off, 0), (v_legacy, 0), (v_other, 0)) AS x(uid, expected) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    SELECT (SELECT count(*) FROM leod_events WHERE id = v_ev)
         + (SELECT count(*) FROM leod_sessions WHERE event_id = v_ev)
         + (SELECT count(*) FROM leod_reports WHERE event_id = v_ev)
         + (SELECT count(*) FROM leod_signage_displays WHERE event_id = v_ev)
         + (SELECT count(*) FROM leod_signage_sponsors WHERE event_id = v_ev)
      INTO v_n;
    RESET ROLE;
    IF v_n <> v_r.expected THEN RAISE EXCEPTION 'PROBE FAIL 4: % reads % rows, expected %', v_r.uid, v_n, v_r.expected; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 5. displays and sponsors: director and signage write; stage, av, the
  --    suspended member and strangers do not (before 130 any member could)
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 1), (v_dir, 1), (v_sign, 1), (v_stage, 0), (v_av, 0),
                                   (v_off, 0), (v_other, 0)) AS x(uid, expected) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE leod_signage_displays SET name = name WHERE id = v_disp;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    UPDATE leod_signage_sponsors SET name = name WHERE id = v_spon;
    GET DIAGNOSTICS v_m = ROW_COUNT;
    RESET ROLE;
    IF v_n <> v_r.expected OR v_m <> v_r.expected THEN
      RAISE EXCEPTION 'PROBE FAIL 5: % updated % displays and % sponsors, expected %', v_r.uid, v_n, v_m, v_r.expected;
    END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'By signage');
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_ev, 'By signage');
  RESET ROLE;
  FOR v_r IN SELECT * FROM (VALUES
      ('INSERT INTO leod_signage_displays (event_id, name) VALUES ($1, ''By av'')'),
      ('INSERT INTO leod_signage_sponsors (event_id, name) VALUES ($1, ''By av'')')) AS x(stmt)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_av, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE v_r.stmt USING v_ev;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: av ran %', v_r.stmt; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_av, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  DELETE FROM leod_signage_displays WHERE event_id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 5: av deleted % displays', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_sign, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  DELETE FROM leod_signage_displays WHERE event_id = v_ev AND name = 'By signage';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 5: signage deleted % displays, expected 1', v_n; END IF;
  v_checks := v_checks + 1;

  -- 6. the event row: an invited director edits its details (spec §9.1) but
  --    not its owner, origin or active flag; only the creator deletes or
  --    deactivates it; nobody gives it away; other members change nothing
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE leod_events SET name = 'Renamed by director', venue = 'Hall 2' WHERE id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 OR (SELECT name FROM leod_events WHERE id = v_ev) <> 'Renamed by director' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: the invited director could not edit the event';
  END IF;
  FOR v_r IN SELECT * FROM (VALUES
      (v_dir,   'UPDATE leod_events SET active = false WHERE id = $1'),
      (v_dir,   'UPDATE leod_events SET created_by = $2 WHERE id = $1'),
      (v_dir,   'UPDATE leod_events SET created_via = ''checkin'' WHERE id = $1'),
      (v_owner, 'UPDATE leod_events SET created_by = $2 WHERE id = $1')) AS x(uid, stmt)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      EXECUTE v_r.stmt USING v_ev, v_dir;
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 6: % ran %', v_r.uid, v_r.stmt; END IF;
  END LOOP;
  FOR v_r IN SELECT * FROM (VALUES (v_stage), (v_av), (v_sign), (v_off), (v_legacy), (v_other)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE leod_events SET name = 'Hijacked' WHERE id = v_ev;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: % edited the event', v_r.uid; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  DELETE FROM leod_events WHERE id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 6: the invited director deleted the event'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE leod_events SET active = false WHERE id = v_ev;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE leod_events SET active = true WHERE id = v_ev;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 6: the creator could not deactivate the event'; END IF;
  v_checks := v_checks + 1;

  -- 7. a new event is readable by its creator in the statement that creates
  --    it (INSERT ... RETURNING, as the console does): the resolver cannot
  --    see a row inserted by the statement it runs in, so owner_read_events
  --    keeps created_by = auth.uid() next to it
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_events (name, date, event_start, event_end, created_by)
    VALUES ('Probe 130 new', current_date + 31, '09:00', '18:00', v_other) RETURNING id INTO v_ev3;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 7: INSERT ... RETURNING of a new event refused: %', SQLERRM;
  END;
  RESET ROLE;
  IF v_ev3 IS NULL THEN RAISE EXCEPTION 'PROBE FAIL 7: no id returned'; END IF;
  v_checks := v_checks + 1;

  -- 8. privileges, RLS, and the rewritten policies
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.leod_event_members'::regclass)
     OR has_table_privilege('anon', 'public.leod_event_members', 'SELECT')
     OR has_table_privilege('anon', 'public.leod_event_members', 'INSERT')
     OR NOT has_table_privilege('authenticated', 'public.leod_event_members', 'SELECT')
     OR has_table_privilege('authenticated', 'public.leod_event_members', 'INSERT')
     OR has_table_privilege('authenticated', 'public.leod_event_members', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.leod_event_members', 'DELETE')
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.leod_event_members'::regclass AND polcmd <> 'r')
     OR has_function_privilege('anon', 'public.cuedeck_event_role(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.cuedeck_event_role(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_event_role_of(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.cuedeck_event_role_of(uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.leod_event_members_guard()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.leod_events_guard_member_update()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 8: privileges';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'public'
     AND policyname IN ('owner_read_events', 'scoped_read_sessions', 'owner_read_reports', 'events_director_update',
                        'displays_member_read', 'displays_signage_insert', 'displays_signage_update', 'displays_signage_delete',
                        'sponsors_member_read', 'sponsors_signage_insert', 'sponsors_signage_update', 'sponsors_signage_delete',
                        'event_members_member_read')
     AND coalesce(qual, '') || ' ' || coalesce(with_check, '') LIKE '%cuedeck_event_role%'
     AND coalesce(qual, '') || ' ' || coalesce(with_check, '') NOT LIKE '%invited_by%';
  IF v_n <> 13 THEN RAISE EXCEPTION 'PROBE FAIL 8: % of 13 policies call the resolver without invited_by', v_n; END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
              AND policyname IN ('scoped_all_displays', 'scoped_all_sponsors', 'owner_update_events')) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: an old policy is still there';
  END IF;
  v_checks := v_checks + 1;

  -- 9. guards that must stay green
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 9: guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                FROM checkin_guard_results()
                                               WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                               'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 130: % checks passed (rolled back)', v_checks;
END
$probe$;
