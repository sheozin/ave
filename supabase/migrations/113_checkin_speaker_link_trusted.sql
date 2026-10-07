-- 113_checkin_speaker_link_trusted.sql
-- Security fix to 112. The speaker arrival link matched any checked-in guest
-- by name, including names typed on the public registration page or at a
-- self-service kiosk. Anyone could register as a speaker, check in, and the
-- production console would show that speaker as arrived. Now only guests
-- the organizer put on the list (source 'import') or the desk added in
-- person (source 'walk_in', staff saw them) count, for marking a session
-- and for completing a panel. The Guests tab says when a speaker's only
-- match is a self-registration.

CREATE OR REPLACE FUNCTION checkin_arrived_name(p_event_id uuid, p_name text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM leod_checkin_attendees a
                  WHERE a.event_id = p_event_id AND NOT a.is_test AND a.checked_in_at IS NOT NULL
                    AND a.source IN ('import', 'walk_in')
                    AND checkin_norm_name(a.first_name || ' ' || a.last_name) = checkin_norm_name(p_name));
$$;
REVOKE ALL ON FUNCTION checkin_arrived_name(uuid, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_speaker_arrival()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_name text;
  v_s    record;
  v_all  boolean;
BEGIN
  BEGIN
    -- (113) Only guests the organizer listed or the desk added in person:
    -- a name typed on the public page or a kiosk proves nothing.
    IF NEW.source NOT IN ('import', 'walk_in') THEN RETURN NULL; END IF;
    IF NOT EXISTS (SELECT 1 FROM leod_checkin_entitlements WHERE event_id = NEW.event_id AND speaker_link) THEN RETURN NULL; END IF;
    v_name := checkin_norm_name(NEW.first_name || ' ' || NEW.last_name);
    IF v_name = '' THEN RETURN NULL; END IF;
    FOR v_s IN
      SELECT s.id, s.title, s.people, s.speaker FROM leod_sessions s
       WHERE s.event_id = NEW.event_id AND NOT COALESCE(s.speaker_arrived, false)
         AND COALESCE(s.status::text, '') NOT IN ('ENDED', 'CANCELLED')
         AND (EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(s.people, '[]'::jsonb)) p WHERE checkin_norm_name(p->>'name') = v_name)
              OR (jsonb_array_length(COALESCE(s.people, '[]'::jsonb)) = 0 AND checkin_norm_name(s.speaker) = v_name))
    LOOP
      v_all := jsonb_array_length(COALESCE(v_s.people, '[]'::jsonb)) = 0
            OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_s.people) p
                            WHERE COALESCE(p->>'name', '') <> '' AND NOT checkin_arrived_name(NEW.event_id, p->>'name'));
      IF v_all THEN
        UPDATE leod_sessions SET speaker_arrived = true WHERE id = v_s.id AND NOT COALESCE(speaker_arrived, false);
      END IF;
      INSERT INTO leod_event_log (event_id, session_id, ts, action, payload, server_time_ms)
      VALUES (NEW.event_id, v_s.id, now(), 'SPEAKER_CHECKED_IN',
              jsonb_build_object('name', btrim(NEW.first_name || ' ' || NEW.last_name), 'attendee_id', NEW.id,
                                 'session_arrived', v_all, 'source', 'check-in desk'),
              (extract(epoch FROM clock_timestamp()) * 1000)::bigint);
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'checkin_speaker_arrival: % (attendee %)', SQLERRM, NEW.id;
    BEGIN
      INSERT INTO leod_checkin_link_errors (event_id, detail) VALUES (NEW.event_id, left(SQLSTATE || ' ' || SQLERRM, 500));
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
  END;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION checkin_speaker_arrival() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_speaker_links(p_event_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_live boolean;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can see speaker links' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT status = 'live' INTO v_live FROM leod_checkin_entitlements WHERE event_id = p_event_id;
  RETURN jsonb_build_object(
    'enabled', COALESCE((SELECT speaker_link FROM leod_checkin_entitlements WHERE event_id = p_event_id), false),
    'people', (SELECT COALESCE(jsonb_agg(x ORDER BY x->>'time' NULLS LAST, x->>'name'), '[]'::jsonb) FROM (
      SELECT DISTINCT ON (checkin_norm_name(n.name)) jsonb_build_object(
               'name', n.name, 'role', n.role, 'session', n.title,
               'time', to_char(COALESCE(n.scheduled_start, n.planned_start), 'HH24:MI'),
               'on_list', EXISTS (SELECT 1 FROM leod_checkin_attendees a WHERE a.event_id = p_event_id
                                    AND a.is_test = NOT COALESCE(v_live, false) AND a.source IN ('import', 'walk_in')
                                    AND checkin_norm_name(a.first_name || ' ' || a.last_name) = checkin_norm_name(n.name)),
               -- (113) Only a self-registration matches: it cannot mark the speaker arrived.
               'self_only', NOT EXISTS (SELECT 1 FROM leod_checkin_attendees a WHERE a.event_id = p_event_id
                                    AND a.is_test = NOT COALESCE(v_live, false) AND a.source IN ('import', 'walk_in')
                                    AND checkin_norm_name(a.first_name || ' ' || a.last_name) = checkin_norm_name(n.name))
                            AND EXISTS (SELECT 1 FROM leod_checkin_attendees a WHERE a.event_id = p_event_id
                                    AND a.is_test = NOT COALESCE(v_live, false)
                                    AND checkin_norm_name(a.first_name || ' ' || a.last_name) = checkin_norm_name(n.name)),
               'arrived', checkin_arrived_name(p_event_id, n.name)) AS x
        FROM (SELECT s.title, s.scheduled_start, s.planned_start, p->>'name' AS name, COALESCE(p->>'role', 'speaker') AS role
                FROM leod_sessions s, jsonb_array_elements(COALESCE(s.people, '[]'::jsonb)) p
               WHERE s.event_id = p_event_id AND COALESCE(s.status::text, '') <> 'CANCELLED' AND COALESCE(p->>'name', '') <> ''
              UNION ALL
              SELECT s.title, s.scheduled_start, s.planned_start, s.speaker, 'speaker'
                FROM leod_sessions s
               WHERE s.event_id = p_event_id AND COALESCE(s.status::text, '') <> 'CANCELLED'
                 AND jsonb_array_length(COALESCE(s.people, '[]'::jsonb)) = 0 AND COALESCE(btrim(s.speaker), '') <> ''
                 AND s.speaker !~ '[,;&]') n
       ORDER BY checkin_norm_name(n.name), COALESCE(n.scheduled_start, n.planned_start)
    ) t));
END;
$$;
REVOKE ALL ON FUNCTION checkin_speaker_links(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_speaker_links(uuid) TO authenticated;
