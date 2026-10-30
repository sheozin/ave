-- 141_checkin_badge_stock_tags.sql
-- Badges, round two. checkin_set_badge_design (111) learns three keys:
--   title   boolean: the guest's job title (role_title) under the name
--   slot    'none', 'slot' or 'holes': where the lanyard goes, so the
--           badge keeps text out of the top 10 mm
--   tags    { ticket type: 'SPEAKER' }, at most 12, each 1..24 characters:
--           a delegate tag printed as a ribbon across the bottom, in that
--           type's colour from `colors`
--   template null or 'visa-next-full': a fixed client layout drawn by
--           checkin-badge.js (62 mm Brother roll, cut at 76 mm); it fixes
--           the size at 76 x 62 mm
-- Sizes are unchanged (50..200 x 40..200 mm); the new stock presets are all
-- inside them. Everything else is as in 111.

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
  v_tags   jsonb := '{}'::jsonb;
  v_t      text;
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
  IF p_design->>'template' = 'visa-next-full' THEN v_w := 76; v_h := 62; END IF;
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
  v_n := 0;
  IF jsonb_typeof(p_design->'tags') = 'object' THEN
    FOR v_k, v_v IN SELECT key, value #>> '{}' FROM jsonb_each(p_design->'tags') LOOP
      v_t := btrim(coalesce(v_v, ''));
      CONTINUE WHEN v_t = '';
      IF char_length(btrim(v_k)) BETWEEN 1 AND 60 AND char_length(v_t) <= 24 AND v_t !~ '[[:cntrl:]]' THEN
        v_n := v_n + 1;
        IF v_n > 12 THEN RAISE EXCEPTION 'At most 12 delegate tags' USING ERRCODE = 'check_violation'; END IF;
        v_tags := v_tags || jsonb_build_object(btrim(v_k), v_t);
      ELSE
        RAISE EXCEPTION 'A delegate tag is at most 24 characters' USING ERRCODE = 'check_violation';
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
    'colors', v_colors,
    'title', (p_design->'title') = 'true'::jsonb,
    'slot', CASE WHEN p_design->>'slot' IN ('slot', 'holes') THEN p_design->>'slot' ELSE 'none' END,
    'tags', v_tags,
    'template', CASE WHEN p_design->>'template' = 'visa-next-full' THEN to_jsonb('visa-next-full'::text) ELSE 'null'::jsonb END);
  UPDATE leod_checkin_entitlements SET badge_design = v_out WHERE event_id = p_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Check-in is not enabled for this event' USING ERRCODE = 'P0002'; END IF;
  RETURN v_out;
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_badge_design(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_badge_design(uuid, jsonb) TO authenticated;
