-- 125_checkin_registration_analytics.sql
-- Registration analytics for Event admin, Reports.
--
-- Visitors: unique per event, day and source, counted by checkin-register
-- when the page loads. No cookies and no stored addresses: the function
-- passes a salted hash of the IP, kept 2 days in leod_checkin_web_seen to
-- count each visitor once a day, then deleted.
-- Sources: 'direct', 'embed' (the form on the organizer's site), 'invite'
-- (a personal invitation), or a campaign tag from ?ref= / ?utm_source=
-- (lower case letters, digits, - and _, at most 32).
-- A registration keeps its source: on the pending request (ref), on an
-- order being paid (ref), and on the guest (reg_source), set by
-- checkin-register when the guest confirms, pays or answers an invitation.

CREATE TABLE IF NOT EXISTS leod_checkin_web_views (
  event_id uuid NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  day      date NOT NULL,
  source   text NOT NULL CHECK (source ~ '^[a-z0-9_-]{1,32}$'),
  visitors int  NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, day, source)
);
ALTER TABLE leod_checkin_web_views ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_web_views FROM anon, authenticated;

CREATE TABLE IF NOT EXISTS leod_checkin_web_seen (
  event_id uuid NOT NULL,
  day      date NOT NULL,
  ip_hash  text NOT NULL,
  PRIMARY KEY (event_id, day, ip_hash)
);
ALTER TABLE leod_checkin_web_seen ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_web_seen FROM anon, authenticated;

ALTER TABLE leod_checkin_web_pending ADD COLUMN IF NOT EXISTS ref text CHECK (ref IS NULL OR ref ~ '^[a-z0-9_-]{1,32}$');
ALTER TABLE leod_checkin_web_orders  ADD COLUMN IF NOT EXISTS ref text CHECK (ref IS NULL OR ref ~ '^[a-z0-9_-]{1,32}$');
ALTER TABLE leod_checkin_attendees   ADD COLUMN IF NOT EXISTS reg_source text CHECK (reg_source IS NULL OR reg_source ~ '^[a-z0-9_-]{1,32}$');

