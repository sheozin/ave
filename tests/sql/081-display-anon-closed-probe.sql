-- tests/sql/081-display-anon-closed-probe.sql
-- Run after 081. Expected: an error whose message starts with 'PROBE OK 081'.
DO $probe$
DECLARE
  v_owner  uuid := gen_random_uuid();
  v_ev     uuid;
  v_disp   uuid;
  v_secret text;
  v_n      int;
  v_checks int := 0;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
  VALUES (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'authenticated', 'authenticated');
  INSERT INTO leod_events (name, date, event_start, event_end, created_by)
  VALUES ('Probe 081', current_date + 30, '09:00', '18:00', v_owner) RETURNING id INTO v_ev;
  INSERT INTO leod_signage_displays (event_id, name) VALUES (v_ev, 'Probe TV')
    RETURNING id, display_secret INTO v_disp, v_secret;
  INSERT INTO leod_signage_pairing (code, event_id, expires_at) VALUES ('PRB281', v_ev, now() + interval '5 minutes');

  PERFORM set_config('request.jwt.claims', '{"role":"anon"}', true);

  -- 1. anon cannot read displays
  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO v_n FROM leod_signage_displays;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 1: anon sees % displays', v_n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  v_checks := v_checks + 1;

  -- 2. anon cannot read pairing rows
  SET LOCAL ROLE anon;
  BEGIN
    SELECT count(*) INTO v_n FROM leod_signage_pairing;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 2: anon sees % pairing rows', v_n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  v_checks := v_checks + 1;

  -- 3. anon cannot write pairing rows or heartbeat displays directly
  SET LOCAL ROLE anon;
  BEGIN
    INSERT INTO leod_signage_pairing (code, event_id, expires_at) VALUES ('PRB282', v_ev, now() + interval '5 minutes');
    RESET ROLE;
    RAISE EXCEPTION 'PROBE FAIL 3: anon inserted a pairing row';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  SET LOCAL ROLE anon;
  BEGIN
    UPDATE leod_signage_pairing SET display_id = v_disp WHERE code = 'PRB281';
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 3: anon linked a pairing row'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  SET LOCAL ROLE anon;
  BEGIN
    UPDATE leod_signage_displays SET last_seen_at = now() WHERE id = v_disp;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RESET ROLE;
    IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 3: anon heartbeat still works'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  v_checks := v_checks + 1;

  -- 4. no anon policy left on either table
  SELECT count(*) INTO v_n FROM pg_policy p
   WHERE p.polrelid IN ('public.leod_signage_displays'::regclass, 'public.leod_signage_pairing'::regclass)
     AND (0::oid = ANY (p.polroles) OR 'anon'::regrole::oid = ANY (p.polroles));
  IF v_n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 4: % anon/PUBLIC policies left', v_n; END IF;
  v_checks := v_checks + 1;

  -- 5. the feed still works for anon
  SET LOCAL ROLE anon;
  IF display_feed(v_disp, v_secret) IS NULL THEN
    RESET ROLE; RAISE EXCEPTION 'PROBE FAIL 5: feed broken after 081';
  END IF;
  RESET ROLE;
  v_checks := v_checks + 1;

  -- 6. clock stays readable for anon
  SET LOCAL ROLE anon;
  PERFORM 1 FROM leod_clock LIMIT 1;
  RESET ROLE;
  v_checks := v_checks + 1;

  RAISE EXCEPTION 'PROBE OK 081: % checks passed (rolled back)', v_checks;
END
$probe$;
