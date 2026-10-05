-- tests/sql/095-event-scoped-writes-probe.sql
-- Run after 093, 094 and 095. Expected: an error whose message starts with
-- 'PROBE OK 095'. Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();
  v_dir    uuid := gen_random_uuid();   -- director invited by v_owner
  v_av     uuid := gen_random_uuid();   -- av invited by v_owner
  v_reg    uuid := gen_random_uuid();   -- reg invited by v_owner (no session writes)
  v_dead   uuid := gen_random_uuid();   -- director invited by v_owner, deactivated
  v_other  uuid := gen_random_uuid();   -- unrelated account, owns v_ev2
  v_ev     uuid;
  v_ev2    uuid;
  v_sid    uuid;
  v_n      int;
  v_failed boolean;
  v_r      record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_dir, v_av, v_reg, v_dead, v_other]) AS u;
  INSERT INTO leod_users (id, email, role, invited_by, active) VALUES
    (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'director', NULL,    true),
    (v_dir,   'probe-' || v_dir   || '@cuedeck-test.io', 'director', v_owner, true),
    (v_av,    'probe-' || v_av    || '@cuedeck-test.io', 'av',       v_owner, true),
    (v_reg,   'probe-' || v_reg   || '@cuedeck-test.io', 'reg',      v_owner, true),
    (v_dead,  'probe-' || v_dead  || '@cuedeck-test.io', 'director', v_owner, false),
    (v_other, 'probe-' || v_other || '@cuedeck-test.io', 'director', NULL,    true)
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 095', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 095 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe session', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sid;

  -- 1. cuedeck_event_role
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 'director'), (v_dir, 'director'), (v_av, 'av'), (v_reg, 'reg'),
                                   (v_dead, NULL), (v_other, NULL)) AS x(uid, expected)
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    IF cuedeck_event_role(v_ev) IS DISTINCT FROM v_r.expected THEN
      RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 1: % got %', v_r.uid, cuedeck_event_role(v_ev);
    END IF;
    RESET ROLE;
  END LOOP;
  IF has_function_privilege('anon', 'public.cuedeck_event_role(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 1: anon can execute cuedeck_event_role';
  END IF;
  v_checks := v_checks + 1;

  -- 2. sessions: owner, invited director and av write; reg, deactivated and stranger do not
  FOR v_r IN SELECT * FROM (VALUES (v_owner, 1), (v_dir, 1), (v_av, 1), (v_reg, 0), (v_dead, 0), (v_other, 0)) AS x(uid, expected)
  LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    UPDATE leod_sessions SET speaker_arrived = NOT speaker_arrived WHERE id = v_sid;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> v_r.expected THEN RAISE EXCEPTION 'PROBE FAIL 2: % updated % rows', v_r.uid, v_n; END IF;
  END LOOP;
  -- inserts: the invited director can, the stranger cannot (into this event)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 2, 'By invited director', '10:00', '10:30', '10:00', '10:30');
  RESET ROLE;
  v_failed := false;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end)
    VALUES (v_ev, 3, 'By stranger', '11:00', '11:30', '11:00', '11:30');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 2: stranger inserted a session'; END IF;
  -- reads unchanged: the stranger still sees nothing, the deactivated operator still reads (scoped_read_sessions)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_sessions WHERE event_id = v_ev;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 2: stranger reads % sessions', v_n; END IF;
  -- anon cannot write
  v_failed := false;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  BEGIN
    SET LOCAL ROLE anon;
    UPDATE leod_sessions SET title = 'anon' WHERE id = v_sid;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 2: anon UPDATE was not refused'; END IF;
  v_checks := v_checks + 1;

  -- 3. event log: members append as themselves; nobody signed in edits or deletes
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_av, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_event_log (event_id, session_id, action, operator_id) VALUES (v_ev, v_sid, 'PROBE_095', v_av);
  SELECT count(*) INTO v_n FROM leod_event_log WHERE event_id = v_ev AND action = 'PROBE_095';
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 3: member reads % log rows', v_n; END IF;
  FOR v_r IN SELECT * FROM (VALUES
      (v_other, v_ev,  NULL::uuid, 'stranger'),
      (v_dead,  v_ev,  NULL::uuid, 'deactivated'),
      (v_av,    v_ev,  v_owner,    'av forging the owner'),
      (v_owner, v_ev2, NULL::uuid, 'owner into another event')) AS x(uid, ev, op, label)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      INSERT INTO leod_event_log (event_id, action, operator_id) VALUES (v_r.ev, 'PROBE_095_BAD', v_r.op);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: % could insert', v_r.label; END IF;
  END LOOP;
  v_failed := false;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    DELETE FROM leod_event_log WHERE event_id = v_ev;
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: owner could delete log rows'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_event_log WHERE event_id = v_ev;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 3: stranger reads % log rows', v_n; END IF;
  IF has_table_privilege('anon', 'public.leod_event_log', 'SELECT')
     OR has_table_privilege('authenticated', 'public.leod_event_log', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.leod_event_log', 'DELETE') THEN
    RAISE EXCEPTION 'PROBE FAIL 3: grants';
  END IF;
  v_checks := v_checks + 1;

  -- 4. broadcast: members write their event's row (id = event id) only
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_av, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_broadcast (id, event_id, message, priority) VALUES (v_ev::text, v_ev, 'Doors open', 'info')
  ON CONFLICT (id) DO UPDATE SET message = EXCLUDED.message;
  RESET ROLE;
  FOR v_r IN SELECT * FROM (VALUES
      (v_av,    'global',      v_ev, 'member squatting a shared id'),
      (v_av,    v_ev2::text,   v_ev, 'member squatting another event id'),
      (v_other, v_ev::text,    v_ev, 'stranger')) AS x(uid, id, ev, label)
  LOOP
    v_failed := false;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    BEGIN
      SET LOCAL ROLE authenticated;
      INSERT INTO leod_broadcast (id, event_id, message, priority) VALUES (v_r.id, v_r.ev, 'x', 'info');
    EXCEPTION WHEN insufficient_privilege OR unique_violation THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 4: % could insert', v_r.label; END IF;
  END LOOP;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_broadcast WHERE event_id = v_ev;
  UPDATE leod_broadcast SET message = 'hijack' WHERE event_id = v_ev;
  RESET ROLE;
  IF v_n <> 0 OR EXISTS (SELECT 1 FROM leod_broadcast WHERE event_id = v_ev AND message = 'hijack') THEN
    RAISE EXCEPTION 'PROBE FAIL 4: stranger read or changed the broadcast';
  END IF;
  IF has_table_privilege('anon', 'public.leod_broadcast', 'SELECT') OR EXISTS (SELECT 1 FROM leod_broadcast WHERE id = 'global') THEN
    RAISE EXCEPTION 'PROBE FAIL 4: anon read or global row left';
  END IF;
  v_checks := v_checks + 1;

  -- 5. clock: read-only for clients, get_server_clock still ticks
  IF has_table_privilege('authenticated', 'public.leod_clock', 'UPDATE')
     OR has_table_privilege('anon', 'public.leod_clock', 'INSERT')
     OR NOT has_table_privilege('anon', 'public.leod_clock', 'SELECT') THEN
    RAISE EXCEPTION 'PROBE FAIL 5: clock grants';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM get_server_clock();
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 5: get_server_clock returned % rows', v_n; END IF;
  SET LOCAL ROLE anon;
  PERFORM 1 FROM leod_clock LIMIT 1;
  RESET ROLE;
  v_checks := v_checks + 1;

  -- 6. commands closed to clients; reports scoped
  IF has_table_privilege('authenticated', 'public.leod_commands', 'SELECT')
     OR has_table_privilege('anon', 'public.leod_commands', 'SELECT') THEN
    RAISE EXCEPTION 'PROBE FAIL 6: leod_commands readable by clients';
  END IF;
  v_failed := false;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_reports (event_id, generated_by, report_data) VALUES (v_ev, v_other, '{}');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 6: stranger inserted a report'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_reports (event_id, generated_by, report_data) VALUES (v_ev, v_dir, '{}');
  RESET ROLE;
  v_checks := v_checks + 1;

  -- 7. guards: G13 green, G12 and 092's guard still there
  IF (SELECT ok FROM checkin_guard_results() WHERE guard = 'leod_writes_not_unconditional') IS DISTINCT FROM true
     OR NOT EXISTS (SELECT 1 FROM checkin_guard_results() WHERE guard = 'sessions_archive_has_every_column')
     OR NOT EXISTS (SELECT 1 FROM checkin_guard_results() WHERE guard = 'checkin_reports_not_parked') THEN
    RAISE EXCEPTION 'PROBE FAIL 7: guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                 FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 095: % checks passed', v_checks;
END
$probe$;
