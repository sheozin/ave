-- One scan, one transaction. Serialised per event so the test cap and
-- the client_id dedup cannot be raced by parallel desk flushes.
-- TEST cap 25 mirrors TEST_CAP in supabase/functions/_shared/checkin-policy.ts.
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

  SELECT result INTO v_prior FROM leod_checkin_scan_events WHERE client_id = p_client_id;
  IF FOUND THEN RETURN v_prior; END IF;

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
    ELSIF v_test AND checkin_test_usage(p_event_id) >= 25 THEN
      v_result := 'test_cap';
    ELSIF NOT v_test AND NOT COALESCE(p_live_time_ok, false) THEN
      v_result := 'outside_window';
    ELSE
      UPDATE leod_checkin_attendees SET checked_in_at = p_scanned_at
       WHERE id = p_attendee_id AND checked_in_at IS NULL;
      v_result := 'ok';
    END IF;
  END IF;

  -- A client_id already used in ANOTHER event raises unique_violation here,
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
