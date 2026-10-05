-- tests/sql/098-pairing-probe.sql
-- Rolled back by the final RAISE. Expected: 'PROBE OK 098'.
DO $probe$
DECLARE
  v_owner uuid := gen_random_uuid(); v_ev uuid; v_sp uuid := gen_random_uuid(); v_n int; v_row record; v_con text;
BEGIN
  INSERT INTO auth.users (id, email, aud, role) VALUES (v_owner, 'probe-' || v_owner || '@cuedeck-test.io', 'authenticated', 'authenticated');
  INSERT INTO leod_events (name, date, event_start, event_end, timezone, created_by, created_via)
  VALUES ('Probe 098', current_date, '09:00', '18:00', 'Europe/Warsaw', v_owner, 'checkin') RETURNING id INTO v_ev;
  INSERT INTO leod_checkin_entitlements (event_id, checkin_core, status) VALUES (v_ev, true, 'test');
  INSERT INTO leod_checkin_scan_points (id, event_id, name, code, kind) VALUES (v_sp, v_ev, 'Door', 'DOOR', 'entrance');
  -- A scanner code without a scan point is refused by the table.
  BEGIN
    INSERT INTO leod_checkin_kiosk_pairing (code, event_id, label, created_by, expires_at, device_kind)
    VALUES ('PRBSCANA', v_ev, 'x', v_owner, now() + interval '5 minutes', 'scanner');
    RAISE EXCEPTION 'FAIL scanner code without scan point';
  EXCEPTION WHEN check_violation THEN
    GET STACKED DIAGNOSTICS v_con = CONSTRAINT_NAME;
    IF v_con <> 'leod_checkin_kiosk_pairing_kind_chk' THEN RAISE EXCEPTION 'FAIL wrong constraint %', v_con; END IF;
  END;
  INSERT INTO leod_checkin_kiosk_pairing (code, event_id, label, created_by, expires_at, device_kind, scan_point_id)
  VALUES ('PRBSCANB', v_ev, 'Door phone', v_owner, now() + interval '5 minutes', 'scanner', v_sp),
         ('PRBKSKCC', v_ev, 'Lobby tablet', v_owner, now() + interval '5 minutes', DEFAULT, NULL);
  -- A kiosk claim (old call shape) cannot take a scanner code...
  SELECT count(*) INTO v_n FROM checkin_kiosk_claim_pairing('PRBSCANB');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL kiosk claimed a scanner code'; END IF;
  -- ...a scanner claim can, once, and gets the scan point.
  SELECT * INTO v_row FROM checkin_kiosk_claim_pairing('PRBSCANB', 'scanner');
  IF v_row.scan_point_id IS DISTINCT FROM v_sp OR v_row.device_kind <> 'scanner' THEN RAISE EXCEPTION 'FAIL scanner claim %', v_row; END IF;
  SELECT count(*) INTO v_n FROM checkin_kiosk_claim_pairing('PRBSCANB', 'scanner');
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL claimed twice'; END IF;
  -- The kiosk flow is unchanged.
  SELECT * INTO v_row FROM checkin_kiosk_claim_pairing('PRBKSKCC');
  IF v_row.label <> 'Lobby tablet' OR v_row.device_kind <> 'kiosk' THEN RAISE EXCEPTION 'FAIL kiosk claim %', v_row; END IF;
  RAISE EXCEPTION 'PROBE OK 098';
END $probe$;
