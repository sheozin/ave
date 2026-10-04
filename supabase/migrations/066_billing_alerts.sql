-- 066_billing_alerts.sql
--  1. Billing alerts get their own service-only table (admins may read).
--     activity_log was the wrong sink: anon could write to it through
--     log_activity, and nobody reads it.
--  2. leod_checkin_orphan_payments records why a payment is orphaned
--     ('event_gone' from checkin_mark_paid, 'amount_mismatch' from the webhook).
--  3. log_activity is service-role only. Callers checked 2026-10-04: no
--     database function, trigger or cron job calls it; the only callers are
--     the stripe-webhook, resend-webhook and send-welcome-email Edge
--     Functions, all through the service-role adminClient.
--  4. Pay-per-Event credit never rewrites a Starter/Pro/Enterprise plan or
--     its status (065 still reset a past_due one to perevent/active).

-- 1. ------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leod_billing_alerts (
  id               BIGSERIAL   PRIMARY KEY,
  kind             TEXT        NOT NULL,
  user_id          UUID        NULL,
  stripe_object_id TEXT        NULL,
  details          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  emailed_at       TIMESTAMPTZ NULL,
  resolved_at      TIMESTAMPTZ NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE leod_billing_alerts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_billing_alerts FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON leod_billing_alerts FROM authenticated;
REVOKE ALL ON SEQUENCE leod_billing_alerts_id_seq FROM anon, authenticated;
DROP POLICY IF EXISTS billing_alerts_admin_read ON leod_billing_alerts;
CREATE POLICY billing_alerts_admin_read ON leod_billing_alerts
  FOR SELECT TO authenticated USING (is_admin());

-- 2. ------------------------------------------------------------------------
ALTER TABLE leod_checkin_orphan_payments
  ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'event_gone';

-- 3. ------------------------------------------------------------------------
REVOKE EXECUTE ON FUNCTION public.log_activity(uuid, text, text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.log_activity(uuid, text, text, text, jsonb) TO service_role;

-- 4. ------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.increment_events_purchased(p_director_id UUID, p_session_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
  v_plan TEXT;
BEGIN
  INSERT INTO leod_perevent_purchases (stripe_checkout_session_id, director_id)
  VALUES (p_session_id, p_director_id)
  ON CONFLICT (stripe_checkout_session_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN 'already_processed'; END IF;

  SELECT plan INTO v_plan
    FROM leod_subscriptions WHERE director_id = p_director_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'orphaned'; END IF;  -- purchase row kept for manual follow-up

  IF v_plan IN ('starter', 'pro', 'enterprise') THEN
    -- A paid plan keeps its plan and status; the credit is only added.
    UPDATE leod_subscriptions
       SET events_purchased = events_purchased + 1, updated_at = now()
     WHERE director_id = p_director_id;
  ELSE
    UPDATE leod_subscriptions
       SET events_purchased = events_purchased + 1, plan = 'perevent', status = 'active', updated_at = now()
     WHERE director_id = p_director_id;
  END IF;
  RETURN 'credited';
END;
$function$;
REVOKE ALL ON FUNCTION public.increment_events_purchased(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_events_purchased(UUID, TEXT) TO service_role;
