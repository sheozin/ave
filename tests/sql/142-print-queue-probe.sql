-- tests/sql/142-print-queue-probe.sql. Ends in 'PROBE OK 142'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  PNG   CONSTANT text := 'data:image/png;base64,iVBORw0KGgo=';
  v_own uuid; v_dev uuid; v_kiosk uuid; v_ids uuid[]; v_n int; v_r record;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash) VALUES (E, 'Probe printer', 'printer', md5(random()::text) || md5(random()::text)) RETURNING id INTO v_dev;
  INSERT INTO leod_checkin_devices (event_id, label, kind, api_key_hash) VALUES (E, 'Probe kiosk', 'kiosk', md5(random()::text) || md5(random()::text)) RETURNING id INTO v_kiosk;

  -- Nobody outside the event queues or lists.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_queue_print(E, v_dev, jsonb_build_array(jsonb_build_object('png', PNG, 'cut_mm', 76))); RAISE EXCEPTION 'stranger queued'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN PERFORM * FROM checkin_print_stations(E); RAISE EXCEPTION 'stranger listed'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  IF checkin_role_for_event(E) IS NULL THEN RAISE EXCEPTION 'owner has no role on the probe event'; END IF;
  -- Only a printer of this event, only real PNG data URLs, sane lengths.
  BEGIN PERFORM checkin_queue_print(E, v_kiosk, jsonb_build_array(jsonb_build_object('png', PNG, 'cut_mm', 76))); RAISE EXCEPTION 'kiosk took a job'; EXCEPTION WHEN SQLSTATE 'P0002' THEN NULL; END;
  BEGIN PERFORM checkin_queue_print(E, v_dev, jsonb_build_array(jsonb_build_object('png', 'javascript:alert(1)', 'cut_mm', 76))); RAISE EXCEPTION 'bad png'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN PERFORM checkin_queue_print(E, v_dev, jsonb_build_array(jsonb_build_object('png', PNG, 'cut_mm', 5))); RAISE EXCEPTION 'bad cut'; EXCEPTION WHEN SQLSTATE '22023' THEN NULL; END;
  BEGIN PERFORM checkin_queue_print(E, v_dev, jsonb_build_array(jsonb_build_object('png', PNG, 'cut_mm', 76, 'attendee_id', gen_random_uuid()))); RAISE EXCEPTION 'foreign attendee'; EXCEPTION WHEN raise_exception THEN NULL; END;

  v_ids := checkin_queue_print(E, v_dev, jsonb_build_array(jsonb_build_object('png', PNG, 'cut_mm', 76), jsonb_build_object('png', PNG, 'cut_mm', 100)));
  IF array_length(v_ids, 1) <> 2 THEN RAISE EXCEPTION 'queued %', v_ids; END IF;
  SELECT count(*) INTO v_n FROM checkin_print_stations(E) WHERE id = v_dev AND NOT online;
  IF v_n <> 1 THEN RAISE EXCEPTION 'station list'; END IF;

  -- The station claims both once, oldest first; a second claim gets nothing.
  PERFORM set_config('request.jwt.claims', '', true);
  SELECT count(*) INTO v_n FROM checkin_print_claim(v_dev, 5) c WHERE c.label_png = PNG;
  IF v_n <> 2 THEN RAISE EXCEPTION 'claimed %', v_n; END IF;
  SELECT count(*) INTO v_n FROM checkin_print_claim(v_dev, 5);
  IF v_n <> 0 THEN RAISE EXCEPTION 'claimed twice'; END IF;
  IF NOT checkin_print_finish(v_dev, v_ids[1], true, NULL) THEN RAISE EXCEPTION 'finish ok'; END IF;
  IF NOT checkin_print_finish(v_dev, v_ids[2], false, 'Cover open') THEN RAISE EXCEPTION 'finish fail'; END IF;
  IF checkin_print_finish(v_dev, v_ids[2], true, NULL) THEN RAISE EXCEPTION 'finished twice'; END IF;
  SELECT * INTO v_r FROM leod_checkin_print_jobs WHERE id = v_ids[2];
  IF v_r.status <> 'failed' OR v_r.error <> 'Cover open' OR v_r.label_png IS NOT NULL THEN RAISE EXCEPTION 'failed row %', v_r; END IF;
  IF (SELECT label_png FROM leod_checkin_print_jobs WHERE id = v_ids[1]) IS NOT NULL THEN RAISE EXCEPTION 'image kept after print'; END IF;

  -- Stale work expires and loses its image; a taken job is failed, never requeued.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_ids := checkin_queue_print(E, v_dev, jsonb_build_array(jsonb_build_object('png', PNG, 'cut_mm', 76), jsonb_build_object('png', PNG, 'cut_mm', 76)));
  UPDATE leod_checkin_print_jobs SET created_at = now() - interval '11 minutes' WHERE id = v_ids[1];
  UPDATE leod_checkin_print_jobs SET status = 'printing', claimed_at = now() - interval '3 minutes' WHERE id = v_ids[2];
  PERFORM checkin_print_expire(NULL);
  IF (SELECT count(*) FROM leod_checkin_print_jobs WHERE id = ANY(v_ids) AND status = 'failed' AND label_png IS NULL) <> 2 THEN RAISE EXCEPTION 'expiry'; END IF;

  -- Desks may read status, never the image; anon nothing.
  IF has_column_privilege('authenticated', 'leod_checkin_print_jobs', 'label_png', 'SELECT') THEN RAISE EXCEPTION 'image readable'; END IF;
  IF NOT has_column_privilege('authenticated', 'leod_checkin_print_jobs', 'status', 'SELECT') THEN RAISE EXCEPTION 'status unreadable'; END IF;
  IF has_table_privilege('anon', 'leod_checkin_print_jobs', 'SELECT') OR has_table_privilege('authenticated', 'leod_checkin_print_jobs', 'INSERT') THEN RAISE EXCEPTION 'grants'; END IF;
  IF has_function_privilege('authenticated', 'checkin_print_claim(uuid, integer)', 'EXECUTE') THEN RAISE EXCEPTION 'claim open'; END IF;
  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-print-expire') THEN RAISE EXCEPTION 'no cron'; END IF;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE EXCEPTION 'PROBE OK 142';
END;
$probe$;
