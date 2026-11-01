-- tests/sql/146-downloads-bucket-probe.sql. Ends in 'PROBE OK 146'.
DO $probe$
DECLARE v_n int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'downloads' AND public AND file_size_limit >= 200 * 1024 * 1024) THEN RAISE EXCEPTION 'bucket'; END IF;
  -- No client policy may write to it.
  SELECT count(*) INTO v_n FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects' AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
     AND (coalesce(qual, '') || coalesce(with_check, '')) ~ '''downloads''';
  IF v_n > 0 THEN RAISE EXCEPTION 'a policy writes to downloads'; END IF;
  RAISE EXCEPTION 'PROBE OK 146';
END;
$probe$;
