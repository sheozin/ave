-- ============================================================
-- CueDeck Migration 166: suspended accounts stop counting against the trial ceiling
-- ============================================================
-- 164's shared ceiling (300 trial AI calls a day) bounds the bill, but a few
-- trial accounts could use it all and leave real trial users with no AI for a
-- day (commit security review, 2026-11-10: shared quota exhaustion). The
-- ceiling stays; calls made by accounts that are now suspended
-- (leod_users.active = false, set by signup-watch for clusters or by an admin)
-- no longer count, so containment gives the capacity back at once.
-- ============================================================

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
    -- (166) Calls by suspended accounts do not count: once signup-watch or an
    -- admin suspends a farm, the capacity it used is back for real trials.
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
