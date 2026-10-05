-- 089_checkin_report_cron.sql
-- Schedules checkin-post-event-report (088) every 15 minutes.
--
-- pg_cron and pg_net were available but not installed on this project
-- before this migration (checked 2026-10-05); nothing else here uses them.
--
-- The x-cron-secret is generated inside the vault and never leaves the
-- database except in the cron job's own request: the Edge Function does
-- not hold a copy, it asks checkin_report_cron_ok (service role only)
-- whether the header matches. Reads vault.decrypted_secrets, never
-- current_setting('app.settings...'), which is unset on Supabase and
-- would make every call a silent 401.
--
-- The job is registered in leod_checkin_jobs with a 15 minute interval, so
-- the AVE Brain reports it stale when runs stop arriving. A run row is
-- written by the function only after the secret check passes, so a broken
-- secret also shows up as stale, not as silence.

CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'checkin_report_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'),
                                'checkin_report_cron_secret',
                                'x-cron-secret for the checkin-post-event-report Edge Function (089)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION checkin_report_cron_ok(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
           SELECT decrypted_secret FROM vault.decrypted_secrets
            WHERE name = 'checkin_report_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION checkin_report_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_report_cron_ok(text) TO service_role;

INSERT INTO leod_checkin_jobs (job_name, expected_interval, note)
VALUES ('checkin-post-event-report', interval '15 minutes',
        'pg_cron -> pg_net -> Edge Function checkin-post-event-report (088, 089)')
ON CONFLICT (job_name) DO UPDATE
  SET expected_interval = EXCLUDED.expected_interval, note = EXCLUDED.note, active = true;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'checkin-post-event-report';
SELECT cron.schedule(
  'checkin-post-event-report',
  '*/15 * * * *',
  $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-post-event-report',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets
                                    WHERE name = 'checkin_report_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 30000);
  $cron$);
