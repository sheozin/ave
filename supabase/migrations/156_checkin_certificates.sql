-- 156_checkin_certificates.sql
-- Certificates of attendance. With the switch on, the thank-you email
-- (migration 110, sent only to guests who checked in) carries a link to the
-- guest's own certificate page, app.cuedeck.io/c/<token>, which they can
-- save as a PDF. The page shows what CueDeck knows: the guest checked in
-- at this event, when, and which rooms they were scanned into. Not time
-- spent: scans record entering a room, never leaving it, so a duration
-- would be invented.
--
-- The page is the proof: it is read live, so a check-in that is undone, an
-- event put back into test mode or certificates switched off makes the
-- link stop showing a certificate.
--
-- Tokens are 128 random bits per guest, made when first needed. Anyone can
-- read a certificate by its token (that is the point of sharing it); no
-- one can list them.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS certificate_enabled boolean NOT NULL DEFAULT false;
GRANT SELECT (certificate_enabled) ON leod_checkin_entitlements TO authenticated;

CREATE TABLE IF NOT EXISTS leod_checkin_certificates (
  attendee_id uuid        PRIMARY KEY REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  event_id    uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  token       text        NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{32}$'),
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE leod_checkin_certificates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_certificates FROM anon, authenticated;

-- The guest's token, made on first use. For the sender (service role) and
-- through checkin_certificate_link for an organizer.
CREATE OR REPLACE FUNCTION checkin_certificate_token(p_attendee_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_token text; v_event uuid;
BEGIN
  SELECT token INTO v_token FROM leod_checkin_certificates WHERE attendee_id = p_attendee_id;
  IF v_token IS NOT NULL THEN RETURN v_token; END IF;
  SELECT event_id INTO v_event FROM leod_checkin_attendees WHERE id = p_attendee_id;
  IF v_event IS NULL THEN RETURN NULL; END IF;
  INSERT INTO leod_checkin_certificates (attendee_id, event_id, token)
  VALUES (p_attendee_id, v_event, encode(extensions.gen_random_bytes(16), 'hex'))
  ON CONFLICT (attendee_id) DO NOTHING;
  SELECT token INTO v_token FROM leod_checkin_certificates WHERE attendee_id = p_attendee_id;
  RETURN v_token;
END;
$$;
REVOKE ALL ON FUNCTION checkin_certificate_token(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_certificate_token(uuid) TO service_role;

-- An organizer opens a guest's certificate (the preview in Setup).
CREATE OR REPLACE FUNCTION checkin_certificate_link(p_event_id uuid, p_attendee_id uuid)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF checkin_role_for_event(p_event_id) IS DISTINCT FROM 'organizer' THEN
    RAISE EXCEPTION 'Only an organizer can open guests'' certificates' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM leod_checkin_attendees WHERE id = p_attendee_id AND event_id = p_event_id) THEN
    RAISE EXCEPTION 'Guest not found' USING ERRCODE = 'P0002';
  END IF;
  RETURN checkin_certificate_token(p_attendee_id);
END;
$$;
REVOKE ALL ON FUNCTION checkin_certificate_link(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_certificate_link(uuid, uuid) TO authenticated;

-- The certificate page. NULL unless the guest checked in, the event is live
-- (not test mode) and certificates are on. Names only what the certificate
-- prints: no email, phone, ticket price or QR code.
CREATE OR REPLACE FUNCTION checkin_certificate(p_token text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v jsonb;
BEGIN
  IF p_token IS NULL OR p_token !~ '^[0-9a-f]{32}$' THEN RETURN NULL; END IF;
  SELECT jsonb_build_object(
           'guest', btrim(a.first_name || ' ' || a.last_name),
           'company', NULLIF(btrim(a.company), ''),
           'event', ev.name,
           'venue', ev.venue,
           'date', ev.date,
           'timezone', ev.timezone,
           'checked_in_at', a.checked_in_at,
           'host', NULLIF(btrim(e.registration_host_name), ''),
           'brand_color', e.registration_brand_color,
           'logo_path', e.registration_logo_path,
           'white_label', e.white_label,
           'code', upper(substr(c.token, 1, 4) || '-' || substr(c.token, 5, 4)),
           'rooms', COALESCE((
             SELECT jsonb_agg(jsonb_build_object('name', r.name, 'first_at', r.first_at) ORDER BY r.first_at)
               FROM (SELECT sp.name, min(se.scanned_at) AS first_at
                       FROM leod_checkin_scan_events se
                       JOIN leod_checkin_scan_points sp ON sp.id = se.scan_point_id
                      WHERE se.attendee_id = a.id AND se.event_id = a.event_id
                        AND se.result = 'ok' AND sp.kind = 'interior'
                      GROUP BY sp.id, sp.name) r), '[]'::jsonb))
    INTO v
    FROM leod_checkin_certificates c
    JOIN leod_checkin_attendees a ON a.id = c.attendee_id
    JOIN leod_events ev ON ev.id = a.event_id
    JOIN leod_checkin_entitlements e ON e.event_id = a.event_id
   WHERE c.token = p_token
     AND a.checked_in_at IS NOT NULL AND NOT a.is_test
     AND e.status = 'live' AND e.certificate_enabled;
  RETURN v;
END;
$$;
REVOKE ALL ON FUNCTION checkin_certificate(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION checkin_certificate(text) TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
