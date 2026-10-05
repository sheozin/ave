-- 088_checkin_post_event_report.sql
-- Post-event report (event-day spec, feature 6).
-- Design: docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md (6)
--
-- checkin_event_report(event)        page data: owner, organizer, viewer
--                                    (the viewer version has no companies
--                                    and no desk labels). Leads and desk
--                                    staff are refused.
-- checkin_event_report_data(e, p)    the numbers; p = include people data
--                                    (companies, desk labels). Service only.
-- checkin_reports_due()              live events whose window closed two
--                                    hours ago or more and whose report
--                                    has not gone out. Service only.
-- checkin_claim_report(event)        sets report_sent_at once; the sender
--                                    sends only when it wins the claim, so
--                                    two overlapping runs cannot both send.
-- checkin_unclaim_report(event)      a send that failed gives the claim back.
--
-- The window is the one in checkin-policy.ts: it closes at local midnight
-- starting (date + 3). Test-mode events never get a report email.
-- Every count comes from leod_checkin_attendees.checked_in_at, as the
-- dashboard's do (072), so an undone check-in never counts.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS report_sent_at timestamptz;

CREATE OR REPLACE FUNCTION checkin_event_report_data(p_event_id uuid, p_people boolean)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
  v_live   boolean;
  v_out    jsonb;
