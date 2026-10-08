-- tests/sql/132-event-teams-isolation-probe.sql
-- Spec §8 isolation matrix, plus the guard from 132 failing when it should.
-- Run after 132 (and again after 133). Expected: an error whose message
-- starts with 'PROBE OK 132'. Everything is rolled back by the final RAISE.
-- Before 132 it fails with: function cuedeck_guard_results() does not exist
-- (or, before 130, relation "leod_event_members" does not exist).
--
-- Realtime: postgres_changes delivers a row to a subscriber only when the
-- subscriber's SELECT policy passes for that row, so the reads below (as
-- each person, through RLS) are what realtime enforces too. The session
-- transitions (9 Edge Functions) are checked in tests/deno/session-auth.test.ts.
DO $probe$
DECLARE
  v_o1 uuid := gen_random_uuid();   -- organiser of A
  v_o2 uuid := gen_random_uuid();   -- organiser of C
  v_o3 uuid := gen_random_uuid();   -- organiser of B, the event nobody here is on
  v_m  uuid := gen_random_uuid();   -- stage on A, av on C: one login, two organisers
  v_d  uuid := gen_random_uuid();   -- director on A
  v_s  uuid := gen_random_uuid();   -- director on A, suspended
  v_a  uuid; v_b uuid; v_c uuid;
  v_sa uuid; v_sb uuid; v_sc uuid;
  v_da uuid; v_db uuid;
  v_nonce text := md5(random()::text) || md5(random()::text);
  v_secret_b text;
  v_res  text;
  v_ok   boolean;
  v_n    int;
  v_failed boolean;
  v_r    record;
  v_t    record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_o1, v_o2, v_o3, v_m, v_d, v_s]) AS u;
  INSERT INTO leod_users (id, email, role, active)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'director', true
    FROM unnest(ARRAY[v_o1, v_o2, v_o3, v_m, v_d, v_s]) AS u
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, active = EXCLUDED.active;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 132 A', current_date + 30, '09:00', '18:00', v_o1) RETURNING id INTO v_a;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 132 B', current_date + 30, '09:00', '18:00', v_o3) RETURNING id INTO v_b;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 132 C', current_date + 30, '09:00', '18:00', v_o2) RETURNING id INTO v_c;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_a, 1, 'A live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sa;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_b, 1, 'B live', 'LIVE', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sb;
  INSERT INTO leod_sessions (event_id, sort_order, title, status, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_c, 1, 'C ready', 'READY', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sc;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_a, 'A TV') RETURNING id INTO v_da;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_b, 'B TV') RETURNING id, display_secret INTO v_db, v_secret_b;
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_a, 'A sponsor'), (v_b, 'B sponsor');
  INSERT INTO leod_reports (event_id, report_data) VALUES (v_a, '{}'), (v_b, '{}');
  INSERT INTO leod_broadcast (id, event_id, message, priority) VALUES (v_a::text, v_a, 'A notice', 'info'), (v_b::text, v_b, 'B notice', 'info');
  INSERT INTO leod_event_log (event_id, action) VALUES (v_a, 'PROBE_132_A'), (v_b, 'PROBE_132_B');
  INSERT INTO leod_event_members (event_id, user_id, role, active) VALUES
    (v_a, v_m, 'stage',    true),
    (v_c, v_m, 'av',       true),
    (v_a, v_d, 'director', true),
    (v_a, v_s, 'director', false);
  -- B's organiser sends B a message to the speaker
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_o3, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_b, v_sb, 'Probe B message');
  RESET ROLE;

  -- 1. reads: nobody from A reads anything of B, in any table; B's own
  --    organiser does (so the zero is not an empty table)
  FOR v_t IN SELECT * FROM (VALUES ('leod_events', 'id'), ('leod_sessions', 'event_id'), ('leod_event_log', 'event_id'),
      ('leod_broadcast', 'event_id'), ('leod_reports', 'event_id'), ('leod_signage_displays', 'event_id'),
      ('leod_signage_sponsors', 'event_id'), ('leod_stage_messages', 'event_id')) AS y(tbl, col)
  LOOP
    FOR v_r IN SELECT * FROM (VALUES (v_m), (v_d), (v_s), (v_o1)) AS x(uid) LOOP
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
      SET LOCAL ROLE authenticated;
      EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', v_t.tbl, v_t.col) INTO v_n USING v_b;
      RESET ROLE;
      IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 1: % reads % rows of B in %', v_r.uid, v_n, v_t.tbl; END IF;
    END LOOP;
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_o3, 'role', 'authenticated')::text, true);
    SET LOCAL ROLE authenticated;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', v_t.tbl, v_t.col) INTO v_n USING v_b;
    RESET ROLE;
    IF v_n < 1 THEN RAISE EXCEPTION 'PROBE FAIL 1: B''s organiser reads nothing in % (control)', v_t.tbl; END IF;
  END LOOP;
  v_checks := v_checks + 1;

  -- 2. direct writes on B: every one changes no row or is refused (42501)
  FOR v_r IN SELECT * FROM (VALUES (v_m), (v_d)) AS x(uid) LOOP
    FOR v_t IN SELECT * FROM (VALUES
        ('UPDATE leod_events SET name = ''Hijacked'' WHERE id = $1', 'rows'),
        ('DELETE FROM leod_events WHERE id = $1', 'rows'),
        ('UPDATE leod_sessions SET speaker_arrived = NOT speaker_arrived WHERE event_id = $1', 'rows'),
        ('DELETE FROM leod_sessions WHERE event_id = $1', 'rows'),
        ('INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end) VALUES ($1, 9, ''Planted'', ''10:00'', ''10:30'', ''10:00'', ''10:30'')', 'denied'),
        ('INSERT INTO leod_event_log (event_id, action) VALUES ($1, ''PROBE_PLANTED'')', 'denied'),
        ('UPDATE leod_broadcast SET message = ''Hijacked'' WHERE event_id = $1', 'rows'),
        ('DELETE FROM leod_broadcast WHERE event_id = $1', 'rows'),
        ('INSERT INTO leod_reports (event_id, report_data) VALUES ($1, ''{}'')', 'denied'),
        ('INSERT INTO leod_signage_displays (event_id, name) VALUES ($1, ''Planted'')', 'denied'),
        ('UPDATE leod_signage_displays SET name = ''Hijacked'' WHERE event_id = $1', 'rows'),
        ('DELETE FROM leod_signage_displays WHERE event_id = $1', 'rows'),
        ('INSERT INTO leod_signage_sponsors (event_id, name) VALUES ($1, ''Planted'')', 'denied'),
        ('UPDATE leod_signage_sponsors SET name = ''Hijacked'' WHERE event_id = $1', 'rows'),
        ('UPDATE leod_stage_messages SET text = ''Hijacked'' WHERE event_id = $1', 'denied'),
        ('INSERT INTO leod_event_members (event_id, user_id, role) VALUES ($1, auth.uid(), ''director'')', 'denied')) AS y(stmt, kind)
    LOOP
      v_failed := false;
      v_n := 0;
      PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
      BEGIN
        SET LOCAL ROLE authenticated;
        EXECUTE v_t.stmt USING v_b;
        GET DIAGNOSTICS v_n = ROW_COUNT;
      EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
      END;
      RESET ROLE;
      IF (v_t.kind = 'denied' AND NOT v_failed) OR (v_t.kind = 'rows' AND v_n <> 0) THEN
        RAISE EXCEPTION 'PROBE FAIL 2: % ran on B (% rows): %', v_r.uid, v_n, v_t.stmt;
      END IF;
    END LOOP;
  END LOOP;
  v_checks := v_checks + 1;

  -- 3. RPCs on B: stage messages, delays, pairing, rotating, the resolver
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF display_pair_start('PRB742', v_nonce) IS DISTINCT FROM true THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 3: pair_start'; END IF;
  RESET ROLE;
  FOR v_r IN SELECT * FROM (VALUES (v_m), (v_d), (v_s)) AS x(uid) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', v_r.uid, 'role', 'authenticated')::text, true);
    FOR v_t IN SELECT * FROM (VALUES
        ('SELECT stage_message_send($1, $2, ''Hijack'')'),
        ('SELECT stage_message_clear($1, $2)'),
        ('SELECT rpc_apply_delay($2, 5, NULL, ''director'')')) AS y(stmt)
    LOOP
      v_failed := false;
      BEGIN
        SET LOCAL ROLE authenticated;
        EXECUTE v_t.stmt USING v_b, v_sb;
      EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
      END;
      RESET ROLE;
      IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: % ran on B: %', v_r.uid, v_t.stmt; END IF;
    END LOOP;
    SET LOCAL ROLE authenticated;
    v_res := display_pair_link('PRB742', v_db);
    v_ok  := display_rotate_secret(v_db);
    IF cuedeck_event_role(v_b) IS NOT NULL THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 3: % has a role on B', v_r.uid; END IF;
    RESET ROLE;
    IF v_res IS DISTINCT FROM 'forbidden' OR v_ok IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'PROBE FAIL 3: % paired (%) or rotated (%) B''s display', v_r.uid, v_res, v_ok;
    END IF;
  END LOOP;
  IF (SELECT display_secret FROM leod_signage_displays WHERE id = v_db) <> v_secret_b
     OR (SELECT display_id FROM leod_signage_pairing WHERE code = 'PRB742') IS NOT NULL
     OR (SELECT text FROM leod_stage_messages WHERE event_id = v_b AND cleared_at IS NULL) IS DISTINCT FROM 'Probe B message'
     OR (SELECT cumulative_delay FROM leod_sessions WHERE id = v_sb) <> 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a refused RPC changed B';
  END IF;
  v_checks := v_checks + 1;

  -- 4. the suspended director reads nothing of A and changes nothing there
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_s, 'role', 'authenticated')::text, true);
  FOR v_t IN SELECT * FROM (VALUES ('leod_events', 'id'), ('leod_sessions', 'event_id'), ('leod_event_log', 'event_id'),
      ('leod_broadcast', 'event_id'), ('leod_reports', 'event_id'), ('leod_signage_displays', 'event_id'),
      ('leod_signage_sponsors', 'event_id'), ('leod_stage_messages', 'event_id'), ('leod_event_members', 'event_id')) AS y(tbl, col)
  LOOP
    SET LOCAL ROLE authenticated;
    EXECUTE format('SELECT count(*) FROM %I WHERE %I = $1', v_t.tbl, v_t.col) INTO v_n USING v_a;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 4: the suspended director reads % rows of A in %', v_n, v_t.tbl; END IF;
  END LOOP;
  SET LOCAL ROLE authenticated;
  UPDATE leod_sessions SET speaker_arrived = NOT speaker_arrived WHERE event_id = v_a;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 4: the suspended director updated A'; END IF;
  v_checks := v_checks + 1;

  -- 5. the creator can never be demoted: no membership row for them, and the
  --    resolver answers director whatever the roster says
  v_failed := false;
  BEGIN
    INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_a, v_o1, 'reg');
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: the creator was stored as a member'; END IF;
  UPDATE leod_event_members SET role = 'reg' WHERE event_id = v_a AND user_id = v_d;
  IF cuedeck_event_role_of(v_a, v_o1) IS DISTINCT FROM 'director' THEN RAISE EXCEPTION 'PROBE FAIL 5: creator demoted'; END IF;
  UPDATE leod_event_members SET role = 'director' WHERE event_id = v_a AND user_id = v_d;
  v_checks := v_checks + 1;

  -- 6. one login on two organisers' events (Review Focus 2): sees A and C,
  --    never B; stage on A and av on C; may update sessions on both, may not
  --    add one on C (director only); B is unchanged by everything above
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_m, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_events WHERE id IN (v_a, v_b, v_c);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 6: sees % of A, B, C (expected 2)', v_n; END IF;
  SELECT count(*) INTO v_n FROM leod_sessions WHERE event_id IN (v_a, v_b, v_c);
  IF v_n <> 2 THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 6: sees % sessions (expected 2)', v_n; END IF;
  IF cuedeck_event_role(v_a) IS DISTINCT FROM 'stage' OR cuedeck_event_role(v_c) IS DISTINCT FROM 'av' THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 6: roles % and %', cuedeck_event_role(v_a), cuedeck_event_role(v_c);
  END IF;
  UPDATE leod_sessions SET speaker_arrived = NOT speaker_arrived WHERE event_id IN (v_a, v_c);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 2 THEN RAISE EXCEPTION 'PROBE FAIL 6: updated % sessions on A and C (expected 2)', v_n; END IF;
  v_failed := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_sessions (event_id, sort_order, title, planned_start, planned_end, scheduled_start, scheduled_end)
    VALUES (v_c, 2, 'By av', '10:00', '10:30', '10:00', '10:30');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 6: av on C added a session'; END IF;
  IF (SELECT name FROM leod_events WHERE id = v_b) <> 'Probe 132 B'
     OR (SELECT count(*) FROM leod_sessions WHERE event_id = v_b) <> 1
     OR (SELECT message FROM leod_broadcast WHERE id = v_b::text) <> 'B notice'
     OR (SELECT count(*) FROM leod_signage_displays WHERE event_id = v_b AND name = 'B TV') <> 1
     OR (SELECT count(*) FROM leod_event_log WHERE event_id = v_b AND action <> 'STAGE_MESSAGE') <> 1 THEN
    RAISE EXCEPTION 'PROBE FAIL 6: event B changed';
  END IF;
  v_checks := v_checks + 1;

  -- 7. the guards are green now, and they ran just now
  IF (SELECT count(*) FROM cuedeck_guard_results()) <> 3
     OR EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE NOT ok OR checked_at < now() - interval '1 minute') THEN
    RAISE EXCEPTION 'PROBE FAIL 7: %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ') FROM cuedeck_guard_results());
  END IF;
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 7: check-in guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                         FROM checkin_guard_results()
                                                        WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                                        'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  v_checks := v_checks + 1;

  -- 8. the guard fails when a new copy of the old rule appears (watch the
  --    watcher): a policy and a function that read invited_by are each named
  CREATE POLICY probe_old_rule ON leod_reports FOR SELECT TO authenticated
    USING (event_id IN (SELECT e.id FROM leod_events e
                         WHERE e.created_by IN (SELECT u.invited_by FROM leod_users u WHERE u.id = auth.uid())));
  CREATE FUNCTION public.probe_old_rule_fn() RETURNS uuid LANGUAGE sql STABLE
    AS $f$ SELECT invited_by FROM leod_users WHERE id = auth.uid() $f$;
  SELECT detail INTO v_res FROM cuedeck_guard_results() WHERE guard = 'event_access_not_via_invited_by' AND NOT ok;
  IF v_res IS NULL OR position('leod_reports.probe_old_rule' IN v_res) = 0 OR position('probe_old_rule_fn()' IN v_res) = 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 8: the guard did not name the new copies: %', coalesce(v_res, 'guard ok');
  END IF;
  DROP POLICY probe_old_rule ON leod_reports;
  DROP FUNCTION public.probe_old_rule_fn();
  -- and when a client may write the membership table
  GRANT INSERT ON public.leod_event_members TO authenticated;
  IF EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE guard = 'event_members_server_writes_only' AND ok) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: the write guard stayed green with a client INSERT grant';
  END IF;
  REVOKE INSERT ON public.leod_event_members FROM authenticated;
  -- and when a creator row slips in (trigger bypassed, as by a superuser restore)
  ALTER TABLE public.leod_event_members DISABLE TRIGGER trg_leod_event_members_guard;
  INSERT INTO leod_event_members (event_id, user_id, role) VALUES (v_a, v_o1, 'reg');
  ALTER TABLE public.leod_event_members ENABLE TRIGGER trg_leod_event_members_guard;
  IF EXISTS (SELECT 1 FROM cuedeck_guard_results() WHERE guard = 'event_creator_never_member' AND ok)
     OR cuedeck_event_role_of(v_a, v_o1) IS DISTINCT FROM 'director' THEN
    RAISE EXCEPTION 'PROBE FAIL 8: a creator row went unnoticed or demoted the creator';
  END IF;
  v_checks := v_checks + 1;

  -- 9. who may run the guard
  IF has_function_privilege('anon', 'public.cuedeck_guard_results()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.cuedeck_guard_results()', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.cuedeck_guard_results()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 9: guard grants';
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 132: % checks passed (rolled back)', v_checks;
END
$probe$;
