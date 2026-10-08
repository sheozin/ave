-- 128_checkin_white_label.sql
-- White label (Event admin, Branding): guests see the organizer's brand and
-- not CueDeck's. On: the registration page drops "Registration by CueDeck",
-- guest emails drop their "powered by CueDeck" footer, and the registration
-- confirmation is sent as "Event Registration" instead of "CueDeck
-- Registration". The consent text naming CueDeck as processor and the
-- privacy link stay: that is a data protection disclosure, not branding.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS white_label boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION checkin_set_white_label(p_event_id uuid, p_on boolean)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change white label' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_on IS NULL THEN
    RAISE EXCEPTION 'Choose on or off' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE leod_checkin_entitlements SET white_label = p_on WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN p_on;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_white_label(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_white_label(uuid, boolean) TO authenticated;
