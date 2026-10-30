-- tests/sql/141-badge-stock-tags-probe.sql. Ends in 'PROBE OK 141'.
DO $probe$
DECLARE
  E     CONSTANT uuid := '42084f53-6d79-4565-8866-c0e520839ea4';
  v_own uuid;
  v_res jsonb;
BEGIN
  SELECT created_by INTO v_own FROM leod_events WHERE id = E;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_own, 'role', 'authenticated')::text, true);
  v_res := checkin_set_badge_design(E, '{"w":105,"h":148,"title":true,"slot":"holes","colors":{"Speaker":"#1f4ed8"},"tags":{"Speaker":"  SPEAKER ","Press":"","VIP":"vip"}}');
  IF NOT (v_res->>'title')::boolean OR v_res->>'slot' <> 'holes' OR v_res->'tags'->>'Speaker' <> 'SPEAKER'
     OR v_res->'tags' ? 'Press' OR v_res->'tags'->>'VIP' <> 'vip' THEN RAISE EXCEPTION 'normalized: %', v_res; END IF;
  v_res := checkin_set_badge_design(E, '{"w":100,"h":70,"slot":"<b>"}');
  IF v_res->>'slot' <> 'none' OR (v_res->>'title')::boolean OR v_res->'tags' <> '{}'::jsonb THEN RAISE EXCEPTION 'defaults: %', v_res; END IF;
  v_res := checkin_set_badge_design(E, '{"template":"visa-next-full","w":10,"h":10}');
  IF v_res->>'template' <> 'visa-next-full' OR (v_res->>'w')::int <> 76 OR (v_res->>'h')::int <> 62 THEN RAISE EXCEPTION 'template: %', v_res; END IF;
  v_res := checkin_set_badge_design(E, '{"template":"other","w":100,"h":70}');
  IF v_res->'template' <> 'null'::jsonb THEN RAISE EXCEPTION 'unknown template kept: %', v_res; END IF;
  BEGIN PERFORM checkin_set_badge_design(E, '{"w":100,"h":70,"tags":{"VIP":"a tag that is far too long for a ribbon"}}'); RAISE EXCEPTION 'long tag accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM checkin_set_badge_design(E, jsonb_build_object('w',100,'h',70,'tags',jsonb_build_object('VIP', 'a' || chr(10) || 'b'))); RAISE EXCEPTION 'control char accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  BEGIN PERFORM checkin_set_badge_design(E, '{"w":100,"h":70}'); RAISE EXCEPTION 'stranger saved'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  PERFORM set_config('request.jwt.claims', '', true);
  RAISE EXCEPTION 'PROBE OK 141';
END;
$probe$;
