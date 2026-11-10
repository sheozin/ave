-- ============================================================
-- CueDeck Migration 164: one daily AI ceiling shared by all trial accounts
-- ============================================================
-- 162 limits each user (trial 15/h, 40/day), but every new account is a new
-- trial, so a batch of accounts multiplied the limit (commit security review,
-- 2026-11-10: rate-limit bypass). Trial calls across ALL accounts now stop at
-- 300 a day; ai-proxy answers 'busy' with the hourly message. Paid plans are
-- outside the ceiling. The two locks are always taken user first, then the
-- shared one, so concurrent calls cannot deadlock.
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
    IF (SELECT count(*) FROM leod_ai_usage WHERE trial AND created_at > now() - interval '1 day') >= 300 THEN
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
