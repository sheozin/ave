-- tests/sql/086-stranger-guard-probe.sql
-- Run with execute_sql or `supabase db query --linked -f`. Rolled back by the final RAISE.
-- Expected: an error whose message starts with 'PROBE OK 086'.
-- 1. A signed-in stranger cannot change event details or alert types (086).
-- 2. The owner still can.
-- 3. Guard G10 passes on the real schema and FAILS, naming the function,
--    when a writing RPC without an auth check is planted.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid(); v_out uuid := gen_random_uuid(); v_ev uuid; v_g record;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) SELECT u, 'probe-' || u || '@cuedeck-test.io', 'authenticated', 'authenticated' FROM unnest(ARRAY[v_owner, v_out]) u;
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 086', current_date + 10, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin') RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_out, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM checkin_update_event_details(v_ev, 'Renamed', NULL, NULL, NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL stranger changed event details';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM checkin_set_alert_ticket_types(v_ev, ARRAY['X']);
    RAISE EXCEPTION 'FAIL stranger set alert types';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RESET ROLE;

  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  PERFORM checkin_update_event_details(v_ev, 'Owner rename', NULL, NULL, NULL, NULL, NULL);
  PERFORM checkin_set_alert_ticket_types(v_ev, ARRAY['VIP']);
  RESET ROLE;
  IF (SELECT name FROM leod_events WHERE id = v_ev) <> 'Owner rename' THEN RAISE EXCEPTION 'FAIL owner rename'; END IF;

  PERFORM set_config('request.jwt.claims', '', true);
  SELECT * INTO v_g FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers';
  IF NOT v_g.ok THEN RAISE EXCEPTION 'FAIL G10 on the real schema: %', v_g.detail; END IF;
  EXECUTE 'CREATE FUNCTION public.checkin_zz_planted(p_event_id uuid, p_x text) RETURNS void LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public AS $f$ SELECT NULL::void $f$';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.checkin_zz_planted(uuid, text) TO authenticated';
  SELECT * INTO v_g FROM checkin_guard_results() WHERE guard = 'checkin_rpcs_refuse_strangers';
  IF v_g.ok OR v_g.detail NOT LIKE '%checkin_zz_planted%' THEN RAISE EXCEPTION 'FAIL G10 missed the planted RPC: %', v_g.detail; END IF;

  RAISE EXCEPTION 'PROBE OK 086';
END
$probe$;
