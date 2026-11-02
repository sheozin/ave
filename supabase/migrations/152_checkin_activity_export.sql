-- 152_checkin_activity_export.sql
-- Every scan and every replaced badge for one event, with the guest, the
-- desk, the door or session, the device and the staff member, for the
-- organizer's activity export. Desk labels and staff names are not
-- readable from the browser, so they are joined here.
-- Same rule as the guest export: organizer (which includes the owner).
-- Paged by the caller with a range: PostgREST caps rows per request.

CREATE OR REPLACE FUNCTION checkin_activity_export(p_event_id UUID)
RETURNS TABLE (
  at          TIMESTAMPTZ,
  kind        TEXT,
  attendee_id UUID,
  first_name  TEXT,
  last_name   TEXT,
  email       TEXT,
  company     TEXT,
  ticket_type TEXT,
  desk        TEXT,
  place       TEXT,
  device      TEXT,
  staff       TEXT
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_test BOOLEAN;
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can export check-in activity' USING ERRCODE = '42501';
  END IF;
  -- Test scans are cleared at go-live; before it, they are the only ones.
  SELECT e.status IS DISTINCT FROM 'live' INTO v_test FROM leod_checkin_entitlements e WHERE e.event_id = p_event_id;

  RETURN QUERY
  SELECT * FROM (
    SELECT s.scanned_at, s.result, s.attendee_id, a.first_name, a.last_name, a.email, a.company, a.ticket_type,
           dk.label, sp.name, dv.label,
           COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), u.email)::text
      FROM leod_checkin_scan_events s
      LEFT JOIN leod_checkin_attendees a ON a.id = s.attendee_id
      LEFT JOIN leod_checkin_desks dk ON dk.event_id = s.event_id AND dk.desk_id = s.desk_id
      LEFT JOIN leod_checkin_scan_points sp ON sp.id = s.scan_point_id
      LEFT JOIN leod_checkin_devices dv ON dv.id = s.device_id
      LEFT JOIN auth.users u ON u.id = s.operator_id
     WHERE s.event_id = p_event_id AND s.is_test = COALESCE(v_test, true)
    UNION ALL
    SELECT o.replaced_at, 'new_badge'::text, o.attendee_id, a.first_name, a.last_name, a.email, a.company, a.ticket_type,
           NULL::text, NULL::text, NULL::text,
           COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), u.email)::text
      FROM leod_checkin_old_badges o
      JOIN leod_checkin_attendees a ON a.id = o.attendee_id
      LEFT JOIN auth.users u ON u.id = o.replaced_by
     WHERE o.event_id = p_event_id
  ) x
  ORDER BY 1, 3, 2;
END;
$$;

REVOKE ALL ON FUNCTION checkin_activity_export(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_activity_export(UUID) TO authenticated;
