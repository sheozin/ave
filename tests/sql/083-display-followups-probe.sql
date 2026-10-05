-- tests/sql/083-display-followups-probe.sql
-- Run after 083. Expected: an error whose message starts with 'PROBE OK 083'.
-- Everything is rolled back by the final RAISE.
DO $probe$
DECLARE
  v_owner    uuid := gen_random_uuid();
  v_op       uuid := gen_random_uuid();   -- operator invited by v_owner
  v_other    uuid := gen_random_uuid();   -- unrelated account
  v_ev       uuid;
  v_ev2      uuid;
  v_disp     uuid;
  v_disp2    uuid;
  v_secret   text;
  v_secret2  text;
  v_new      text;
  v_res      text;
  v_poll     jsonb;
  v_ok       boolean;
  v_n        int;
  v_nonce    text := md5(random()::text) || md5(random()::text);
  v_checks   int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated'
    FROM unnest(ARRAY[v_owner, v_op, v_other]) AS u;
  -- on live, the auth.users trigger has already created the row
  INSERT INTO leod_users (id, email, role, invited_by)
  VALUES (v_op, 'probe-' || v_op || '@cuedeck-test.io', 'signage', v_owner)
  ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by;

  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 083', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 083 other', current_date + 30, '09:00', '18:00', v_other) RETURNING id INTO v_ev2;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'Probe TV')
    RETURNING id, display_secret INTO v_disp, v_secret;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev2, 'Probe other TV')
    RETURNING id, display_secret INTO v_disp2, v_secret2;
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_ev, 'PROBE-OWNER-SPONSOR');

  -- the TV asks for a code
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF display_pair_start('PRB383', v_nonce) IS DISTINCT FROM true THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 0: pair_start';
  END IF;
  RESET ROLE;

  -- 1. the invited operator can read the owner's display
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_signage_displays WHERE id = v_disp;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 1: invited operator sees % displays', v_n; END IF;
  v_checks := v_checks + 1;

  -- 2. an unrelated user cannot link the code to the owner's display, nor to
  --    a display that does not exist; the code stays free
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB383', v_disp);
  IF v_res IS DISTINCT FROM 'forbidden'
     OR display_pair_link('PRB383', gen_random_uuid()) IS DISTINCT FROM 'forbidden'
     OR display_pair_link('NOSUCH', v_disp) IS DISTINCT FROM 'forbidden' THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 2: unrelated user got %', v_res;
  END IF;
  RESET ROLE;
  -- signed in without a user id
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB383', v_disp);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'forbidden' THEN RAISE EXCEPTION 'PROBE FAIL 2: no uid got %', v_res; END IF;
  IF (SELECT display_id FROM leod_signage_pairing WHERE code = 'PRB383') IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 2: the code was linked';
  END IF;
  v_checks := v_checks + 1;

  -- 3. the invited operator links it; the row points at the display's event
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_res := display_pair_link('PRB383', v_disp);
  RESET ROLE;
  IF v_res IS DISTINCT FROM 'linked' THEN RAISE EXCEPTION 'PROBE FAIL 3: operator link returned %', v_res; END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_signage_pairing
                  WHERE code = 'PRB383' AND display_id = v_disp AND event_id = v_ev) THEN
    RAISE EXCEPTION 'PROBE FAIL 3: pairing row not linked to the display and its event';
  END IF;
  SET LOCAL ROLE anon;
  v_poll := display_pair_poll('PRB383', v_nonce);
  RESET ROLE;
  IF v_poll->>'secret' IS DISTINCT FROM v_secret THEN RAISE EXCEPTION 'PROBE FAIL 3: poll returned %', v_poll; END IF;
  v_checks := v_checks + 1;

  -- 4. reason codes: used, not_found, expired
  INSERT INTO leod_signage_pairing (code, event_id, expires_at)
  VALUES ('PRBOLD', '00000000-0000-0000-0000-000000000000', now() - interval '1 minute');
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  IF display_pair_link('PRB383', v_disp) IS DISTINCT FROM 'used'
     OR display_pair_link('PRBZZZ', v_disp) IS DISTINCT FROM 'not_found'
     OR display_pair_link(NULL, v_disp) IS DISTINCT FROM 'not_found'
     OR display_pair_link('PRBOLD', v_disp) IS DISTINCT FROM 'expired' THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 4: reason codes';
  END IF;
  RESET ROLE;
  IF (SELECT display_id FROM leod_signage_pairing WHERE code = 'PRBOLD') IS NOT NULL THEN
    RAISE EXCEPTION 'PROBE FAIL 4: an expired code was linked';
  END IF;
  v_checks := v_checks + 1;

  -- 5. an unrelated user cannot rotate the key; it is unchanged
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := display_rotate_secret(v_disp);
  RESET ROLE;
  IF v_ok IS DISTINCT FROM false
     OR (SELECT display_secret FROM leod_signage_displays WHERE id = v_disp) <> v_secret THEN
    RAISE EXCEPTION 'PROBE FAIL 5: unrelated user rotated the key';
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  SET LOCAL ROLE authenticated;
  v_ok := display_rotate_secret(v_disp);
  RESET ROLE;
  IF v_ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'PROBE FAIL 5: no uid rotated the key'; END IF;
  v_checks := v_checks + 1;

  -- 6. the invited operator rotates it: new 48-hex key, old key dead, new key
  --    works, the pairing row is gone so the nonce cannot collect the new key
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  v_ok := display_rotate_secret(v_disp);
  RESET ROLE;
  SELECT display_secret INTO v_new FROM leod_signage_displays WHERE id = v_disp;
  IF v_ok IS DISTINCT FROM true OR v_new = v_secret OR v_new !~ '^[0-9a-f]{48}$' THEN
    RAISE EXCEPTION 'PROBE FAIL 6: rotate returned %, key %', v_ok, v_new;
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF display_feed(v_disp, v_secret) IS NOT NULL
     OR display_feed(v_disp, v_new) IS NULL
     OR display_pair_poll('PRB383', v_nonce) IS NOT NULL THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 6: feed/poll after rotation';
  END IF;
  RESET ROLE;
  -- the other event's display is untouched
  IF (SELECT display_secret FROM leod_signage_displays WHERE id = v_disp2) <> v_secret2 THEN
    RAISE EXCEPTION 'PROBE FAIL 6: another display''s key changed';
  END IF;
  v_checks := v_checks + 1;

  -- 7. anon cannot call either function; PUBLIC holds nothing; authenticated can
  IF has_function_privilege('anon', 'public.display_pair_link(text,uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.display_rotate_secret(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_pair_link(text,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.display_rotate_secret(uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
                 WHERE p.proname IN ('display_pair_link', 'display_rotate_secret')
                   AND p.pronamespace = 'public'::regnamespace AND a.grantee = 0) THEN
    RAISE EXCEPTION 'PROBE FAIL 7: function grants';
  END IF;
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  BEGIN
    v_res := display_pair_link('PRB383', v_disp);
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 7: anon called display_pair_link';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  SET LOCAL ROLE anon;
  BEGIN
    v_ok := display_rotate_secret(v_disp);
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 7: anon called display_rotate_secret';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  v_checks := v_checks + 1;

  -- 8. authenticated has no direct access to pairing rows, even the owner
  IF has_table_privilege('authenticated', 'public.leod_signage_pairing', 'SELECT')
     OR has_table_privilege('authenticated', 'public.leod_signage_pairing', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.leod_signage_pairing', 'INSERT')
     OR has_table_privilege('authenticated', 'public.leod_signage_pairing', 'DELETE')
     OR has_column_privilege('authenticated', 'public.leod_signage_pairing', 'display_id', 'UPDATE')
     OR has_column_privilege('authenticated', 'public.leod_signage_pairing', 'event_id', 'UPDATE') THEN
    RAISE EXCEPTION 'PROBE FAIL 8: authenticated still holds pairing privileges';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    SELECT count(*) INTO v_n FROM leod_signage_pairing;
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 8: owner read % pairing rows', v_n;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  SET LOCAL ROLE authenticated;
  BEGIN
    UPDATE leod_signage_pairing SET display_id = v_disp WHERE code = 'PRBOLD';
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 8: owner updated a pairing row';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  SELECT count(*) INTO v_n FROM pg_policy WHERE polrelid = 'public.leod_signage_pairing'::regclass;
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 8: % policies left on pairing', v_n; END IF;
  v_checks := v_checks + 1;

  -- 9. sponsors: anon has nothing; an unrelated user can neither see nor
  --    change the owner's sponsors; the invited operator and owner can
  IF has_table_privilege('anon', 'public.leod_signage_sponsors', 'SELECT')
     OR EXISTS (SELECT 1 FROM pg_policy p
                 WHERE p.polrelid = 'public.leod_signage_sponsors'::regclass
                   AND (0::oid = ANY (p.polroles) OR 'anon'::regrole::oid = ANY (p.polroles))) THEN
    RAISE EXCEPTION 'PROBE FAIL 9: anon can still read sponsors';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_other, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_signage_sponsors WHERE event_id = v_ev;
  IF v_n <> 0 THEN RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 9: unrelated user sees % sponsors', v_n; END IF;
  UPDATE leod_signage_sponsors SET name = 'HIJACKED' WHERE event_id = v_ev;
  DELETE FROM leod_signage_sponsors WHERE event_id = v_ev;
  BEGIN
    INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_ev, 'PROBE-INJECTED');
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 9: unrelated user inserted a sponsor';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  IF NOT EXISTS (SELECT 1 FROM leod_signage_sponsors WHERE event_id = v_ev AND name = 'PROBE-OWNER-SPONSOR') THEN
    RAISE EXCEPTION 'PROBE FAIL 9: unrelated user changed the owner''s sponsor';
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_op, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_n FROM leod_signage_sponsors WHERE event_id = v_ev;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 9: invited operator sees % sponsors', v_n; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  INSERT INTO leod_signage_sponsors (event_id, name) VALUES (v_ev, 'Probe owner added');
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RESET ROLE;
  IF v_n <> 1 THEN RAISE EXCEPTION 'PROBE FAIL 9: owner could not add a sponsor'; END IF;
  v_checks := v_checks + 1;

  -- 10. the feed still carries sponsors for the TV
  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);
  SET LOCAL ROLE anon;
  IF jsonb_array_length(display_feed(v_disp, v_new)->'sponsors') <> 2 THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 10: feed sponsors';
  END IF;
  RESET ROLE;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 083: % checks passed (rolled back)', v_checks;
END
$probe$;
