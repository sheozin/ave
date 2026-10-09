-- 135_display_offline_status.sql
-- Each screen says whether it can keep going without the internet: the page
-- itself saved, its last data saved, and (Video Loop) its video saved in
-- full. The console shows it on the display card, so readiness is checked
-- before doors open rather than discovered during an outage.
--
-- Written only by display_report_offline, which the screen calls with its own
-- display key (the same check as display_feed). The status is a small fixed
-- shape; anything else is refused.

ALTER TABLE leod_signage_displays
  ADD COLUMN IF NOT EXISTS offline_status jsonb,
  ADD COLUMN IF NOT EXISTS offline_reported_at timestamptz;

CREATE OR REPLACE FUNCTION display_report_offline(p_display_id uuid, p_secret text, p_status jsonb)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_video text := p_status->>'video';
BEGIN
  IF p_status IS NULL OR jsonb_typeof(p_status) <> 'object' OR length(p_status::text) > 500
     OR (p_status - ARRAY['shell','data','video','bytes','total']) <> '{}'::jsonb
     OR jsonb_typeof(coalesce(p_status->'shell', 'false')) <> 'boolean'
     OR jsonb_typeof(coalesce(p_status->'data', 'false')) <> 'boolean'
     OR (v_video IS NOT NULL AND v_video NOT IN ('none', 'saving', 'saved', 'failed', 'no_space'))
     OR (p_status ? 'bytes' AND jsonb_typeof(p_status->'bytes') <> 'number')
     OR (p_status ? 'total' AND jsonb_typeof(p_status->'total') <> 'number') THEN
    RETURN false;
  END IF;
  UPDATE leod_signage_displays
     SET offline_status = p_status, offline_reported_at = now()
   WHERE id = p_display_id AND display_secret IS NOT NULL AND display_secret = p_secret;
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION display_report_offline(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION display_report_offline(uuid, text, jsonb) TO anon, authenticated;