BEGIN
  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  v_live := v_status = 'live';

  SELECT jsonb_build_object(
    'registered', count(*)::int,
    'checked_in', (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int,
    'walk_ins',   (count(*) FILTER (WHERE source IN ('kiosk', 'walk_in')))::int,
    'walk_ins_in', (count(*) FILTER (WHERE source IN ('kiosk', 'walk_in') AND checked_in_at IS NOT NULL))::int,
    'first_arrival_at', min(checked_in_at),
    'last_arrival_at',  max(checked_in_at))
    INTO v_out
    FROM leod_checkin_attendees WHERE event_id = p_event_id;

  v_out := v_out || jsonb_build_object(
    'status', COALESCE(v_status, 'test'),
    'generated_at', now(),
    'event', (SELECT jsonb_build_object('name', name, 'date', date, 'timezone', timezone, 'venue', venue)
                FROM leod_events WHERE id = p_event_id),
    'by_ticket', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ticket_type', tt, 'registered', reg, 'checked_in', arr, 'no_shows', reg - arr)
               ORDER BY reg - arr DESC, reg DESC, tt), '[]'::jsonb)
        FROM (SELECT COALESCE(NULLIF(btrim(ticket_type), ''), 'No ticket type') AS tt, count(*)::int AS reg,
                     (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int AS arr
                FROM leod_checkin_attendees WHERE event_id = p_event_id GROUP BY 1) t),
    -- Busiest 15-minute bucket (same buckets as the dashboard chart).
    'peak', (
      SELECT jsonb_build_object('t', b, 'n', n)
        FROM (SELECT (floor(extract(epoch FROM checked_in_at) / 900) * 900)::bigint AS b, count(*)::int AS n
                FROM leod_checkin_attendees
               WHERE event_id = p_event_id AND checked_in_at IS NOT NULL
               GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 1) x),
    -- Check-ins a desk made while offline: the scan reached the server more
    -- than 60 s after it was made. Test desks are left out once live.
    'offline', (
      SELECT jsonb_build_object(
               'late_checkins', count(*)::int,
               'longest_delay_s', COALESCE(max(floor(extract(epoch FROM s.received_at - s.scanned_at)))::int, 0),
               'desks', count(DISTINCT s.desk_id)::int)
        FROM leod_checkin_scan_events s
       WHERE s.event_id = p_event_id AND s.result = 'ok'
         AND s.received_at - s.scanned_at > interval '60 seconds'
         AND NOT (v_live AND s.is_test)),
    -- Desks that made at least one 'ok' check-in, with their busiest 15
    -- minutes (072's definition). Labels only when p_people.
    'desks', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'label', CASE WHEN p_people THEN COALESCE(d.label, 'Desk') END,
               'checkins', w.n, 'busiest_15', w.busiest) ORDER BY w.n DESC), '[]'::jsonb)
        FROM (SELECT desk_id, count(*)::int AS n, max(c)::int AS busiest
                FROM (SELECT desk_id,
                             count(*) OVER (PARTITION BY desk_id ORDER BY scanned_at
                                            RANGE BETWEEN CURRENT ROW AND INTERVAL '15 minutes' FOLLOWING) AS c
                        FROM leod_checkin_scan_events
                       WHERE event_id = p_event_id AND desk_id IS NOT NULL AND result = 'ok'
                         AND NOT (v_live AND is_test)) z
               GROUP BY desk_id) w
        LEFT JOIN leod_checkin_desks d ON d.event_id = p_event_id AND d.desk_id = w.desk_id)
  );

  IF p_people THEN
    -- Companies with someone missing, most missing first (084's grouping).
    v_out := v_out || jsonb_build_object('companies', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('company', label, 'expected', expected, 'arrived', arrived)
                                ORDER BY expected - arrived DESC, label), '[]'::jsonb)
        FROM (SELECT mode() WITHIN GROUP (ORDER BY nm) AS label, count(*)::int AS expected,
                     (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int AS arrived
                FROM (SELECT checked_in_at, regexp_replace(btrim(company), '\s+', ' ', 'g') AS nm
                        FROM leod_checkin_attendees
                       WHERE event_id = p_event_id AND NULLIF(btrim(company), '') IS NOT NULL) a
               GROUP BY lower(nm)) c
       WHERE arrived < expected));
  END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_event_report_data(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_event_report_data(uuid, boolean) TO service_role;

CREATE OR REPLACE FUNCTION checkin_event_report(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role  text := checkin_role_for_event(p_event_id);
  v_owner boolean := checkin_is_owner(p_event_id);
BEGIN
  -- COALESCE: a stranger's role is NULL (see 086).
  IF auth.uid() IS NULL OR NOT (v_owner OR COALESCE(v_role IN ('organizer', 'viewer'), false)) THEN
    RAISE EXCEPTION 'Only the owner, organizers and viewers see the event report'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN checkin_event_report_data(p_event_id, v_owner OR v_role = 'organizer')
         || jsonb_build_object('role', CASE WHEN v_owner THEN 'owner' ELSE v_role END);
END;
$$;
REVOKE ALL ON FUNCTION checkin_event_report(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_event_report(uuid) TO authenticated;

-- Live events whose window closed at least two hours ago, report not sent.
-- Events more than 30 days past their close are left alone: the feature
-- shipped after them and nobody is waiting for those emails.
CREATE OR REPLACE FUNCTION checkin_reports_due()
RETURNS TABLE (event_id uuid, owner_id uuid, closes_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT e.event_id, ev.created_by, ((ev.date + 3)::timestamp AT TIME ZONE ev.timezone)
    FROM leod_checkin_entitlements e
    JOIN leod_events ev ON ev.id = e.event_id
   WHERE e.status = 'live'
     AND e.report_sent_at IS NULL
     AND ev.date IS NOT NULL AND ev.timezone IS NOT NULL
     AND now() >= ((ev.date + 3)::timestamp AT TIME ZONE ev.timezone) + interval '2 hours'
     AND now() <  ((ev.date + 3)::timestamp AT TIME ZONE ev.timezone) + interval '30 days'
   ORDER BY 3;
$$;
REVOKE ALL ON FUNCTION checkin_reports_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_reports_due() TO service_role;

CREATE OR REPLACE FUNCTION checkin_claim_report(p_event_id uuid)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  WITH c AS (
    UPDATE leod_checkin_entitlements SET report_sent_at = now()
     WHERE event_id = p_event_id AND report_sent_at IS NULL AND status = 'live'
    RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM c);
$$;
REVOKE ALL ON FUNCTION checkin_claim_report(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_claim_report(uuid) TO service_role;

CREATE OR REPLACE FUNCTION checkin_unclaim_report(p_event_id uuid)
RETURNS void
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE leod_checkin_entitlements SET report_sent_at = NULL WHERE event_id = p_event_id;
$$;
REVOKE ALL ON FUNCTION checkin_unclaim_report(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_unclaim_report(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
