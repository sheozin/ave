-- ============================================================
-- CueDeck Migration 165: signup watch (alert + automatic suspension)
-- ============================================================
-- On 2026-11-10 CueQuote took five signups in eleven minutes from one IP, all
-- named "ahmed said". CueDeck's Auth enforces the captcha, so that script
-- could not have made an account here, but nothing in CueDeck would have
-- noticed a burst made by people or a captcha-solving service: no signup
-- alert existed, and the brain sensors that read checkin_guard_results are
-- not being read.
--
-- signup_watch_run() is called every 10 minutes by the signup-watch function:
--   * a CLUSTER is 3+ accounts created in the last hour sharing a full name,
--     or sharing a sign-in IP (auth.sessions.ip; unconfirmed accounts have no
--     session, and cannot do anything until they confirm);
--   * cluster accounts are suspended (leod_users.active = false), which an
--     admin undoes with Reactivate in the admin dashboard. Only accounts this
--     function actually suspended are recorded, so a reactivation is never
--     overridden by a record of ours and an earlier admin suspension is never
--     claimed as ours;
--   * the report (signup count, clusters, who was suspended) goes back to the
--     function, which emails it when there are 5+ signups in the hour or any
--     cluster. leod_signup_watch_alerts keys each alert so one burst is not
--     emailed twice.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.leod_signup_watch_alerts (
  alert_key TEXT        PRIMARY KEY,
  sent_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.leod_signup_auto_suspensions (
  user_id      UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  reason       TEXT        NOT NULL,
  suspended_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.leod_signup_watch_alerts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leod_signup_auto_suspensions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.leod_signup_watch_alerts, public.leod_signup_auto_suspensions FROM anon, authenticated;
-- No policies on purpose: only the service role reads or writes these.

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
  ), by_name AS (
    SELECT 'name'::text AS kind, nm AS val, array_agg(id) AS ids, array_agg(email ORDER BY email) AS emails
      FROM recent WHERE nm IS NOT NULL GROUP BY nm HAVING count(*) >= 3
  ), by_ip AS (
    SELECT 'ip'::text, host(s.ip), array_agg(DISTINCT r.id), array_agg(DISTINCT r.email)
      FROM recent r JOIN auth.sessions s ON s.user_id = r.id
     WHERE s.ip IS NOT NULL GROUP BY s.ip HAVING count(DISTINCT r.id) >= 3
  ), clusters AS (
    SELECT * FROM by_name UNION ALL SELECT * FROM by_ip
  ), ids AS (
    SELECT u.id, string_agg(DISTINCT c.kind || ':' || c.val, ', ') AS reason
      FROM clusters c CROSS JOIN LATERAL unnest(c.ids) AS u(id) GROUP BY u.id
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

REVOKE ALL ON FUNCTION public.signup_watch_run() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.signup_watch_run() TO service_role;

-- Every 10 minutes, with the cron secret the welcome-emails job already uses
-- (checked by welcome_emails_cron_ok, migration 140).
SELECT cron.unschedule('signup-watch') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'signup-watch');
SELECT cron.schedule('signup-watch', '*/10 * * * *', $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/signup-watch',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'welcome_emails_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000);
$cron$);

-- Registered so a watcher that stops running is reported stale, not silent.
INSERT INTO public.leod_checkin_jobs (job_name, expected_interval, note)
VALUES ('signup-watch', interval '20 minutes', 'signup clusters: suspend + alert (165)')
ON CONFLICT (job_name) DO UPDATE SET expected_interval = EXCLUDED.expected_interval, active = true;
