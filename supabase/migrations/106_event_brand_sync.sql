-- 106_event_brand_sync.sql
-- The Event admin's Branding tab is the one place an event's brand is set.
-- The registration page, guest emails and (through leod_events.brand_color)
-- the console's displays all read it. checkin_set_registration_page now
-- copies the colour onto the event.

CREATE OR REPLACE FUNCTION checkin_set_registration_page(
  p_event_id uuid, p_host_name text, p_description text, p_address text, p_brand_color text,
  p_cover_path text, p_logo_path text, p_show_programme boolean)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row leod_checkin_entitlements;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change the registration page'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  BEGIN
    UPDATE leod_checkin_entitlements
       SET registration_host_name      = NULLIF(btrim(p_host_name), ''),
           registration_description    = NULLIF(btrim(p_description), ''),
           registration_address        = NULLIF(btrim(p_address), ''),
           registration_brand_color    = NULLIF(btrim(p_brand_color), ''),
           registration_cover_path     = NULLIF(p_cover_path, ''),
           registration_logo_path      = NULLIF(p_logo_path, ''),
           registration_show_programme = COALESCE(p_show_programme, false)
     WHERE event_id = p_event_id
    RETURNING * INTO v_row;
  EXCEPTION WHEN check_violation THEN
    RAISE EXCEPTION 'Check the page details: host name up to 80 characters, description up to 2000, address up to 200, colour as #RRGGBB'
      USING ERRCODE = '22023';
  END;
  IF v_row.event_id IS NULL THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  -- One brand per event (Event admin, 2026-10-06): the console's displays
  -- read leod_events.brand_color, so the Branding tab's colour is theirs too.
  -- Only a set colour is copied; clearing the page colour leaves the event's.
  IF v_row.registration_brand_color IS NOT NULL THEN
    UPDATE leod_events SET brand_color = v_row.registration_brand_color WHERE id = p_event_id;
  END IF;
  RETURN jsonb_build_object(
    'host_name', v_row.registration_host_name, 'description', v_row.registration_description,
    'address', v_row.registration_address, 'brand_color', v_row.registration_brand_color,
    'cover_path', v_row.registration_cover_path, 'logo_path', v_row.registration_logo_path,
    'show_programme', v_row.registration_show_programme);
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_registration_page(uuid, text, text, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_registration_page(uuid, text, text, text, text, text, text, boolean) TO authenticated;
