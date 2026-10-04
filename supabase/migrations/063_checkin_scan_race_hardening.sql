-- Hardening from the task 3 re-review: cross-event client_id gets a distinct
-- SQLSTATE, the cap fails closed, and go-live serialises with scans.
CREATE OR REPLACE FUNCTION public.checkin_apply_scan(
  p_event_id UUID, p_client_id UUID, p_attendee_id UUID, p_scanned_at TIMESTAMPTZ,
  p_action TEXT, p_prev_checked_in_at TIMESTAMPTZ, p_operator_id UUID,
  p_scan_point_id UUID, p_live_time_ok BOOLEAN)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_prior  TEXT;
  v_prior_event UUID;
  v_status TEXT;
  v_test   BOOLEAN;
  v_att_event UUID;
  v_att_in    TIMESTAMPTZ;
  v_found  BOOLEAN;
  v_result TEXT;
  v_audit_attendee UUID := NULL;
  v_rows   INTEGER;
BEGIN
  IF p_action NOT IN ('checkin', 'undo') THEN RAISE EXCEPTION 'unknown action %', p_action; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_scan:' || p_event_id::text, 0));

  SELECT result, event_id INTO v_prior, v_prior_event FROM leod_checkin_scan_events WHERE client_id = p_client_id;
  IF FOUND THEN
    IF v_prior_event <> p_event_id THEN
      RAISE EXCEPTION 'client_id already used for another event' USING ERRCODE = 'CK001';
    END IF;
    RETURN v_prior;
  END IF;

  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'check-in is not enabled for event %', p_event_id; END IF;
  v_test := v_status IS DISTINCT FROM 'live';

  SELECT event_id, checked_in_at, true INTO v_att_event, v_att_in, v_found
    FROM leod_checkin_attendees WHERE id = p_attendee_id FOR UPDATE;

  IF NOT COALESCE(v_found, false) THEN
    v_result := 'unknown_token';
  ELSIF v_att_event <> p_event_id THEN
    v_result := 'wrong_event';
  ELSE
    v_audit_attendee := p_attendee_id;
    IF p_action = 'undo' THEN
      UPDATE leod_checkin_attendees SET checked_in_at = NULL
       WHERE id = p_attendee_id AND checked_in_at = p_prev_checked_in_at;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      v_result := CASE WHEN v_rows > 0 THEN 'undo' ELSE 'duplicate' END;
    ELSIF v_att_in IS NOT NULL THEN
      v_result := 'duplicate';
    ELSIF v_test AND COALESCE(checkin_test_usage(p_event_id), 25) >= 25 THEN
      v_result := 'test_cap';
    ELSIF NOT v_test AND NOT COALESCE(p_live_time_ok, false) THEN
      v_result := 'outside_window';
    ELSE
      UPDATE leod_checkin_attendees SET checked_in_at = p_scanned_at
       WHERE id = p_attendee_id AND checked_in_at IS NULL;
      v_result := 'ok';
    END IF;
  END IF;

  -- A concurrent insert of the same client_id still raises unique_violation,
  -- which rolls back the attendee update above as well. Atomic.
  INSERT INTO leod_checkin_scan_events
    (id, event_id, client_id, attendee_id, scan_point_id, device_id, operator_id, scanned_at, result, is_test)
  VALUES
    (gen_random_uuid(), p_event_id, p_client_id, v_audit_attendee, p_scan_point_id, NULL, p_operator_id, p_scanned_at, v_result, v_test);

  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.checkin_apply_scan(UUID, UUID, UUID, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, UUID, UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_apply_scan(UUID, UUID, UUID, TIMESTAMPTZ, TEXT, TIMESTAMPTZ, UUID, UUID, BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.checkin_mark_paid(p_event_id uuid, p_buyer_id uuid, p_session_id text, p_payment_intent text, p_customer text, p_amount_total integer, p_amount_tax integer, p_currency text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_rows INTEGER;
BEGIN
  -- Same key as checkin_apply_scan: go-live cannot interleave with a scan.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_scan:' || p_event_id::text, 0));

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
