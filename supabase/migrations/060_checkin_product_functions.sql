-- ============================================================
-- CueDeck — Migration 060: Check-in as a product — functions
-- ============================================================

-- Test usage: check-ins accepted in test + kiosk registrations in test.
CREATE OR REPLACE FUNCTION public.checkin_test_usage(p_event_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF NOT (v_caller IS NULL OR v_caller = 'service_role')
     AND checkin_role_for_event(p_event_id) IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN (SELECT count(*) FROM leod_checkin_scan_events
           WHERE event_id = p_event_id AND is_test AND result = 'ok')
       + (SELECT count(*) FROM leod_checkin_attendees
           WHERE event_id = p_event_id AND is_test);
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_test_usage(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.checkin_test_usage(UUID) TO authenticated, service_role;

-- Go-live. One transaction: purchase row, state flip, test data cleared.
-- Idempotent on the Checkout Session id: a Stripe retry inserts nothing
-- and returns before touching any check-in made since the first delivery.
CREATE OR REPLACE FUNCTION public.checkin_mark_paid(
  p_event_id UUID, p_buyer_id UUID, p_session_id TEXT, p_payment_intent TEXT,
  p_customer TEXT, p_amount_total INTEGER, p_amount_tax INTEGER, p_currency TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  INSERT INTO leod_checkin_purchases (event_id, buyer_id, stripe_checkout_session_id,
    stripe_payment_intent_id, stripe_customer_id, amount_total, amount_tax, currency, paid_at)
  VALUES (p_event_id, p_buyer_id, p_session_id, p_payment_intent, p_customer,
    p_amount_total, p_amount_tax, p_currency, now())
  ON CONFLICT (stripe_checkout_session_id) DO NOTHING;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN 'already_processed'; END IF;

  UPDATE leod_checkin_entitlements
     SET status = 'live', went_live_at = now()
   WHERE event_id = p_event_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RAISE EXCEPTION 'checkin_mark_paid: no entitlement row for event %', p_event_id;
  END IF;

  -- Test rows never recorded a real arrival; the organizer was told
  -- before paying that they would be cleared. Only check-ins that came
  -- from a TEST scan are reset: an event that was live, refunded back to
  -- test, and paid again keeps the real check-ins from its first live
  -- period. Must run before the test scan events are deleted.
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
REVOKE ALL ON FUNCTION public.checkin_mark_paid(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_mark_paid(UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.checkin_mark_refunded(p_payment_intent TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_event UUID;
  v_refunded TIMESTAMPTZ;
BEGIN
  SELECT event_id, refunded_at INTO v_event, v_refunded
    FROM leod_checkin_purchases WHERE stripe_payment_intent_id = p_payment_intent;
  IF v_event IS NULL THEN RETURN 'not_found'; END IF;
  IF v_refunded IS NOT NULL THEN RETURN 'already_refunded'; END IF;

  UPDATE leod_checkin_purchases SET refunded_at = now() WHERE stripe_payment_intent_id = p_payment_intent;
  UPDATE leod_checkin_entitlements SET status = 'test' WHERE event_id = v_event;
  RETURN 'test';
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_mark_refunded(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_mark_refunded(TEXT) TO service_role;

-- Pay-per-Event credit. stripe-webhook has called this since the billing
-- integration landed, but it never existed (verified 2026-10-04).
CREATE OR REPLACE FUNCTION public.increment_events_purchased(p_director_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new INTEGER;
BEGIN
  UPDATE leod_subscriptions
     SET events_purchased = events_purchased + 1, plan = 'perevent', status = 'active', updated_at = now()
   WHERE director_id = p_director_id
  RETURNING events_purchased INTO v_new;
  IF v_new IS NULL THEN
    RAISE EXCEPTION 'increment_events_purchased: no subscription row for %', p_director_id;
  END IF;
  RETURN v_new;
END;
$function$;
REVOKE ALL ON FUNCTION public.increment_events_purchased(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_events_purchased(UUID) TO service_role;

-- Per-event usage counted on the server. The console's client update
-- was silently rejected by RLS (no director UPDATE policy).
CREATE OR REPLACE FUNCTION public.leod_events_count_perevent_usage()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.created_via = 'console' AND NEW.created_by IS NOT NULL THEN
    UPDATE leod_subscriptions
       SET events_used = events_used + 1, updated_at = now()
     WHERE director_id = NEW.created_by AND plan = 'perevent';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_leod_events_count_perevent_usage ON leod_events;
CREATE TRIGGER trg_leod_events_count_perevent_usage
  AFTER INSERT ON leod_events
  FOR EACH ROW EXECUTE FUNCTION public.leod_events_count_perevent_usage();
