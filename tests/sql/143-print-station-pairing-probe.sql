-- tests/sql/143-print-station-pairing-probe.sql. Ends in 'PROBE OK 143'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  H     CONSTANT text := encode(sha256('probe-station-key-143'::bytea), 'hex');
  v_own uuid; v_r record; v_n int;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  INSERT INTO leod_checkin_device_requests (code, key_hash, kind, info, expires_at)
  VALUES ('ABCDEFGH', H, 'printer', '{"model":"zebra","dpi":300,"width_mm":104}', now() + interval '30 minutes');
  BEGIN INSERT INTO leod_checkin_device_requests (code, key_hash, kind, expires_at) VALUES ('ABCDEFG0', H, 'printer', now()); RAISE EXCEPTION 'ambiguous code accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  -- One approval makes one printer device holding the station's key hash.
  SELECT * INTO v_r FROM checkin_approve_device_request('ABCDEFGH', E, '  Desk printer ', v_own);
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_devices WHERE id = v_r.device_id AND event_id = E AND kind = 'printer' AND api_key_hash = H
                  AND label = 'Desk printer' AND printer_info->>'model' = 'zebra') THEN RAISE EXCEPTION 'device not made'; END IF;
  BEGIN PERFORM checkin_approve_device_request('ABCDEFGH', E, 'Again', v_own); RAISE EXCEPTION 'approved twice'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
  INSERT INTO leod_checkin_device_requests (code, key_hash, kind, expires_at) VALUES ('ZZZZ2222', encode(sha256('other'::bytea), 'hex'), 'printer', now() - interval '1 minute');
  BEGIN PERFORM checkin_approve_device_request('ZZZZ2222', E, 'Late', v_own); RAISE EXCEPTION 'expired approved'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
  -- Clients never touch requests; approve is service-role only.
  IF has_table_privilege('authenticated', 'leod_checkin_device_requests', 'SELECT') OR has_table_privilege('anon', 'leod_checkin_device_requests', 'INSERT') THEN RAISE EXCEPTION 'requests open'; END IF;
  IF has_function_privilege('authenticated', 'checkin_approve_device_request(text, uuid, text, uuid)', 'EXECUTE') THEN RAISE EXCEPTION 'approve open'; END IF;
  -- The stations list carries what the printer is.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  SELECT count(*) INTO v_n FROM checkin_print_stations(E) s WHERE s.id = v_r.device_id AND s.online AND s.printer_info->>'model' = 'zebra' AND s.printed_today = 0;
  IF v_n <> 1 THEN RAISE EXCEPTION 'stations list'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE EXCEPTION 'PROBE OK 143';
END;
$probe$;