-- One visitor, once a day per source. Answers nothing worth reading.
CREATE OR REPLACE FUNCTION checkin_web_count_view(p_code text, p_source text, p_ip_hash text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event uuid;
  v_day   date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_source IS NULL OR p_source !~ '^[a-z0-9_-]{1,32}$' OR COALESCE(p_ip_hash, '') !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  SELECT event_id INTO v_event FROM leod_checkin_entitlements WHERE registration_code = p_code AND registration_enabled AND checkin_core;
  IF v_event IS NULL THEN RETURN; END IF;
  -- The same visitor counts once a day per event, whatever source they came by.
  INSERT INTO leod_checkin_web_seen (event_id, day, ip_hash) VALUES (v_event, v_day, p_ip_hash) ON CONFLICT DO NOTHING;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO leod_checkin_web_views (event_id, day, source, visitors) VALUES (v_event, v_day, p_source, 1)
  ON CONFLICT (event_id, day, source) DO UPDATE SET visitors = leod_checkin_web_views.visitors + 1;
  -- Hashes are only needed for today and yesterday.
  DELETE FROM leod_checkin_web_seen WHERE day < v_day - 1;
END;
$$;
REVOKE ALL ON FUNCTION checkin_web_count_view(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_count_view(text, text, text) TO service_role;

-- ── Organizer: the numbers ────────────────────────────────────────
CREATE OR REPLACE FUNCTION checkin_registration_analytics(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_test boolean;
  v_from date := (now() AT TIME ZONE 'UTC')::date - 29;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see registration analytics' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status IS DISTINCT FROM 'live' INTO v_test FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  v_test := COALESCE(v_test, true);
  RETURN jsonb_build_object(
    'test', v_test,
    'visitors', (SELECT COALESCE(sum(visitors), 0) FROM leod_checkin_web_views WHERE event_id = p_event_id),
    'visitors_by_source', (SELECT COALESCE(jsonb_agg(jsonb_build_object('source', source, 'n', n) ORDER BY n DESC), '[]'::jsonb)
                             FROM (SELECT source, sum(visitors) n FROM leod_checkin_web_views WHERE event_id = p_event_id GROUP BY source) x),
    'visitors_by_day', (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', day, 'n', n) ORDER BY day), '[]'::jsonb)
                          FROM (SELECT day, sum(visitors) n FROM leod_checkin_web_views WHERE event_id = p_event_id AND day >= v_from GROUP BY day) x),
    'registrations_by_day', (SELECT COALESCE(jsonb_agg(jsonb_build_object('day', day, 'n', n) ORDER BY day), '[]'::jsonb)
                               FROM (SELECT (created_at AT TIME ZONE 'UTC')::date AS day, count(*) AS n FROM leod_checkin_attendees
                                      WHERE event_id = p_event_id AND is_test = v_test AND source = 'web'
                                        AND created_at >= v_from GROUP BY 1) x),
    'registrations_by_source', (SELECT COALESCE(jsonb_agg(jsonb_build_object('source', s, 'n', n) ORDER BY n DESC), '[]'::jsonb)
                                  FROM (SELECT COALESCE(reg_source, 'direct') s, count(*) n FROM leod_checkin_attendees
                                         WHERE event_id = p_event_id AND is_test = v_test AND source = 'web' GROUP BY 1) x),
    'guests', (SELECT jsonb_build_object(
                 'total', count(*),
                 'registered', count(*) FILTER (WHERE source = 'web'),
                 'plus_ones', count(*) FILTER (WHERE source = 'plus_one'),
                 'imported', count(*) FILTER (WHERE source = 'import'),
                 'walk_ins', count(*) FILTER (WHERE source IN ('kiosk', 'walk_in')),
                 'checked_in', count(*) FILTER (WHERE checked_in_at IS NOT NULL),
                 'qr_sent', count(*) FILTER (WHERE qr_email_sent_at IS NOT NULL))
                 FROM leod_checkin_attendees WHERE event_id = p_event_id AND is_test = v_test),
    'held', (SELECT jsonb_build_object('waitlist', count(*) FILTER (WHERE kind = 'waitlist'), 'approval', count(*) FILTER (WHERE kind = 'approval'))
               FROM leod_checkin_held WHERE event_id = p_event_id AND is_test = v_test),
    'invitations', (SELECT jsonb_build_object('sent', count(*), 'going', count(*) FILTER (WHERE rsvp = 'going'),
                      'not_going', count(*) FILTER (WHERE rsvp = 'not_going'), 'no_answer', count(*) FILTER (WHERE rsvp IS NULL))
                      FROM leod_checkin_web_invites WHERE event_id = p_event_id),
    'orders', (SELECT jsonb_build_object('paid', count(*) FILTER (WHERE status = 'paid'), 'paying', count(*) FILTER (WHERE status = 'open'),
                 'abandoned', count(*) FILTER (WHERE status = 'expired'), 'refunded', count(*) FILTER (WHERE status = 'refunded'),
                 'revenue', (SELECT COALESCE(jsonb_object_agg(currency, c), '{}'::jsonb) FROM
                              (SELECT currency, sum(amount_cents) c FROM leod_checkin_web_orders WHERE event_id = p_event_id AND status = 'paid' GROUP BY currency) r))
                 FROM leod_checkin_web_orders WHERE event_id = p_event_id),
    'emails', (SELECT jsonb_build_object('reminders', count(*) FILTER (WHERE kind = 'reminder'), 'thankyous', count(*) FILTER (WHERE kind = 'thankyou'))
                 FROM leod_checkin_reminder_sends WHERE event_id = p_event_id));
END;
$$;
REVOKE ALL ON FUNCTION checkin_registration_analytics(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_registration_analytics(uuid) TO authenticated;
