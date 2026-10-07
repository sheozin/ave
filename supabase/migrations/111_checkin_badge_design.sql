-- 111_checkin_badge_design.sql
-- The badge designer (Event admin, Badges). One design per event, drawn by
-- checkin-badge.js on the desk, the kiosk and the preview. NULL means the
-- default badge the desk always printed (100 x 70 mm, name, company,
-- ticket type).
--
-- The design is rebuilt here from known keys only, so whatever the client
-- sends, what is stored is a small object of checked values:
--   w, h      stock size in mm (50..200 x 40..200)
--   band      a colour band in the brand colour
--   logo      the Branding logo
--   name      'full' (one line) or 'split' (first name large)
--   company, ticket, qr   booleans
--   align     'center' or 'left'
--   colors    { ticket type: '#RRGGBB' }, at most 12, for a band per ticket type

ALTER TABLE leod_checkin_entitlements ADD COLUMN IF NOT EXISTS badge_design jsonb;

CREATE OR REPLACE FUNCTION checkin_set_badge_design(p_event_id uuid, p_design jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_w      int;
  v_h      int;
  v_colors jsonb := '{}'::jsonb;
  v_k      text;
  v_v      text;
  v_n      int := 0;
  v_out    jsonb;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can change badges' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_design IS NULL OR jsonb_typeof(p_design) <> 'object' THEN
    UPDATE leod_checkin_entitlements SET badge_design = NULL WHERE event_id = p_event_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
    RETURN NULL;
  END IF;
  v_w := CASE WHEN p_design->>'w' ~ '^\d{1,3}$' THEN (p_design->>'w')::int END;
  v_h := CASE WHEN p_design->>'h' ~ '^\d{1,3}$' THEN (p_design->>'h')::int END;
  IF v_w IS NULL OR v_w NOT BETWEEN 50 AND 200 OR v_h IS NULL OR v_h NOT BETWEEN 40 AND 200 THEN
    RAISE EXCEPTION 'Badge size must be 50 to 200 mm wide and 40 to 200 mm tall' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_typeof(p_design->'colors') = 'object' THEN
    FOR v_k, v_v IN SELECT key, value #>> '{}' FROM jsonb_each(p_design->'colors') LOOP
      IF char_length(btrim(v_k)) BETWEEN 1 AND 60 AND v_v ~ '^#[0-9A-Fa-f]{6}$' THEN
        v_n := v_n + 1;
        IF v_n > 12 THEN RAISE EXCEPTION 'At most 12 ticket colours' USING ERRCODE = 'check_violation'; END IF;
        v_colors := v_colors || jsonb_build_object(btrim(v_k), upper(v_v));
      ELSE
        RAISE EXCEPTION 'Ticket colours must look like #1F4ED8' USING ERRCODE = 'check_violation';
      END IF;
    END LOOP;
  END IF;
  v_out := jsonb_build_object(
    'w', v_w, 'h', v_h,
    'band', (p_design->'band') = 'true'::jsonb, 'logo', (p_design->'logo') = 'true'::jsonb,
    'name', CASE WHEN p_design->>'name' = 'split' THEN 'split' ELSE 'full' END,
    'company', (p_design->'company') IS DISTINCT FROM 'false'::jsonb,
    'ticket', (p_design->'ticket') IS DISTINCT FROM 'false'::jsonb,
    'qr', (p_design->'qr') = 'true'::jsonb,
    'align', CASE WHEN p_design->>'align' = 'left' THEN 'left' ELSE 'center' END,
    'colors', v_colors);
  UPDATE leod_checkin_entitlements SET badge_design = v_out WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_badge_design(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_badge_design(uuid, jsonb) TO authenticated;
