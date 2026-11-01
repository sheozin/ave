-- tests/sql/145-pair-global-limits-probe.sql. Ends in 'PROBE OK 145'.
DO $probe$
BEGIN
  DELETE FROM leod_checkin_pair_failures;
  IF NOT checkin_pair_global_ok() THEN RAISE EXCEPTION 'empty ceiling refused'; END IF;
  INSERT INTO leod_checkin_pair_failures (failed_at) SELECT now() FROM generate_series(1, 4999);
  IF NOT checkin_pair_global_ok() THEN RAISE EXCEPTION '4999 refused'; END IF;
  PERFORM checkin_pair_note_failure();
  IF checkin_pair_global_ok() THEN RAISE EXCEPTION '5000 failures still allowed'; END IF;
  -- Old failures age out.
  UPDATE leod_checkin_pair_failures SET failed_at = now() - interval '11 minutes';
  IF NOT checkin_pair_global_ok() THEN RAISE EXCEPTION 'old failures still counted'; END IF;
  IF NOT checkin_print_request_ok() THEN RAISE EXCEPTION 'request ceiling with few waiting'; END IF;
  IF has_function_privilege('anon', 'checkin_pair_note_failure()', 'EXECUTE') OR has_table_privilege('authenticated', 'leod_checkin_pair_failures', 'SELECT') THEN RAISE EXCEPTION 'open to clients'; END IF;
  RAISE EXCEPTION 'PROBE OK 145';
END;
$probe$;
