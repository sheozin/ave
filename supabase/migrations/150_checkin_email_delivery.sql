-- 150_checkin_email_delivery.sql
-- Whether each check-in email arrived. Until now a QR email, a guest
-- invitation or a desk-staff invitation was "sent" the moment Resend took
-- it, and a bounce was invisible: Resend's delivery webhook was never set up
-- (every email_log row still reads 'sent'). Now:
--   * each check-in email Resend accepts is recorded here with its Resend id
--     (attendee or staff member, kind);
--   * checkin-email-status, every 5 minutes, asks Resend for the latest event
--     of recent emails (delivered, bounced, complained, opened, ...);
--   * checkin_email_status gives Event admin the latest state per guest and
--     per staff member, shown next to "sent".
-- 148 named the sender column invited_by; renamed so it cannot be mistaken
-- for leod_users.invited_by, which must never decide access (132, and
-- tests/event-teams-no-invited-by.spec.ts). It records who sent an email.
ALTER TABLE leod_checkin_operators RENAME COLUMN invited_by TO invite_sent_by;

CREATE TABLE IF NOT EXISTS leod_checkin_emails (
  id          bigserial   PRIMARY KEY,
  event_id    uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  kind        text        NOT NULL CHECK (kind IN ('qr', 'guest_invite', 'staff_invite')),
  attendee_id uuid        REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  user_id     uuid        REFERENCES auth.users(id) ON DELETE CASCADE,
  resend_id   text        NOT NULL UNIQUE CHECK (length(resend_id) BETWEEN 8 AND 100),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  status      text        NOT NULL DEFAULT 'sent'
              CHECK (status IN ('sent', 'delivered', 'delivery_delayed', 'opened', 'clicked', 'bounced', 'complained', 'failed')),
  status_at   timestamptz,
  checked_at  timestamptz,
  CHECK (attendee_id IS NOT NULL OR user_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_checkin_emails_event ON leod_checkin_emails (event_id, kind, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_checkin_emails_open ON leod_checkin_emails (checked_at NULLS FIRST)
  WHERE status IN ('sent', 'delivery_delayed');
ALTER TABLE leod_checkin_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_emails FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_emails_id_seq FROM anon, authenticated;

-- Latest state per guest (QR email, invitation) and per staff member, for
-- people who can see those lists: organizers (checkin_can_edit_page) and
-- desk leads (who manage desk staff).
CREATE OR REPLACE FUNCTION checkin_email_status(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- COALESCE: for a stranger the role is NULL, and NOT (false OR NULL) is
  -- NULL, which IF treats as false: without it a stranger got through.
  IF NOT (COALESCE(checkin_can_edit_page(p_event_id), false) OR COALESCE(checkin_role_for_event(p_event_id) = 'lead', false)) THEN
    RAISE EXCEPTION 'Only organizers and desk leads can see email delivery' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN jsonb_build_object(
    'guests', (SELECT COALESCE(jsonb_object_agg(k, v), '{}'::jsonb) FROM (
       SELECT x.attendee_id::text AS k, jsonb_object_agg(x.kind, jsonb_build_object('status', x.status, 'at', COALESCE(x.status_at, x.sent_at))) AS v
         FROM (SELECT DISTINCT ON (attendee_id, kind) attendee_id, kind, status, status_at, sent_at
                 FROM leod_checkin_emails WHERE event_id = p_event_id AND attendee_id IS NOT NULL
                ORDER BY attendee_id, kind, sent_at DESC) x
        GROUP BY x.attendee_id) g),
    'staff', (SELECT COALESCE(jsonb_object_agg(s.user_id::text, jsonb_build_object('status', s.status, 'at', COALESCE(s.status_at, s.sent_at))), '{}'::jsonb)
       FROM (SELECT DISTINCT ON (user_id) user_id, status, status_at, sent_at
               FROM leod_checkin_emails WHERE event_id = p_event_id AND kind = 'staff_invite' AND user_id IS NOT NULL
              ORDER BY user_id, sent_at DESC) s));
END;
$$;
REVOKE ALL ON FUNCTION checkin_email_status(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_email_status(uuid) TO authenticated;

-- The sweep's secret and schedule (pattern of 140).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM vault.secrets WHERE name = 'checkin_email_status_cron_secret') THEN
    PERFORM vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'checkin_email_status_cron_secret',
                                'x-cron-secret for checkin-email-status (migration 150)');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.checkin_email_status_cron_ok(p_secret text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT COALESCE(length(p_secret) >= 32 AND p_secret = (
    SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'checkin_email_status_cron_secret'), false);
$$;
REVOKE ALL ON FUNCTION public.checkin_email_status_cron_ok(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_email_status_cron_ok(text) TO service_role;

SELECT cron.unschedule('checkin-email-status') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'checkin-email-status');
SELECT cron.schedule('checkin-email-status', '*/5 * * * *', $cron$
  SELECT net.http_post(
    url     := 'https://sawekpguemzvuvvulfbc.supabase.co/functions/v1/checkin-email-status',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'checkin_email_status_cron_secret')),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000);
$cron$);

-- Watched like the other jobs (075): if the sweep stops, it reads 'stale'
-- instead of the delivery states quietly freezing.
INSERT INTO leod_checkin_jobs (job_name, expected_interval, note)
VALUES ('checkin-email-status', interval '15 minutes', 'Asks Resend for the latest event of recent check-in emails (migration 150)')
ON CONFLICT (job_name) DO UPDATE SET expected_interval = EXCLUDED.expected_interval, note = EXCLUDED.note, active = true;
