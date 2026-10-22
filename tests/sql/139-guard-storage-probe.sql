-- Probe for 139: G21 passes on today's policies and fails on the pre-138 one.
DO $$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM checkin_guard_results() WHERE guard = 'storage_writes_scoped';
  IF r IS NULL OR NOT r.ok THEN RAISE EXCEPTION 'PROBE FAIL 1: %', coalesce(r.detail, 'guard missing'); END IF;
  CREATE POLICY probe_open_all ON storage.objects FOR ALL TO authenticated
    USING (bucket_id = 'leod-assets') WITH CHECK (bucket_id = 'leod-assets');
  SELECT * INTO r FROM checkin_guard_results() WHERE guard = 'storage_writes_scoped';
  IF r.ok THEN RAISE EXCEPTION 'PROBE FAIL 2: open policy not caught'; END IF;
  IF has_function_privilege('anon', 'public.checkin_guard_results()', 'execute')
     OR has_function_privilege('authenticated', 'public.checkin_guard_results()', 'execute') THEN
    RAISE EXCEPTION 'PROBE FAIL 3: guard function callable by clients';
  END IF;
  RAISE EXCEPTION 'PROBE OK 139 (%)', r.detail;
END $$;
