-- Probe for 138. Runs after the migration in one transaction and always
-- ends in an exception, so nothing it inserts is kept.
DO $$
DECLARE
  gtr  constant text := '58a4af56-ac32-4607-8cde-fd8996f4041b';
  dir  constant text := '59f71f02-a381-4b8d-b0a3-f4316c031ffb';   -- a GTR director
  stranger constant text := '00000000-0000-4000-8000-0000000000aa';
  ok boolean;
  n int;
BEGIN
  -- 1. A stranger cannot write into GTR's displays folder.
  PERFORM set_config('request.jwt.claims', json_build_object('sub', stranger, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('leod-assets', 'displays/' || gtr || '/probe-stranger.mp4', stranger);
    RAISE EXCEPTION 'PROBE FAIL 1: stranger insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- 2. A stranger cannot delete or overwrite GTR's existing files.
  UPDATE storage.objects SET name = name WHERE bucket_id = 'leod-assets' AND name LIKE 'displays/' || gtr || '/%';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'PROBE FAIL 2: stranger updated % rows', n; END IF;
  -- (Direct DELETE on storage.objects is blocked by Storage's own trigger;
  -- the DELETE policy uses the same helper, checked here as the stranger.)
  IF public.leod_assets_can_write('displays/' || gtr || '/x.mp4') THEN RAISE EXCEPTION 'PROBE FAIL 3: stranger passes the write check'; END IF;
  -- 4. Outside displays/ and sponsors/ nobody writes, not even a director.
  RESET ROLE;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', dir, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('leod-assets', 'anything/probe.mp4', dir);
    RAISE EXCEPTION 'PROBE FAIL 4: write outside the two prefixes allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT public.leod_assets_can_write('displays/' || gtr || '/x.mp4') THEN RAISE EXCEPTION 'PROBE FAIL 5a: director fails the write check'; END IF;
  -- 5. The GTR director can still upload a display video and a sponsor file.
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('leod-assets', 'displays/' || gtr || '/probe-dir.mp4', dir);
  INSERT INTO storage.objects (bucket_id, name, owner_id) VALUES ('leod-assets', 'sponsors/' || gtr || '/probe-dir.png', dir);
  -- 6. Anonymous readers (paired TVs) still see the files.
  RESET ROLE;
  SET LOCAL ROLE anon;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id = 'leod-assets' AND name LIKE 'displays/' || gtr || '/%';
  IF n < 1 THEN RAISE EXCEPTION 'PROBE FAIL 6: anon cannot read GTR files'; END IF;
  RESET ROLE;
  -- 7. The helper is not callable by anon.
  IF has_function_privilege('anon', 'public.leod_assets_can_write(text)', 'execute') THEN RAISE EXCEPTION 'PROBE FAIL 7: anon can execute helper'; END IF;
  RAISE EXCEPTION 'PROBE OK 138 (anon sees % GTR display files)', n;
END $$;
