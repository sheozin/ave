-- tests/sql/128-stage-messages-probe.sql
-- Run after 128. Expected: an error whose message starts with
-- 'PROBE OK 128'. Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();   -- creates the event: director
  v_dir    uuid := gen_random_uuid();   -- director invited by v_owner
  v_stage  uuid := gen_random_uuid();   -- stage invited by v_owner
  v_av     uuid := gen_random_uuid();   -- av invited by v_owner: may read, not send
  v_other  uuid := gen_random_uuid();   -- unrelated account, owns v_ev2
  v_ev     uuid;
  v_ev2    uuid;
  v_sid    uuid;
  v_sid2   uuid;   -- second session of v_ev, same room
  v_sid3   uuid;   -- session of v_ev2
  v_disp   uuid;
  v_secret text;
  v_disp2  uuid;
  v_secret2 text;
  v_res    jsonb;
  v_feed   jsonb;
  v_ok     boolean;
  v_n      int;
  v_failed boolean;
  v_state  text;
  v_r      record;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_dir, v_stage, v_av, v_other]) AS u;
  INSERT INTO leod_users (id, email, role, invited_by, active) VALUES
    (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'director', NULL,    true),
    (v_dir,   'probe-' || v_dir   || '@cuedeck-test.io', 'director', v_owner, true),
    (v_stage, 'probe-' || v_stage || '@cuedeck-test.io', 'stage',    v_owner, true),
    (v_av,    'probe-' || v_av    || '@cuedeck-test.io', 'av',       v_owner, true),
    (v_other, 'probe-' || v_other || '@cuedeck-test.io', 'director', NULL,    true)
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, active = EXCLUDED.active;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 128', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 128 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
  INSERT INTO leod_sessions (event_id, sort_order, title, room, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe keynote', 'Main Stage', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sid;
  INSERT INTO leod_sessions (event_id, sort_order, title, room, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 2, 'Probe panel', 'Main Stage', '09:30', '10:00', '09:30', '10:00') RETURNING id INTO v_sid2;
  INSERT INTO leod_sessions (event_id, sort_order, title, room, planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev2, 1, 'Probe other', 'Hall', '09:00', '09:30', '09:00', '09:30') RETURNING id INTO v_sid3;
  INSERT INTO leod_signage_displays (event_id, name, content_mode) VALUES (v_ev, 'Probe stage TV', 'stage_timer')
    RETURNING id, display_secret INTO v_disp, v_secret;
  INSERT INTO leod_signage_displays (event_id, name, content_mode) VALUES (v_ev2, 'Probe other TV', 'stage_timer')
    RETURNING id, display_secret INTO v_disp2, v_secret2;

  -- 1. a director sends: one active row, returned shape, one log row
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := stage_message_send(v_ev, v_sid, '  Please wrap up  ');
  RESET ROLE;
  IF v_res->>'text' IS DISTINCT FROM 'Please wrap up' OR (v_res->>'session_id')::uuid IS DISTINCT FROM v_sid
     OR v_res->>'sent_at' IS NULL OR v_res->>'id' IS NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 1: send returned %', v_res;
  END IF;
  IF (SELECT count(*) FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL AND sent_by = v_dir) <> 1 THEN
    RAISE EXCEPTION 'PROBE FAIL 1: no active row by the director';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_event_log WHERE event_id = v_ev AND session_id = v_sid AND action = 'STAGE_MESSAGE'
                    AND operator_id = v_dir AND payload->>'text' = 'Please wrap up'
                    AND payload->>'session_id' = v_sid::text) THEN
    RAISE EXCEPTION 'PROBE FAIL 1: no STAGE_MESSAGE log row';
  END IF;
  v_checks := v_checks + 1;

  -- 2. stage sends: replaces, so still one active row; the old one is cleared
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := stage_message_send(v_ev, v_sid, '5 minutes left');
  RESET ROLE;
  SELECT count(*) INTO v_n FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL;
  IF v_n <> 1 OR (SELECT text FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL) <> '5 minutes left' THEN
    RAISE EXCEPTION 'PROBE FAIL 2: % active rows after a second send', v_n;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND text = 'Please wrap up'
                    AND cleared_at IS NOT NULL AND cleared_by = v_stage) THEN
    RAISE EXCEPTION 'PROBE FAIL 2: the first message was not cleared by the replace';
  END IF;
  v_checks := v_checks + 1;

  -- 3. av, a stranger, and a caller with no user id are refused (42501),
  --    for send and clear; nothing changes
  FOR v_r IN SELECT * FROM (VALUES
      (json_build_object('sub', v_av,    'role', 'authenticated')::text, 'av'),
      (json_build_object('sub', v_other, 'role', 'authenticated')::text, 'stranger'),
      ('{"role":"authenticated"}', 'no user id')) AS x(claims, label)
  LOOP
    PERFORM set_config('request.jwt.claims', v_r.claims, true);
    v_failed := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM stage_message_send(v_ev, v_sid, 'Hijack');
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: % could send', v_r.label; END IF;
    v_failed := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM stage_message_clear(v_ev, v_sid);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: % could clear', v_r.label; END IF;
    -- 42501 comes before argument checks: a stranger with NULL arguments
    -- (as checkin_rpcs_refuse_strangers calls it) is refused, not told why
    v_failed := false;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM stage_message_send(v_ev, NULL, NULL);
    EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
    END;
    RESET ROLE;
    IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 3: % with NULL arguments not refused with 42501', v_r.label; END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM leod_stage_messages WHERE text = 'Hijack')
     OR (SELECT count(*) FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL) <> 1 THEN
    RAISE EXCEPTION 'PROBE FAIL 3: a refused call changed rows';
  END IF;
  v_checks := v_checks + 1;

  -- 4. text limits: 60 accepted, 61 and blank refused (22023);
  --    a session of another event refused (P0002)
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := stage_message_send(v_ev, v_sid2, repeat('x', 60));
  RESET ROLE;
  IF char_length(v_res->>'text') <> 60 THEN RAISE EXCEPTION 'PROBE FAIL 4: 60 characters not accepted'; END IF;
  FOR v_r IN SELECT * FROM (VALUES (repeat('y', 61), '22023'), ('   ', '22023'), ('', '22023'), (NULL, '22023')) AS x(t, code)
  LOOP
    v_state := NULL;
    BEGIN
      SET LOCAL ROLE authenticated;
      PERFORM stage_message_send(v_ev, v_sid2, v_r.t);
    EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
    END;
    RESET ROLE;
    IF v_state IS DISTINCT FROM v_r.code THEN
      RAISE EXCEPTION 'PROBE FAIL 4: text of length % gave %', char_length(v_r.t), coalesce(v_state, 'no error');
    END IF;
  END LOOP;
  v_state := NULL;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM stage_message_send(v_ev, v_sid3, 'Wrong event');
  EXCEPTION WHEN OTHERS THEN v_state := SQLSTATE;
  END;
  RESET ROLE;
  IF v_state IS DISTINCT FROM 'P0002' THEN RAISE EXCEPTION 'PROBE FAIL 4: other event session gave %', coalesce(v_state, 'no error'); END IF;
  -- the table check holds for direct writes too
  v_failed := false;
  BEGIN
    INSERT INTO leod_stage_messages (event_id, session_id, text, sent_by) VALUES (v_ev, v_sid3, repeat('z', 61), v_dir);
  EXCEPTION WHEN check_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 4: table accepted 61 characters'; END IF;
  -- one active message per session, also for direct writes
  v_failed := false;
  BEGIN
    INSERT INTO leod_stage_messages (event_id, session_id, text, sent_by) VALUES (v_ev, v_sid, 'Second active', v_dir);
  EXCEPTION WHEN unique_violation THEN v_failed := true;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 4: two active messages for one session'; END IF;
  v_checks := v_checks + 1;

  -- 5. RLS on direct table access: av reads, cannot write; stranger sees nothing;
  --    nobody deletes
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_av, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_stage_messages WHERE event_id = v_ev AND cleared_at IS NULL;
  RESET ROLE;
  IF v_n <> 2 THEN RAISE EXCEPTION 'PROBE FAIL 5: av reads % active rows, expected 2', v_n; END IF;
  v_failed := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_stage_messages (event_id, session_id, text) VALUES (v_ev, v_sid2, 'av direct');
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: av inserted directly'; END IF;
  SET LOCAL ROLE authenticated;
  UPDATE leod_stage_messages SET text = 'av edit' WHERE event_id = v_ev;
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_stage_messages WHERE event_id = v_ev;
  UPDATE leod_stage_messages SET text = 'stranger edit' WHERE event_id = v_ev;
  RESET ROLE;
  IF v_n <> 0 OR EXISTS (SELECT 1 FROM leod_stage_messages WHERE text IN ('av edit', 'stranger edit')) THEN
    RAISE EXCEPTION 'PROBE FAIL 5: stranger read % rows, or a non-sender edited', v_n;
  END IF;
  -- a director inserting directly cannot sign as someone else
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_dir, 'role', 'authenticated')::text, true);
  v_failed := false;
  BEGIN
    SET LOCAL ROLE authenticated;
    INSERT INTO leod_stage_messages (event_id, session_id, text, sent_by) VALUES (v_ev, gen_random_uuid(), 'forged', v_stage);
  EXCEPTION WHEN insufficient_privilege THEN v_failed := true;
  END;
  RESET ROLE;
  IF NOT v_failed THEN RAISE EXCEPTION 'PROBE FAIL 5: director inserted a row signed by stage'; END IF;
  BEGIN
    SET LOCAL ROLE authenticated;
    DELETE FROM leod_stage_messages WHERE event_id = v_ev;
  EXCEPTION WHEN insufficient_privilege THEN NULL;   -- no DELETE grant: refused outright
  END;
  RESET ROLE;
  IF (SELECT count(*) FROM leod_stage_messages WHERE event_id = v_ev) < 3 THEN
    RAISE EXCEPTION 'PROBE FAIL 5: a director deleted rows';
  END IF;
  v_checks := v_checks + 1;

  -- 6. display_feed: the message shows only while its session is LIVE,
  --    OVERRUN or HOLD; never on another event's TV; every other key intact
  FOR v_r IN SELECT * FROM (VALUES ('PLANNED', 0), ('READY', 0), ('CALLING', 0), ('LIVE', 1),
                                   ('OVERRUN', 1), ('HOLD', 1), ('ENDED', 0), ('CANCELLED', 0)) AS x(st, expect)
  LOOP
    EXECUTE 'UPDATE leod_sessions SET status = $1::session_status WHERE id = $2' USING v_r.st, v_sid;
    PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
    SET LOCAL ROLE anon;
    v_feed := display_feed(v_disp, v_secret);
    RESET ROLE;
    SELECT count(*) INTO v_n FROM jsonb_array_elements(v_feed->'stage_messages') m
     WHERE m->>'session_id' = v_sid::text AND m->>'text' = '5 minutes left' AND m->>'sent_at' IS NOT NULL;
    IF v_n <> v_r.expect THEN
      RAISE EXCEPTION 'PROBE FAIL 6: status % gave % messages, expected %: %', v_r.st, v_n, v_r.expect, v_feed->'stage_messages';
    END IF;
  END LOOP;
  -- HOLD -> ENDED above cleared the message (the stop trigger); send it again
  -- v_sid2 (60 x) is PLANNED: not in the feed; keys are exactly as before plus stage_messages
  UPDATE leod_sessions SET status = 'LIVE' WHERE id = v_sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_ev, v_sid, '5 minutes left');
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp, v_secret);
  RESET ROLE;
  IF jsonb_array_length(v_feed->'stage_messages') <> 1
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_feed) k)
        <> ARRAY['display', 'event', 'server_time', 'sessions', 'sponsors', 'stage_messages']
     OR (SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(v_feed->'stage_messages'->0) k)
        <> ARRAY['sent_at', 'session_id', 'text']
     OR jsonb_array_length(v_feed->'sessions') <> 2
     OR v_feed->'display' ? 'display_secret' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: feed shape %', v_feed;
  END IF;
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp2, v_secret2);
  RESET ROLE;
  IF jsonb_array_length(v_feed->'stage_messages') <> 0 THEN
    RAISE EXCEPTION 'PROBE FAIL 6: another event''s TV got %', v_feed->'stage_messages';
  END IF;
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp, v_secret2);
  RESET ROLE;
  IF v_feed IS NOT NULL THEN RAISE EXCEPTION 'PROBE FAIL 6: wrong secret returned a feed'; END IF;
  v_checks := v_checks + 1;

  -- 7. clear: sets cleared_at and cleared_by, logs, drops it from the feed;
  --    a second clear answers false and logs nothing
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := stage_message_clear(v_ev, v_sid);
  RESET ROLE;
  IF v_ok IS DISTINCT FROM true
     OR EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND text = '5 minutes left'
                       AND cleared_at IS NOT NULL AND cleared_by = v_stage) THEN
    RAISE EXCEPTION 'PROBE FAIL 7: clear did not set cleared_at/cleared_by (returned %)', v_ok;
  END IF;
  IF (SELECT count(*) FROM leod_event_log WHERE event_id = v_ev AND session_id = v_sid AND action = 'STAGE_MESSAGE_CLEARED'
         AND operator_id = v_stage AND payload->>'text' = '5 minutes left') <> 1 THEN
    RAISE EXCEPTION 'PROBE FAIL 7: no STAGE_MESSAGE_CLEARED log row';
  END IF;
  SET LOCAL ROLE authenticated;
  v_ok := stage_message_clear(v_ev, v_sid);
  RESET ROLE;
  IF v_ok IS DISTINCT FROM false
     OR (SELECT count(*) FROM leod_event_log WHERE event_id = v_ev AND action = 'STAGE_MESSAGE_CLEARED') <> 1 THEN
    RAISE EXCEPTION 'PROBE FAIL 7: second clear returned % or logged again', v_ok;
  END IF;
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp, v_secret);
  RESET ROLE;
  IF jsonb_array_length(v_feed->'stage_messages') <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 7: cleared message still in feed'; END IF;
  -- a fresh send after a clear works (the partial index frees the slot)
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_ev, v_sid, 'Take questions now');
  RESET ROLE;
  v_checks := v_checks + 1;

  -- 8. privileges: anon has nothing on the table and cannot run the RPCs;
  --    authenticated can; display_feed grants unchanged; the table is in realtime
  IF has_table_privilege('anon', 'public.leod_stage_messages', 'SELECT')
     OR has_table_privilege('anon', 'public.leod_stage_messages', 'INSERT')
     OR has_table_privilege('anon', 'public.leod_stage_messages', 'UPDATE')
     OR has_table_privilege('anon', 'public.leod_stage_messages', 'DELETE')
     OR has_table_privilege('anon', 'public.leod_stage_messages', 'TRUNCATE')
     OR has_table_privilege('authenticated', 'public.leod_stage_messages', 'DELETE')
     OR has_table_privilege('authenticated', 'public.leod_stage_messages', 'TRUNCATE')
     OR has_function_privilege('anon', 'public.stage_message_send(uuid,uuid,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.stage_message_clear(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.stage_message_send(uuid,uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.stage_message_clear(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('anon', 'public.display_feed(uuid,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_feed(uuid,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 8: privileges';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.leod_stage_messages'::regclass)
     OR NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'leod_stage_messages')
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.leod_stage_messages'::regclass AND polcmd IN ('d', '*')) THEN
    RAISE EXCEPTION 'PROBE FAIL 8: RLS, realtime or a delete policy';
  END IF;
  v_checks := v_checks + 1;

  -- 9. a session leaving LIVE/OVERRUN/HOLD clears its message (by the system:
  --    cleared_by NULL, nothing logged); HOLD keeps it; a queued message on a
  --    READY session survives until it goes live; a restart does not bring an
  --    old message back
  SELECT count(*) INTO v_n FROM leod_event_log WHERE event_id = v_ev;
  UPDATE leod_sessions SET status = 'HOLD' WHERE id = v_sid;
  UPDATE leod_sessions SET status = 'LIVE' WHERE id = v_sid;
  IF NOT EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL AND text = 'Take questions now') THEN
    RAISE EXCEPTION 'PROBE FAIL 9: LIVE -> HOLD -> LIVE cleared the message';
  END IF;
  UPDATE leod_sessions SET status = 'ENDED' WHERE id = v_sid;
  IF EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL)
     OR NOT EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND text = 'Take questions now'
                       AND cleared_at IS NOT NULL AND cleared_by IS NULL) THEN
    RAISE EXCEPTION 'PROBE FAIL 9: LIVE -> ENDED did not clear the message as the system';
  END IF;
  -- restart: back to LIVE, a fresh message, then LIVE -> READY clears it
  UPDATE leod_sessions SET status = 'LIVE' WHERE id = v_sid;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stage, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_ev, v_sid, 'Stop now');
  RESET ROLE;
  UPDATE leod_sessions SET status = 'READY' WHERE id = v_sid;
  IF EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'PROBE FAIL 9: LIVE -> READY (restart) did not clear the message';
  END IF;
  UPDATE leod_sessions SET status = 'LIVE' WHERE id = v_sid;
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp, v_secret);
  RESET ROLE;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_feed->'stage_messages') m WHERE m->>'session_id' = v_sid::text) THEN
    RAISE EXCEPTION 'PROBE FAIL 9: a restarted session shows an old message again';
  END IF;
  -- OVERRUN -> CANCELLED clears too
  SET LOCAL ROLE authenticated;
  PERFORM stage_message_send(v_ev, v_sid, 'Please wrap up');
  RESET ROLE;
  UPDATE leod_sessions SET status = 'OVERRUN' WHERE id = v_sid;
  UPDATE leod_sessions SET status = 'CANCELLED' WHERE id = v_sid;
  IF EXISTS (SELECT 1 FROM leod_stage_messages WHERE session_id = v_sid AND cleared_at IS NULL) THEN
    RAISE EXCEPTION 'PROBE FAIL 9: OVERRUN -> CANCELLED did not clear the message';
  END IF;
  -- queued: v_sid2's 60-character message was sent while PLANNED (check 4)
  UPDATE leod_sessions SET status = 'READY' WHERE id = v_sid2;
  UPDATE leod_sessions SET status = 'CALLING' WHERE id = v_sid2;
  UPDATE leod_sessions SET status = 'LIVE' WHERE id = v_sid2;
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp, v_secret);
  RESET ROLE;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_feed->'stage_messages') m
                  WHERE m->>'session_id' = v_sid2::text AND char_length(m->>'text') = 60) THEN
    RAISE EXCEPTION 'PROBE FAIL 9: a message queued before LIVE did not show once LIVE';
  END IF;
  -- the system clears logged nothing (only the 2 sends above did)
  IF (SELECT count(*) FROM leod_event_log WHERE event_id = v_ev) <> v_n + 2
     OR EXISTS (SELECT 1 FROM leod_event_log WHERE event_id = v_ev AND action = 'STAGE_MESSAGE_CLEARED' AND operator_id IS NULL) THEN
    RAISE EXCEPTION 'PROBE FAIL 9: status-change clears wrote % log rows', (SELECT count(*) FROM leod_event_log WHERE event_id = v_ev) - v_n - 2;
  END IF;
  -- deleting a session (the nightly cleanup) still works with the trigger in place
  DELETE FROM leod_sessions WHERE id = v_sid;
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'stage_messages_clear_on_session_stop' AND prosecdef
                    AND 'search_path=public' = ANY (proconfig))
     OR has_function_privilege('authenticated', 'public.stage_messages_clear_on_session_stop()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.stage_messages_clear_on_session_stop()', 'EXECUTE') THEN
    RAISE EXCEPTION 'PROBE FAIL 9: trigger function not SECURITY DEFINER with search_path, or callable by clients';
  END IF;
  v_checks := v_checks + 1;

  -- 10. guards (security_definer_search_path also covers the trigger function)
  SELECT count(*) INTO v_n FROM checkin_guard_results()
   WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                   'security_definer_search_path', 'checkin_rpcs_refuse_strangers') AND ok;
  IF v_n <> 4 THEN
    RAISE EXCEPTION 'PROBE FAIL 10: guards %', (SELECT string_agg(guard || '=' || ok || ' ' || detail, '; ')
                                                 FROM checkin_guard_results()
                                                WHERE guard IN ('public_tables_rls_on', 'leod_writes_not_unconditional',
                                                                'security_definer_search_path', 'checkin_rpcs_refuse_strangers'));
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 128: % checks passed', v_checks;
END
$probe$;
