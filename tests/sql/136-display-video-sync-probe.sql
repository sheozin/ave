-- tests/sql/136-display-video-sync-probe.sql. Ends in 'PROBE OK 136'.
DO $probe$
DECLARE d uuid; s text;
BEGIN
  SELECT id, display_secret INTO d, s FROM leod_signage_displays WHERE display_secret IS NOT NULL LIMIT 1;
  IF (SELECT video_sync FROM leod_signage_displays WHERE id = d) IS NOT TRUE THEN RAISE EXCEPTION 'not on by default'; END IF;
  UPDATE leod_signage_displays SET video_sync = false WHERE id = d;
  -- The screen's feed carries it.
  IF (display_feed(d, s)->'display'->>'video_sync') <> 'false' THEN RAISE EXCEPTION 'feed lacks video_sync'; END IF;
  BEGIN UPDATE leod_signage_displays SET video_sync = NULL WHERE id = d; RAISE EXCEPTION 'null accepted'; EXCEPTION WHEN not_null_violation THEN NULL; END;
  RAISE EXCEPTION 'PROBE OK 136';
END;
$probe$;
