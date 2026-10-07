-- 122_checkin_page_language.sql
-- The registration page's language (Event admin, Registration): 'auto'
-- follows each guest's browser; 'en', 'pl', 'de' or 'ar' fixes it. Only
-- CueDeck's own wording is translated (checkin-register-i18n.js); what the
-- organizer typed is shown as written.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS registration_language text NOT NULL DEFAULT 'auto'
  CHECK (registration_language IN ('auto', 'en', 'pl', 'de', 'ar'));

CREATE OR REPLACE FUNCTION checkin_set_registration_language(p_event_id uuid, p_language text)
RETURNS text
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change the page language' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_language IS NULL OR p_language NOT IN ('auto', 'en', 'pl', 'de', 'ar') THEN
    RAISE EXCEPTION 'That language is not offered' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE leod_checkin_entitlements SET registration_language = p_language WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN p_language;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_registration_language(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_registration_language(uuid, text) TO authenticated;
