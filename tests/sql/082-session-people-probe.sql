-- tests/sql/082-session-people-probe.sql
-- Run after 082. Expected: an error whose message starts with 'PROBE OK 082'.
-- Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner   uuid := gen_random_uuid();
  v_ev      uuid;
  v_disp    uuid;
  v_secret  text;
  v_feed    jsonb;
  v_ok      boolean;
  v_checks  int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  VALUES (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'authenticated', 'authenticated');
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 082', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;

  -- 1. a session inserted without people gets '[]'
  INSERT INTO leod_sessions (event_id, sort_order, title, speaker,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 1, 'Probe keynote', 'Speaker A', '09:00', '10:00', '09:00', '10:00');
  IF (SELECT people FROM leod_sessions WHERE event_id = v_ev AND sort_order = 1) <> '[]'::jsonb THEN
    RAISE EXCEPTION 'PROBE FAIL 1: default people is not []';
  END IF;
  v_checks := v_checks + 1;

  -- 2. a panel keeps its people in order
  INSERT INTO leod_sessions (event_id, sort_order, title, speaker, people,
                             planned_start, planned_end, scheduled_start, scheduled_end)
  VALUES (v_ev, 2, 'Probe panel', 'Jane Smith (moderator), Ahmed Ali',
          '[{"name":"Jane Smith","company":"Contoso","role":"moderator"},
            {"name":"Ahmed Ali","company":null,"role":"panelist"}]',
          '10:00', '11:00', '10:00', '11:00');
  v_checks := v_checks + 1;

  -- 3. a non-array people is refused
  v_ok := false;
  BEGIN
    UPDATE leod_sessions SET people = '{"name":"x"}' WHERE event_id = v_ev AND sort_order = 1;
  EXCEPTION WHEN check_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'PROBE FAIL 3: object accepted as people'; END IF;
  v_ok := false;
  BEGIN
    UPDATE leod_sessions SET people = NULL WHERE event_id = v_ev AND sort_order = 1;
  EXCEPTION WHEN not_null_violation THEN v_ok := true;
  END;
  IF NOT v_ok THEN RAISE EXCEPTION 'PROBE FAIL 3: NULL accepted as people'; END IF;
  v_checks := v_checks + 1;

  -- 4. anon display_feed carries people, in order, and [] for plain sessions;
  --    the event carries date and timezone
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'Probe TV')
    RETURNING id, display_secret INTO v_disp, v_secret;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  v_feed := display_feed(v_disp, v_secret);
  RESET ROLE;
  IF v_feed IS NULL
     OR v_feed->'sessions'->0->'people' <> '[]'::jsonb
     OR v_feed->'sessions'->1->'people'->0->>'name' <> 'Jane Smith'
     OR v_feed->'sessions'->1->'people'->0->>'role' <> 'moderator'
     OR v_feed->'sessions'->1->'people'->1->>'name' <> 'Ahmed Ali'
     OR v_feed->'sessions'->1->>'speaker' <> 'Jane Smith (moderator), Ahmed Ali'
     OR v_feed->'sessions'->1 ? 'notes'
     OR v_feed->'event'->>'date' <> (current_date + 30)::text
     OR v_feed->'event'->>'timezone' IS NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 4: feed is %', v_feed;
  END IF;
  v_checks := v_checks + 1;

  -- 5. grants unchanged: anon and authenticated, not PUBLIC
  IF NOT (has_function_privilege('anon', 'public.display_feed(uuid,text)', 'EXECUTE')
      AND has_function_privilege('authenticated', 'public.display_feed(uuid,text)', 'EXECUTE'))
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.proname = 'display_feed'
                   AND p.pronamespace = 'public'::regnamespace AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PROBE FAIL 5: display_feed grants';
  END IF;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 082: % checks passed (rolled back)', v_checks;
END
$probe$;
