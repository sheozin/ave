-- 155_checkin_print_station_down.sql
-- When a print station stops (its laptop closed, the app quit, the venue
-- network changed), badges sent to it sat queued for 10 minutes and then
-- failed, and nobody at the desk was told. Two changes:
--
--   * checkin_print_stations also says how many badges are waiting for
--     each station, so desks and the dashboard can show a stalled queue;
--   * checkin_cancel_print lets a desk take back badges its station has not
--     picked up, so they do not print by surprise later, after the desk has
--     printed them another way. Only badges still queued: one the station
--     has started is left to finish.

DROP FUNCTION IF EXISTS checkin_print_stations(uuid);
CREATE FUNCTION checkin_print_stations(p_event_id uuid)
RETURNS TABLE(id uuid, label text, last_seen_at timestamptz, online boolean, printer_info jsonb,
              last_printed_at timestamptz, printed_today integer, created_at timestamptz, waiting integer)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(p_event_id) IS NULL OR checkin_role_for_event(p_event_id) NOT IN ('organizer', 'lead', 'crew') THEN
    RAISE EXCEPTION 'Only desk roles on this event can see its printers' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN QUERY
    SELECT d.id, d.label, d.last_seen_at, coalesce(d.last_seen_at > now() - interval '45 seconds', false), d.printer_info,
           (SELECT max(j.completed_at) FROM leod_checkin_print_jobs j WHERE j.device_id = d.id AND j.status = 'done'),
           (SELECT count(*)::integer FROM leod_checkin_print_jobs j WHERE j.device_id = d.id AND j.status = 'done' AND j.completed_at > date_trunc('day', now())),
           d.created_at,
           (SELECT count(*)::integer FROM leod_checkin_print_jobs j WHERE j.device_id = d.id AND j.status = 'queued')
      FROM leod_checkin_devices d
     WHERE d.event_id = p_event_id AND d.kind = 'printer' AND d.revoked_at IS NULL
     ORDER BY d.label;
END;
$$;
REVOKE ALL ON FUNCTION checkin_print_stations(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_print_stations(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION checkin_cancel_print(p_event_id uuid, p_job_ids uuid[])
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_n integer;
BEGIN
  IF checkin_role_for_event(p_event_id) IS NULL OR checkin_role_for_event(p_event_id) NOT IN ('organizer', 'lead', 'crew') THEN
    RAISE EXCEPTION 'Only desk roles on this event can cancel badges' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_job_ids IS NULL OR cardinality(p_job_ids) = 0 THEN RETURN 0; END IF;
  IF cardinality(p_job_ids) > 100 THEN
    RAISE EXCEPTION 'At most 100 badges at a time' USING ERRCODE = '22023';
  END IF;
  UPDATE leod_checkin_print_jobs j
     SET status = 'failed', label_png = NULL, completed_at = now(),
         error = 'Cancelled at the desk: the print station did not pick it up'
   WHERE j.id = ANY (p_job_ids) AND j.status = 'queued'
     AND j.device_id IN (SELECT d.id FROM leod_checkin_devices d WHERE d.event_id = p_event_id);
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n;
END;
$$;
REVOKE ALL ON FUNCTION checkin_cancel_print(uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_cancel_print(uuid, uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';
