-- tests/sql/104-registration-page-probe.sql
-- Probe for migration 104 (registration page design). Ends in 'PROBE OK 104'.
DO $probe$
DECLARE
  E      CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own  uuid;
  v_res  jsonb;
  v_ok   boolean;
  v_bad  jsonb;
  v_ok_name text;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;

  -- A stranger cannot edit the page, and checkin_can_edit_page says false.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  IF checkin_can_edit_page(E) THEN RAISE EXCEPTION 'stranger can edit'; END IF;
  BEGIN
    PERFORM checkin_set_registration_page(E, 'X', NULL, NULL, NULL, NULL, NULL, false);
    RAISE EXCEPTION 'stranger set the page';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- The owner sets it; values are trimmed; blanks become NULL.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  IF NOT checkin_can_edit_page(E) THEN RAISE EXCEPTION 'owner cannot edit'; END IF;
  v_res := checkin_set_registration_page(E, ' Northwind Events ', 'A day of talks.', ' ', '#1F4ED8',
             E::text || '/cover-abcdef12.jpg', E::text || '/logo-abcdef12.png', true);
  IF v_res->>'host_name' <> 'Northwind Events' OR v_res->>'address' IS NOT NULL OR (v_res->>'show_programme')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'set: %', v_res;
  END IF;

  -- Bad values are refused with 22023.
  FOREACH v_bad IN ARRAY ARRAY[
    jsonb_build_array('color', 'blue'),
    jsonb_build_array('cover', gen_random_uuid()::text || '/cover-abcdef12.jpg'),
    jsonb_build_array('cover', E::text || '/cover-abcdef12.svg'),
    jsonb_build_array('logo', E::text || '/../x/logo-abcdef12.png'),
    jsonb_build_array('host', repeat('h', 81))] LOOP
    BEGIN
      PERFORM checkin_set_registration_page(E,
        CASE WHEN v_bad->>0 = 'host' THEN v_bad->>1 ELSE 'N' END, NULL, NULL,
        CASE WHEN v_bad->>0 = 'color' THEN v_bad->>1 ELSE '#000000' END,
        CASE WHEN v_bad->>0 = 'cover' THEN v_bad->>1 END,
        CASE WHEN v_bad->>0 = 'logo' THEN v_bad->>1 END, false);
      RAISE EXCEPTION 'accepted bad %', v_bad;
    EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
  END LOOP;

  -- Storage: the owner may insert under their event with a good name;
  -- a stranger may not; a bad name or another event's folder is refused.
  SET LOCAL ROLE authenticated;
  -- RETURNING, as Supabase Storage does: SELECT policies apply to the returned row (107).
  INSERT INTO storage.objects (bucket_id, name) VALUES ('checkin-public', E::text || '/cover-probe1234.jpg') RETURNING name INTO v_ok_name;
  IF v_ok_name IS NULL THEN RAISE EXCEPTION 'upload not returned'; END IF;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('checkin-public', E::text || '/cover-x.svg');
    RAISE EXCEPTION 'bad name accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('checkin-public', gen_random_uuid()::text || '/cover-probe1234.jpg');
    RAISE EXCEPTION 'other event folder accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN
    INSERT INTO storage.objects (bucket_id, name) VALUES ('checkin-public', E::text || '/cover-probe5678.jpg');
    RAISE EXCEPTION 'stranger uploaded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  -- A stranger sees nothing in the bucket, not even this event's upload.
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id = 'checkin-public') THEN RAISE EXCEPTION 'bucket listable by a stranger'; END IF;
  RESET ROLE;

  SELECT bool_and(ok) INTO v_ok FROM checkin_guard_results();
  IF v_ok IS NOT TRUE THEN
    RAISE EXCEPTION 'guards: %', (SELECT string_agg(guard || ': ' || detail, ' | ') FROM checkin_guard_results() WHERE NOT ok);
  END IF;
  RAISE EXCEPTION 'PROBE OK 104';
END;
$probe$;
