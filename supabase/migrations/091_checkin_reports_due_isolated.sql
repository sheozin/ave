-- 091_checkin_reports_due_isolated.sql
-- Review of 090 (incomplete fix): filtering unknown time zones was not
-- enough. leod_events.date is also owner-written with no bound, and a date
-- past timestamp range (e.g. 294277-01-01) makes `(date + 3)::timestamp`
-- raise, again failing the due list for every owner. Validating each bad
-- value one by one only waits for the next one, so the close time is now
-- computed per event inside its own exception block: a row that cannot be
-- computed is skipped, whatever the reason. Probe 088 plants both kinds.
CREATE OR REPLACE FUNCTION checkin_reports_due()
RETURNS TABLE (event_id uuid, owner_id uuid, closes_at timestamptz)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   record;
  v_close timestamptz;
BEGIN
  FOR v_row IN
    SELECT e.event_id AS eid, ev.created_by AS owner, ev.date AS d, ev.timezone AS tz
      FROM leod_checkin_entitlements e
      JOIN leod_events ev ON ev.id = e.event_id
     WHERE e.status = 'live' AND e.report_sent_at IS NULL
       AND ev.date IS NOT NULL AND ev.timezone IS NOT NULL
  LOOP
    BEGIN
      v_close := ((v_row.d + 3)::timestamp AT TIME ZONE v_row.tz);
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;   -- unknown zone, date out of range, anything else: skip this event only
    END;
    IF now() >= v_close + interval '2 hours' AND now() < v_close + interval '30 days' THEN
      event_id := v_row.eid; owner_id := v_row.owner; closes_at := v_close;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION checkin_reports_due() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_reports_due() TO service_role;
