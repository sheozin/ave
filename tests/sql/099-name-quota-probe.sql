-- tests/sql/099-name-quota-probe.sql
-- Rolled back by the final RAISE. Expected: 'PROBE OK 099'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid(); v_ev uuid; v_sp uuid := gen_random_uuid(); v_dev uuid := gen_random_uuid();
  v_ok int := 0; v_r boolean; i int;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'authenticated', 'authenticated');
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 099', current_date, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin') RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_scan_points (id, event_id, name, code, kind) VALUES (v_sp, v_ev, 'Door', 'DOOR', 'entrance');
  INSERT INTO leod_checkin_devices (id, event_id, label, kind, scan_point_id, api_key_hash)
  VALUES (v_dev, v_ev, 'Door phone', 'scanner', v_sp, md5(gen_random_uuid()::text));
  FOR i IN 1..21 LOOP
    IF checkin_device_name_quota(v_dev, 20) THEN v_ok := v_ok + 1; END IF;
  END LOOP;
  IF v_ok <> 20 THEN RAISE EXCEPTION 'FAIL quota allowed % of 21', v_ok; END IF;
  UPDATE leod_checkin_devices SET name_quota_window = now() - interval '61 seconds' WHERE id = v_dev;
  IF NOT checkin_device_name_quota(v_dev, 20) THEN RAISE EXCEPTION 'FAIL window did not reset'; END IF;
  UPDATE leod_checkin_devices SET revoked_at = now() WHERE id = v_dev;
  v_r := checkin_device_name_quota(v_dev, 20);
  IF v_r IS NOT NULL THEN RAISE EXCEPTION 'FAIL revoked device got %', v_r; END IF;
  RAISE EXCEPTION 'PROBE OK 099';
END $probe$;
