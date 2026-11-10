-- ============================================================
-- CueDeck Migration 167: review fixes for 165 and 166
-- ============================================================
-- Commit security review, 2026-11-10:
--  * 165 suspended a cluster sharing only a name. Anyone could get a person
--    who had just signed up suspended by creating two accounts under their
--    name. Suspension now needs the same name AND the same sign-in IP (the
--    2026-11-10 attack had both; an attacker cannot take a victim's IP).
--    Name-only and IP-only clusters are still reported, never suspended, and
--    accounts a director invited are left out entirely.
--  * 166 stopped counting suspended accounts against the 300-a-day trial
--    ceiling, so a farm could trip the watch on purpose to reset it,
--    repeatedly. A hard ceiling of 600 a day that counts every account now
--    bounds the spend; 300 stays as the soft line that ignores suspended ones.
-- ============================================================

CREATE OR REPLACE FUNCTION public.signup_watch_run()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_count     INT;
  v_newest    TIMESTAMPTZ;
  v_clusters  JSONB;
  v_suspended JSONB;
BEGIN
  SELECT count(*), max(created_at) INTO v_count, v_newest
    FROM auth.users WHERE created_at > now() - interval '1 hour';

  WITH recent AS (
    SELECT u.id, u.email,
           nullif(lower(btrim(regexp_replace(coalesce(u.raw_user_meta_data->>'full_name', u.raw_user_meta_data->>'name', ''), '\s+', ' ', 'g'))), '') AS nm
      FROM auth.users u
     WHERE u.created_at > now() - interval '1 hour'
       AND u.invited_at IS NULL   -- operators a director invited are not signups
  ), by_name AS (
    SELECT 'name'::text AS kind, nm AS val, array_agg(id) AS ids, array_agg(email ORDER BY email) AS emails
      FROM recent WHERE nm IS NOT NULL GROUP BY nm HAVING count(*) >= 3
  ), by_ip AS (
    SELECT 'ip'::text, host(s.ip), array_agg(DISTINCT r.id), array_agg(DISTINCT r.email)
      FROM recent r JOIN auth.sessions s ON s.user_id = r.id
     WHERE s.ip IS NOT NULL GROUP BY s.ip HAVING count(DISTINCT r.id) >= 3
  ), by_both AS (
    -- (167) Only this suspends: same name AND same sign-in IP. A name alone can
    -- be typed by anyone (two sign-ups under a stranger's name would have
    -- suspended them), and an IP alone is a team in one office.
    SELECT 'name+ip'::text AS kind, r.nm || ' @ ' || host(s.ip) AS val, array_agg(DISTINCT r.id) AS ids, array_agg(DISTINCT r.email) AS emails
      FROM recent r JOIN auth.sessions s ON s.user_id = r.id
     WHERE r.nm IS NOT NULL AND s.ip IS NOT NULL
     GROUP BY r.nm, s.ip HAVING count(DISTINCT r.id) >= 3
  ), clusters AS (
    SELECT * FROM by_name UNION ALL SELECT * FROM by_ip UNION ALL SELECT * FROM by_both
  ), ids AS (
    SELECT u.id, string_agg(DISTINCT c.val, ', ') AS reason
      FROM by_both c CROSS JOIN LATERAL unnest(c.ids) AS u(id) GROUP BY u.id
  ), susp AS (
    UPDATE leod_users lu SET active = false
      FROM ids
     WHERE lu.id = ids.id AND lu.active IS DISTINCT FROM false
    RETURNING lu.id, lu.email, ids.reason
  ), rec AS (
    INSERT INTO leod_signup_auto_suspensions (user_id, reason)
    SELECT id, left(reason, 500) FROM susp
    ON CONFLICT (user_id) DO UPDATE SET reason = EXCLUDED.reason, suspended_at = now()
    RETURNING user_id
  )
  SELECT coalesce((SELECT jsonb_agg(jsonb_build_object('kind', kind, 'value', val, 'emails', emails)) FROM clusters), '[]'::jsonb),
         coalesce((SELECT jsonb_agg(email) FROM susp), '[]'::jsonb)
    INTO v_clusters, v_suspended;

  RETURN jsonb_build_object(
    'signups_last_hour', v_count,
    'newest_signup', v_newest,
    'clusters', v_clusters,
    'suspended', v_suspended);
END;
$function$;


CREATE OR REPLACE FUNCTION public.ai_proxy_reserve(
  p_user UUID, p_trial BOOLEAN, p_model TEXT, p_max_tokens INT, p_event_id UUID DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_hour     INT;
  v_day      INT;
  v_hour_cap INT := 120;
  v_day_cap  INT := 600;
BEGIN
  IF p_trial THEN
    v_hour_cap := 15;
    v_day_cap  := 40;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('ai_proxy_reserve:' || p_user::text));

  -- (164) All trial accounts together share one daily ceiling, so many fresh
  -- accounts cannot add up to an unbounded bill. Paid plans are not counted.
  IF p_trial THEN
    PERFORM pg_advisory_xact_lock(hashtext('ai_proxy_reserve:trials'));
    -- (167) Hard ceiling, everyone counted: without it, a farm could get
    -- itself suspended on purpose to free the soft ceiling below, again and
    -- again, and the daily spend had no bound.
    IF (SELECT count(*) FROM leod_ai_usage WHERE trial AND created_at > now() - interval '1 day') >= 600 THEN
      RETURN 'busy';
    END IF;
    -- (166) Soft ceiling: calls by suspended accounts do not count, so after a
    -- farm is contained real trials get capacity back, up to the hard ceiling.
    IF (SELECT count(*) FROM leod_ai_usage a
         WHERE a.trial AND a.created_at > now() - interval '1 day'
           AND NOT EXISTS (SELECT 1 FROM leod_users u WHERE u.id = a.user_id AND u.active = false)) >= 300 THEN
      RETURN 'busy';
    END IF;
  END IF;

  SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour'),
         count(*)
    INTO v_hour, v_day
    FROM leod_ai_usage
   WHERE user_id = p_user AND created_at > now() - interval '1 day';

  IF v_hour >= v_hour_cap THEN
    RETURN 'hour';
  END IF;
  IF v_day >= v_day_cap THEN
    RETURN 'day';
  END IF;

  INSERT INTO leod_ai_usage (user_id, event_id, model, max_tokens, trial)
  VALUES (p_user, p_event_id, p_model, p_max_tokens, p_trial);
  RETURN 'ok';
END;
$function$;

REVOKE ALL ON FUNCTION public.ai_proxy_reserve(UUID, BOOLEAN, TEXT, INT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ai_proxy_reserve(UUID, BOOLEAN, TEXT, INT, UUID) TO service_role;
