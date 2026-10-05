-- 072_checkin_event_stats.sql
-- One call for the check-in dashboard: tile numbers, five breakdowns,
-- and (owner, organizer, lead only) desk health, desk speeds and offline
-- gaps. Counts and labels only, never names, emails or companies, which
-- is what lets a viewer use it (roles ruling 5).
-- Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md (Check-in dashboard)
--         docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md (features 1, 2)
--
-- Desks are identified to the client by label only, never by desk_id: a
-- desk role that learned another desk's id could overwrite its heartbeat
-- row. Speeds and gaps are joined to the desk row for the label, so a
-- desk hidden from the desk list is hidden from them too. Once the event
-- is live, test desks are excluded (go-live deletes them; this is the
-- defensive copy of that rule).
-- Arrivals, check-in counts and the last 25 minutes come from
-- leod_checkin_attendees.checked_in_at, so an undone check-in never
-- counts and a re-check-in counts once, at its latest time.
CREATE OR REPLACE FUNCTION checkin_event_stats(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role   text := checkin_role_for_event(p_event_id);
  v_eff    text;
  v_status text;
  v_live   boolean;
  v_out    jsonb;
  v_ops    jsonb := NULL;
BEGIN
  IF auth.uid() IS NULL OR v_role IS NULL OR v_role NOT IN ('organizer', 'lead', 'crew', 'viewer') THEN
    RAISE EXCEPTION 'Not on this event' USING ERRCODE = 'insufficient_privilege';
  END IF;
  v_eff := CASE WHEN checkin_is_owner(p_event_id) THEN 'owner' ELSE v_role END;
  SELECT status INTO v_status FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  v_live := v_status = 'live';

  SELECT jsonb_build_object(
    'registered', count(*)::int,
    'checked_in', (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int,
    'walk_ins',   (count(*) FILTER (WHERE source IN ('kiosk', 'walk_in')))::int,
    'by_source',  jsonb_build_object(
                    'import',  (count(*) FILTER (WHERE source = 'import'))::int,
                    'kiosk',   (count(*) FILTER (WHERE source = 'kiosk'))::int,
                    'walk_in', (count(*) FILTER (WHERE source = 'walk_in'))::int),
    'qr',         jsonb_build_object(
                    'sent',     (count(*) FILTER (WHERE qr_email_sent_at IS NOT NULL))::int,
                    'not_sent', (count(*) FILTER (WHERE qr_email_sent_at IS NULL AND NULLIF(btrim(email), '') IS NOT NULL))::int,
                    'no_email', (count(*) FILTER (WHERE qr_email_sent_at IS NULL AND NULLIF(btrim(email), '') IS NULL))::int)
  ) INTO v_out
  FROM leod_checkin_attendees WHERE event_id = p_event_id;

  v_out := v_out || jsonb_build_object(
    'role', v_eff,
    'status', COALESCE(v_status, 'test'),
    'generated_at', now(),
    'by_ticket', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('ticket_type', ticket_type, 'registered', reg, 'checked_in', arr)
                                ORDER BY reg DESC, ticket_type), '[]'::jsonb)
        FROM (SELECT ticket_type, count(*)::int AS reg,
                     (count(*) FILTER (WHERE checked_in_at IS NOT NULL))::int AS arr
                FROM leod_checkin_attendees WHERE event_id = p_event_id GROUP BY ticket_type) t),
    'arrivals', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('t', b, 'n', n) ORDER BY b), '[]'::jsonb)
        FROM (SELECT (floor(extract(epoch FROM checked_in_at) / 900) * 900)::bigint AS b, count(*)::int AS n
                FROM leod_checkin_attendees
               WHERE event_id = p_event_id AND checked_in_at IS NOT NULL
               GROUP BY 1) x),
    'last_25_min', (
      SELECT jsonb_agg(COALESCE(c.n, 0) ORDER BY m.i DESC)
        FROM generate_series(0, 24) AS m(i)
        LEFT JOIN (SELECT date_trunc('minute', checked_in_at) AS mm, count(*)::int AS n
                     FROM leod_checkin_attendees
                    WHERE event_id = p_event_id
                      AND checked_in_at >= date_trunc('minute', now()) - interval '24 minutes'
                    GROUP BY 1) c
          ON c.mm = date_trunc('minute', now()) - make_interval(mins => m.i))
  );

  IF v_eff IN ('owner', 'organizer', 'lead') THEN
    v_ops := jsonb_build_object(
      'desks', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'label', d.label,
                 'operator', COALESCE(NULLIF(btrim(u.name), ''), u.email),
                 'last_seen_at', d.last_seen_at,
                 'seconds_since_seen', floor(extract(epoch FROM now() - d.last_seen_at))::int,
                 'pending_count', d.pending_count) ORDER BY d.label), '[]'::jsonb)
          FROM leod_checkin_desks d
          LEFT JOIN leod_users u ON u.id = d.operator_id
         WHERE d.event_id = p_event_id AND NOT (v_live AND d.is_test)),
      'kiosks', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'label', k.label, 'last_seen_at', k.last_seen_at,
                 'seconds_since_seen', CASE WHEN k.last_seen_at IS NULL THEN NULL
                                            ELSE floor(extract(epoch FROM now() - k.last_seen_at))::int END)
                 ORDER BY k.label), '[]'::jsonb)
          FROM leod_checkin_devices k
         WHERE k.event_id = p_event_id AND k.kind = 'kiosk' AND k.revoked_at IS NULL),
      -- Busiest 15 minutes per desk: for every 'ok' scan, the 'ok' scans of
      -- the same desk in the 15 minutes from it; the maximum is the busiest window.
      'speeds', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'label', d.label, 'busiest_15', s.busiest, 'active_minutes', s.active_minutes,
                 'first_at', s.first_at, 'last_at', s.last_at) ORDER BY d.label), '[]'::jsonb)
          FROM (SELECT desk_id, max(c)::int AS busiest,
                       count(DISTINCT date_trunc('minute', scanned_at))::int AS active_minutes,
                       min(scanned_at) AS first_at, max(scanned_at) AS last_at
                  FROM (SELECT desk_id, scanned_at,
                               count(*) OVER (PARTITION BY desk_id ORDER BY scanned_at
                                              RANGE BETWEEN CURRENT ROW AND INTERVAL '15 minutes' FOLLOWING) AS c
                          FROM leod_checkin_scan_events
                         WHERE event_id = p_event_id AND desk_id IS NOT NULL AND result = 'ok') w
                 GROUP BY desk_id) s
          JOIN leod_checkin_desks d ON d.event_id = p_event_id AND d.desk_id = s.desk_id
         WHERE NOT (v_live AND d.is_test)),
      -- Offline gaps proven: per desk, in scanned_at order, a run of scans
      -- that reached the server more than 60 s after they were made
      -- (gaps-and-islands). Latest 50 gaps, newest first.
      'gaps', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                 'label', g.label, 'start_at', g.start_at, 'end_at', g.end_at, 'synced_ok', g.synced_ok)
                 ORDER BY g.start_at DESC, g.label), '[]'::jsonb)
          FROM (SELECT d.label, min(b.scanned_at) AS start_at, max(b.scanned_at) AS end_at,
                       (count(*) FILTER (WHERE b.result = 'ok'))::int AS synced_ok
                  FROM (SELECT desk_id, scanned_at, result, late,
                               row_number() OVER (PARTITION BY desk_id ORDER BY scanned_at, id)
                             - row_number() OVER (PARTITION BY desk_id, late ORDER BY scanned_at, id) AS grp
                          FROM (SELECT desk_id, scanned_at, result, id,
                                       (received_at - scanned_at) > interval '60 seconds' AS late
                                  FROM leod_checkin_scan_events
                                 WHERE event_id = p_event_id AND desk_id IS NOT NULL) a) b
                  JOIN leod_checkin_desks d ON d.event_id = p_event_id AND d.desk_id = b.desk_id
                 WHERE b.late AND NOT (v_live AND d.is_test)
                 GROUP BY b.desk_id, d.label, b.grp
                 ORDER BY min(b.scanned_at) DESC
                 LIMIT 50) g)
    );
  END IF;

  RETURN v_out || jsonb_build_object('ops', v_ops);
END;
$$;
REVOKE ALL ON FUNCTION checkin_event_stats(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_event_stats(uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
