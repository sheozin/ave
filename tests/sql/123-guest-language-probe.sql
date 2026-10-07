-- tests/sql/123-guest-language-probe.sql. Ends in 'PROBE OK 123'.
DO $probe$
DECLARE
  E CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v jsonb;
BEGIN
  DELETE FROM leod_checkin_web_lang WHERE event_id = E;
  UPDATE leod_checkin_entitlements SET registration_language = 'auto' WHERE event_id = E;
  PERFORM checkin_web_set_lang(E, 'Ola@Example.invalid', 'pl');
  PERFORM checkin_web_set_lang(E, 'x@example.invalid', 'xx');   -- ignored
  SELECT jsonb_object_agg(email, lang) INTO v FROM checkin_web_langs(E, ARRAY['ola@example.invalid', 'new@example.invalid', 'x@example.invalid']);
  IF v->>'ola@example.invalid' <> 'pl' OR v->>'new@example.invalid' <> 'en' OR v->>'x@example.invalid' <> 'en' THEN RAISE EXCEPTION 'auto: %', v; END IF;
  -- A fixed page language is the fallback for guests who never used the page.
  UPDATE leod_checkin_entitlements SET registration_language = 'de' WHERE event_id = E;
  SELECT jsonb_object_agg(email, lang) INTO v FROM checkin_web_langs(E, ARRAY['ola@example.invalid', 'new@example.invalid']);
  IF v->>'ola@example.invalid' <> 'pl' OR v->>'new@example.invalid' <> 'de' THEN RAISE EXCEPTION 'fixed: %', v; END IF;
  IF NOT (SELECT ok FROM checkin_guard_results() WHERE guard = 'checkin_web_paths_private') THEN RAISE EXCEPTION 'G14'; END IF;
  RAISE EXCEPTION 'PROBE OK 123';
END;
$probe$;
