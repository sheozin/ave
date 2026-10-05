-- tests/sql/073-owner-probe.sql
-- Expected: an error whose message starts with 'PROBE OK 073'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid();
  v_org   uuid := gen_random_uuid();
  v_ev    uuid;
  v_role  text;
  v_own   boolean;
BEGIN
  INSERT INTO auth.users (id, email, aud, role, raw_user_meta_data)
  SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated', '{"checkin_staff":"true"}'::jsonb
    FROM unnest(ARRAY[v_owner, v_org]) AS u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 073', current_date + 30, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin') RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_operators (event_id, user_id, role) VALUES (v_ev, v_org, 'organizer');

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT role, is_owner INTO v_role, v_own FROM checkin_my_events() WHERE event_id = v_ev;
  RESET ROLE;
  IF v_role IS DISTINCT FROM 'owner' OR v_own IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'PROBE FAIL: owner row is (%, %)', v_role, v_own;
  END IF;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_org, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  SELECT role, is_owner INTO v_role, v_own FROM checkin_my_events() WHERE event_id = v_ev;
  RESET ROLE;
  IF v_role IS DISTINCT FROM 'organizer' OR v_own IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'PROBE FAIL: organizer row is (%, %)', v_role, v_own;
  END IF;

  RAISE EXCEPTION 'PROBE OK 073: 2 checks passed (rolled back)';
END
$probe$;
