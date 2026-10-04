-- 068: comp go-live goes through the same lock + test-data cleanup as a paid
-- go-live, and comp events are exempt from the live date lock.
CREATE OR REPLACE FUNCTION public.checkin_mark_comp_live(p_event_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_status TEXT;
BEGIN
  -- Same key as checkin_apply_scan: go-live cannot interleave with a scan.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_scan:' || p_event_id::text, 0));

  IF NOT EXISTS (SELECT 1 FROM leod_events e
                  JOIN leod_checkin_comp_accounts c ON c.user_id = e.created_by
                 WHERE e.id = p_event_id) THEN
    RAISE EXCEPTION 'checkin_mark_comp_live: event % is not owned by a comp account', p_event_id;
  END IF;

  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id FOR UPDATE;
  IF NOT FOUND THEN RETURN 'no_entitlement'; END IF;
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
REVOKE ALL ON FUNCTION public.checkin_mark_comp_live(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_mark_comp_live(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.checkin_lock_live_event_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  IF NEW.date IS NOT DISTINCT FROM OLD.date THEN RETURN NEW; END IF;
  IF v_caller IS NULL OR v_caller = 'service_role' THEN RETURN NEW; END IF;
  IF COALESCE(is_admin(), false) THEN RETURN NEW; END IF;
  -- Comp events were not paid for, so there is no paid date to protect.
  IF OLD.created_by IS NOT NULL
     AND EXISTS (SELECT 1 FROM leod_checkin_comp_accounts WHERE user_id = OLD.created_by) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM leod_checkin_entitlements WHERE event_id = OLD.id AND status = 'live') THEN
    RAISE EXCEPTION 'This event is live for check-in, so its date is locked. Contact support@cuedeck.io to move it.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON TABLE leod_checkin_comp_accounts IS 'Accounts whose check-in events go live without payment. Writes: admin/service only. Removing a row does NOT revert events that are already live.';
