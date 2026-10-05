-- 097_checkin_scanner_build_a.sql
-- Scanner Build A (spec docs/superpowers/specs/2026-08-18-checkin-scanner-device-design.md).
--
-- 1. checkin_apply_scan records which device made a scan. scan_events.device_id
--    has existed since 049 but every scan stored NULL. A roaming scanner has no
--    operator (operator_id stays NULL, never invented), so the device is the
--    only attribution its scans have. New trailing parameter with a default, so
--    the deployed checkin-record-scans keeps working until it sends it. Body is
--    the live definition (read 2026-10-05) with the two lines marked CHANGED (097).
-- 2. checkin_set_scanning: the organizer's door and session toggles
--    (entrance_scanning, session_scanning, both from 058). Clients cannot write
--    the entitlement row (069), so this is the only way to set them. Session
--    scanning needs the admin-set multi_point_scanning entitlement.
-- 3. checkin_scan_point_counts: scans and people per scan point (the spec's
--    "session attendance is a query"). Counts and scan point names only, so
--    viewers may read it. A repeat scan at a session door is recorded as
--    'duplicate' with its attendee and scan point (the person was already
--    checked in at the front door), so both 'ok' and 'duplicate' count as
--    attended.

DROP FUNCTION IF EXISTS public.checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean, uuid);

CREATE FUNCTION public.checkin_apply_scan(p_event_id uuid, p_client_id uuid, p_attendee_id uuid, p_scanned_at timestamp with time zone, p_action text, p_prev_checked_in_at timestamp with time zone, p_operator_id uuid, p_scan_point_id uuid, p_live_time_ok boolean, p_desk_id uuid DEFAULT NULL::uuid, p_device_id uuid DEFAULT NULL::uuid)  -- CHANGED (097)
 RETURNS text
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
  v_op_role TEXT;           -- CHANGED: undo-own
  v_may_undo_any BOOLEAN;   -- CHANGED: undo-own
  v_last_op UUID;           -- CHANGED: undo-own
  v_alert_types text[];     -- CHANGED (085): VIP alerts
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
      -- CHANGED (ruling 8): desk staff may undo only the check-in they
      -- made themselves, i.e. the 'ok' scan that set the current
      -- checked_in_at. Leads, organizers and the owner undo anyone.
      SELECT role INTO v_op_role FROM leod_checkin_operators
       WHERE event_id = p_event_id AND user_id = p_operator_id;
      v_may_undo_any := COALESCE(v_op_role IN ('organizer', 'lead'), false)
        OR EXISTS (SELECT 1 FROM leod_events WHERE id = p_event_id AND created_by = p_operator_id);
      IF NOT v_may_undo_any AND v_att_in IS NOT NULL THEN
        SELECT operator_id INTO v_last_op FROM leod_checkin_scan_events
         WHERE event_id = p_event_id AND attendee_id = p_attendee_id
           AND result = 'ok' AND scanned_at = v_att_in
         ORDER BY received_at DESC LIMIT 1;
      END IF;
      IF NOT v_may_undo_any AND v_att_in IS NOT NULL AND v_last_op IS DISTINCT FROM p_operator_id THEN
        v_result := 'forbidden';
      ELSE
        UPDATE leod_checkin_attendees SET checked_in_at = NULL
         WHERE id = p_attendee_id AND checked_in_at = p_prev_checked_in_at;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        v_result := CASE WHEN v_rows > 0 THEN 'undo' ELSE 'duplicate' END;
      END IF;
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
      -- CHANGED (085): VIP alerts. Same transaction as the check-in.
      SELECT alert_ticket_types INTO v_alert_types FROM leod_checkin_entitlements WHERE event_id = p_event_id;
      IF cardinality(v_alert_types) > 0 THEN
        INSERT INTO leod_checkin_alerts (event_id, attendee_id, ticket_type, desk_id, is_test)
        SELECT p_event_id, a.id, btrim(regexp_replace(a.ticket_type, '\s+', ' ', 'g')), p_desk_id, v_test  -- CHANGED (087)
          FROM leod_checkin_attendees a
         WHERE a.id = p_attendee_id
           AND lower(btrim(regexp_replace(a.ticket_type, '\s+', ' ', 'g')))   -- CHANGED (087): inner spaces
               IN (SELECT lower(t) FROM unnest(v_alert_types) t);
      END IF;
    END IF;
  END IF;

  INSERT INTO leod_checkin_scan_events
    (id, event_id, client_id, attendee_id, scan_point_id, device_id, operator_id, scanned_at, result, is_test, desk_id)
  VALUES
    (gen_random_uuid(), p_event_id, p_client_id, v_audit_attendee, p_scan_point_id, p_device_id, p_operator_id,  -- CHANGED (097): device_id
     p_scanned_at, v_result, v_test, p_desk_id);   -- CHANGED: desk_id

  RETURN v_result;
END;
$function$
;
REVOKE ALL ON FUNCTION public.checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_apply_scan(uuid, uuid, uuid, timestamptz, text, timestamptz, uuid, uuid, boolean, uuid, uuid)
  TO service_role;

CREATE OR REPLACE FUNCTION checkin_set_scanning(p_event_id uuid, p_entrance boolean, p_session boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_multi boolean;
  v_out   jsonb;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id) OR COALESCE(checkin_role_for_event(p_event_id) = 'organizer', false)) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change scanning settings'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT multi_point_scanning INTO v_multi FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  IF COALESCE(p_session, false) AND NOT COALESCE(v_multi, false) THEN
    RAISE EXCEPTION 'Session scanning is not included for this event' USING ERRCODE = '22023';
  END IF;
  UPDATE leod_checkin_entitlements
     SET entrance_scanning = COALESCE(p_entrance, entrance_scanning),
         session_scanning  = COALESCE(p_session, session_scanning)
   WHERE event_id = p_event_id
  RETURNING jsonb_build_object('entrance_scanning', entrance_scanning, 'session_scanning', session_scanning,
                               'multi_point_scanning', multi_point_scanning)
    INTO v_out;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_scanning(uuid, boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_scanning(uuid, boolean, boolean) TO authenticated;

CREATE OR REPLACE FUNCTION checkin_scan_point_counts(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live boolean;
BEGIN
  IF auth.uid() IS NULL
     OR NOT (checkin_is_owner(p_event_id)
             OR COALESCE(checkin_role_for_event(p_event_id) IN ('organizer', 'lead', 'viewer'), false)) THEN
    RAISE EXCEPTION 'Only the owner, organizers, desk leads and viewers see scan point counts'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status = 'live' INTO v_live FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  RETURN (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'name', sp.name, 'kind', sp.kind, 'scans', COALESCE(c.scans, 0), 'people', COALESCE(c.people, 0))
             ORDER BY sp.sort_order, sp.name), '[]'::jsonb)
      FROM leod_checkin_scan_points sp
      LEFT JOIN (SELECT scan_point_id, count(*)::int AS scans, count(DISTINCT attendee_id)::int AS people
                   FROM leod_checkin_scan_events
                  WHERE event_id = p_event_id AND result IN ('ok', 'duplicate') AND attendee_id IS NOT NULL
                    AND NOT (COALESCE(v_live, false) AND is_test)
                  GROUP BY scan_point_id) c ON c.scan_point_id = sp.id
     WHERE sp.event_id = p_event_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_scan_point_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_scan_point_counts(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
