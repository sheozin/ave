-- tests/sql/134-display-video-probe.sql. Ends in 'PROBE OK 134'.
DO $probe$
DECLARE d uuid;
BEGIN
  SELECT id INTO d FROM leod_signage_displays LIMIT 1;
  IF d IS NULL THEN RAISE EXCEPTION 'no display to test with'; END IF;
  UPDATE leod_signage_displays SET content_mode = 'video', video_url = 'https://example.com/a.mp4' WHERE id = d;
  BEGIN UPDATE leod_signage_displays SET video_url = 'javascript:alert(1)' WHERE id = d; RAISE EXCEPTION 'bad url accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE leod_signage_displays SET video_url = 'http://example.com/a.mp4' WHERE id = d; RAISE EXCEPTION 'http accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE leod_signage_displays SET content_mode = 'nope' WHERE id = d; RAISE EXCEPTION 'bad mode accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  -- The screen's feed carries the new column.
  IF NOT (SELECT (display_feed(d, display_secret)->'display') ? 'video_url' FROM leod_signage_displays WHERE id = d) THEN RAISE EXCEPTION 'feed lacks video_url'; END IF;
  RAISE EXCEPTION 'PROBE OK 134';
END;
$probe$;
