-- 065_billing_idempotency.sql
-- Payment-path hardening for stripe-webhook and checkin-create-checkout.
--  1. Pay-per-Event credit is idempotent per Checkout Session, and no longer
--     downgrades an active Starter/Pro/Enterprise plan to 'perevent'.
--  2. A check-in payment for a deleted event (or entitlement) is recorded as
--     an orphan for manual refund instead of raising, which made Stripe retry
--     forever. A second paid session for an already-live event is recorded
--     and reported as 'already_live' (likely double charge).
--  3. Columns for reusing an open Checkout Session, and a per-user Stripe
--     customer map so check-in-only buyers get one customer, not one per click.
--  4. activity_log.category allows 'billing_alert' (the webhook's alert sink).

-- 1. Pay-per-Event ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leod_perevent_purchases (
  stripe_checkout_session_id TEXT        PRIMARY KEY,
  director_id                UUID        NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE leod_perevent_purchases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_perevent_purchases FROM anon, authenticated;

DROP FUNCTION IF EXISTS public.increment_events_purchased(UUID);
CREATE OR REPLACE FUNCTION public.increment_events_purchased(p_director_id UUID, p_session_id TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows   INTEGER;
  v_plan   TEXT;
  v_status TEXT;
BEGIN
  INSERT INTO leod_perevent_purchases (stripe_checkout_session_id, director_id)
  VALUES (p_session_id, p_director_id)
  ON CONFLICT (stripe_checkout_session_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN 'already_processed'; END IF;

  SELECT plan, status INTO v_plan, v_status
    FROM leod_subscriptions WHERE director_id = p_director_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'orphaned'; END IF;  -- purchase row kept for manual follow-up

  IF v_plan IN ('starter', 'pro', 'enterprise') AND v_status = 'active' THEN
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

-- 2. Check-in go-live ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS leod_checkin_orphan_payments (
  stripe_checkout_session_id TEXT        PRIMARY KEY,
  event_id                   UUID,
  buyer_id                   UUID,
  stripe_payment_intent_id   TEXT,
  amount_total               INTEGER,
  currency                   TEXT,
  created_at                 TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE leod_checkin_orphan_payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_orphan_payments FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.checkin_mark_paid(p_event_id uuid, p_buyer_id uuid, p_session_id text, p_payment_intent text, p_customer text, p_amount_total integer, p_amount_tax integer, p_currency text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows   INTEGER;
  v_status TEXT;
BEGIN
  -- Same key as checkin_apply_scan: go-live cannot interleave with a scan.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_scan:' || p_event_id::text, 0));

  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Event or entitlement deleted after payment. Raising here made Stripe
    -- retry forever; record it for a manual refund instead.
    INSERT INTO leod_checkin_orphan_payments (stripe_checkout_session_id, event_id, buyer_id,
      stripe_payment_intent_id, amount_total, currency)
    VALUES (p_session_id, p_event_id, p_buyer_id, p_payment_intent, p_amount_total, p_currency)
    ON CONFLICT (stripe_checkout_session_id) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN RETURN 'already_processed'; END IF;  -- redelivery: alert once
    RETURN 'orphaned';
  END IF;

  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id,
    stripe_payment_intent_id, stripe_customer_id, amount_total, amount_tax, currency, paid_at)
  VALUES (p_event_id, p_buyer_id, p_session_id, p_payment_intent, p_customer,
    p_amount_total, p_amount_tax, p_currency, now())
  ON CONFLICT (stripe_checkout_session_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN 'already_processed'; END IF;

  -- A second paid session for a live event: keep the record, change nothing.
  IF v_status = 'live' THEN RETURN 'already_live'; END IF;

  UPDATE leod_checkin_entitlements
     SET status = 'live', went_live_at = now()
   WHERE event_id = p_event_id;

  UPDATE leod_checkin_attendees
     SET checked_in_at = NULL, badge_printed_at = NULL
   WHERE event_id = p_event_id
     AND id IN (SELECT attendee_id FROM leod_checkin_scan_events
                 WHERE event_id = p_event_id AND is_test AND result = 'ok' AND attendee_id IS NOT NULL);
  DELETE FROM leod_checkin_print_jobs
   WHERE attendee_id IN (SELECT id FROM leod_checkin_attendees WHERE event_id = p_event_id AND is_test);
  DELETE FROM leod_checkin_scan_events WHERE event_id = p_event_id AND is_test;
  DELETE FROM leod_checkin_attendees   WHERE event_id = p_event_id AND is_test;

  RETURN 'live';
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_mark_paid(uuid, uuid, text, text, text, integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_mark_paid(uuid, uuid, text, text, text, integer, integer, text) TO service_role;

-- 3. Checkout session reuse and customer map -------------------------------------
ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS checkout_session_id TEXT,
  ADD COLUMN IF NOT EXISTS checkout_expires_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS leod_billing_customers (
  user_id            UUID        PRIMARY KEY,
  stripe_customer_id TEXT        NOT NULL,
  created_at         TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE leod_billing_customers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_billing_customers FROM anon, authenticated;

-- 4. Alert category -----------------------------------------------------------------
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_category_check;
ALTER TABLE activity_log ADD CONSTRAINT activity_log_category_check
  CHECK (category = ANY (ARRAY['auth'::text, 'email'::text, 'billing'::text, 'event'::text, 'system'::text, 'billing_alert'::text]));
