-- ============================================================
-- CueDeck Migration 162: metered AI proxy
-- ============================================================
-- ai-proxy forwarded whatever model, max_tokens and messages the browser sent
-- to Anthropic on CueDeck's key, with no limit and no record. Its only check
-- was aiAllowed(), which passes every trial, and every new account gets a
-- ~3-day trial (49 of 51 subscriptions on 2026-11-10). One account made by a
-- person (captcha stops scripts, not people) could run Opus without end.
-- Found reviewing CueQuote's 2026-11-10 signup attack, where the same shape
-- (fresh account = free AI) was used.
--
-- The edge function now allows only the two models the app uses, caps
-- max_tokens and the payload, and takes a slot here BEFORE calling Anthropic:
-- counting afterwards lets parallel requests all pass the check.
--
-- Limits, per user: trial 15 an hour and 40 a day; paid 120 an hour and 600 a
-- day. The app's three agents make one call per user action, so a working
-- show day stays far below either.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.leod_ai_usage (
  id          BIGSERIAL   PRIMARY KEY,
  user_id     UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  event_id    UUID,
  model       TEXT        NOT NULL,
  max_tokens  INT         NOT NULL,
  trial       BOOLEAN     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leod_ai_usage_user_idx ON public.leod_ai_usage (user_id, created_at DESC);
ALTER TABLE public.leod_ai_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leod_ai_usage FROM anon, authenticated;
REVOKE ALL ON SEQUENCE public.leod_ai_usage_id_seq FROM anon, authenticated;
-- No policies on purpose: only the service role reads or writes it.

-- Takes one slot or refuses. The advisory lock serialises one user's
-- concurrent calls, so the count and the insert cannot interleave.
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
