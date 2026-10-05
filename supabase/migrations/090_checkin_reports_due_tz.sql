-- 090_checkin_reports_due_tz.sql
-- Review of 088 (denial of service): leod_events.timezone is free text an
-- owner can write directly (owner_update_events RLS, no validation), and
-- check-in test mode is free to enable. One event with an invalid zone made
-- `AT TIME ZONE` raise inside checkin_reports_due(), which failed the whole
-- query, so no owner got a report. Rows with an unknown zone are now dropped
-- in a MATERIALIZED step before any time arithmetic, so the planner cannot
-- evaluate the conversion on them first. Probe 088 plants such an event.
CREATE OR REPLACE FUNCTION checkin_reports_due()
RETURNS TABLE (event_id uuid, owner_id uuid, closes_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH valid AS MATERIALIZED (
    SELECT e.event_id, ev.created_by, ev.date, ev.timezone
      FROM leod_checkin_entitlements e
      JOIN leod_events ev ON ev.id = e.event_id
      JOIN pg_timezone_names tz ON tz.name = ev.timezone
     WHERE e.status = 'live' AND e.report_sent_at IS NULL AND ev.date IS NOT NULL
  ), timed AS (
    SELECT event_id, created_by, ((date + 3)::timestamp AT TIME ZONE timezone) AS closes_at FROM valid
  )
  SELECT event_id, created_by, closes_at FROM timed
   WHERE now() >= closes_at + interval '2 hours'
     AND now() <  closes_at + interval '30 days'
   ORDER BY closes_at;
$$;
REVOKE ALL ON FUNCTION checkin_reports_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_reports_due() TO service_role;
