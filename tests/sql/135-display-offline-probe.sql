-- tests/sql/135-display-offline-probe.sql. Ends in 'PROBE OK 135'.
DO $probe$
DECLARE d uuid; s text;
BEGIN
  SELECT id, display_secret INTO d, s FROM leod_signage_displays WHERE display_secret IS NOT NULL LIMIT 1;
  IF display_report_offline(d, 'wrong-key', '{"shell":true,"data":true,"video":"saved"}') THEN RAISE EXCEPTION 'wrong key accepted'; END IF;
  IF display_report_offline(d, NULL, '{"shell":true}') THEN RAISE EXCEPTION 'null key accepted'; END IF;
  IF display_report_offline(d, s, '{"shell":true,"evil":"x"}') THEN RAISE EXCEPTION 'unknown key accepted'; END IF;
  IF display_report_offline(d, s, '{"video":"<script>"}') THEN RAISE EXCEPTION 'bad video state accepted'; END IF;
  IF display_report_offline(d, s, ('{"shell":true,"bytes":1,"total":' || repeat('9', 600) || '}')::jsonb) THEN RAISE EXCEPTION 'oversize accepted'; END IF;
  IF NOT display_report_offline(d, s, '{"shell":true,"data":true,"video":"saving","bytes":10,"total":100}') THEN RAISE EXCEPTION 'good report refused'; END IF;
  IF (SELECT offline_status->>'video' FROM leod_signage_displays WHERE id = d) <> 'saving' THEN RAISE EXCEPTION 'not stored'; END IF;
  IF (SELECT offline_reported_at FROM leod_signage_displays WHERE id = d) < now() - interval '1 minute' THEN RAISE EXCEPTION 'time not stored'; END IF;
  -- The anon role can call it (screens use the publishable key) and nothing else changed.
  IF NOT has_function_privilege('anon', 'display_report_offline(uuid,text,jsonb)', 'execute') THEN RAISE EXCEPTION 'anon cannot report'; END IF;
  RAISE EXCEPTION 'PROBE OK 135';
END;
$probe$;
