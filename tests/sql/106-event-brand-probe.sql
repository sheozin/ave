-- tests/sql/106-event-brand-probe.sql: Branding colour reaches leod_events. Ends in 'PROBE OK 106'.
DO $probe$
DECLARE
  E CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  PERFORM checkin_set_registration_page(E, 'Host', NULL, NULL, '#0F766E', NULL, NULL, false);
  IF (SELECT brand_color FROM leod_events WHERE id = E) <> '#0F766E' THEN RAISE EXCEPTION 'event colour not synced'; END IF;
  PERFORM checkin_set_registration_page(E, 'Host', NULL, NULL, NULL, NULL, NULL, false);
  IF (SELECT brand_color FROM leod_events WHERE id = E) <> '#0F766E' THEN RAISE EXCEPTION 'clearing the page colour cleared the event colour'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM checkin_set_registration_page(E, 'X', NULL, NULL, '#000000', NULL, NULL, false);
    RAISE EXCEPTION 'stranger allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE EXCEPTION 'PROBE OK 106';
END;
$probe$;
