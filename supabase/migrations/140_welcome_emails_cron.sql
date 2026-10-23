-- 140: send the founder welcome email, which had never gone out.
--
-- handle_first_login has queued a row in welcome_email_trigger for every
-- new account since April (28 by 2026-10-23), but nothing ever ran
-- process-welcome-triggers, so not one welcome email was sent.
--
-- 1. The function now only runs for the scheduler: it checks a secret kept
--    in the vault (welcome_emails_cron_secret), like the check-in jobs.
-- 2. pg_cron calls it every 10 minutes.
-- 3. A welcome half a year late reads oddly, so rows older than 7 days are
--    closed without sending. Newer accounts get theirs on the first run.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'welcome_emails_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'welcome_emails_cron_secret',
                                'x-cron-secret for process-welcome-triggers (migration 140)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.welcome_emails_cron_ok(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
    SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'welcome_emails_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION public.welcome_emails_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.welcome_emails_cron_ok(text) TO service_role;

UPDATE welcome_email_trigger
   SET processed = true, processed_at = now()
 WHERE NOT processed AND triggered_at < now() - interval '7 days';

SELECT cron.unschedule('welcome-emails') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'welcome-emails');
SELECT cron.schedule('welcome-emails', '*/10 * * * *', $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/process-welcome-triggers',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'welcome_emails_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
$cron$);
