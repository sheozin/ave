-- 104_checkin_registration_page_design.sql
-- The registration page becomes an event page: cover image, logo, brand
-- colour, host name, description, address (for Maps) and an optional
-- programme from the live run of show. Design approved 2026-10-06
-- (canvas "CueDeck Registration Page Redesign").
--
-- Images live in a dedicated public bucket, checkin-public, at
-- <event_id>/<cover|logo>-<random>.<jpg|png|webp>. JPEG, PNG and WebP only
-- (no SVG: it can carry script), 5 MB. Only the event's owner or an
-- organizer may upload or delete, and only under their event's folder. No
-- SELECT policy: objects are served by public URL, and nobody can list the
-- bucket.

ALTER TABLE leod_checkin_entitlements
  ADD COLUMN IF NOT EXISTS registration_host_name      text,
  ADD COLUMN IF NOT EXISTS registration_description    text,
  ADD COLUMN IF NOT EXISTS registration_address        text,
  ADD COLUMN IF NOT EXISTS registration_brand_color    text,
  ADD COLUMN IF NOT EXISTS registration_cover_path     text,
  ADD COLUMN IF NOT EXISTS registration_logo_path      text,
  ADD COLUMN IF NOT EXISTS registration_show_programme boolean NOT NULL DEFAULT false;

ALTER TABLE leod_checkin_entitlements
  DROP CONSTRAINT IF EXISTS checkin_registration_page_fields,
  ADD  CONSTRAINT checkin_registration_page_fields CHECK (
        (registration_host_name   IS NULL OR length(registration_host_name)   BETWEEN 1 AND 80)
    AND (registration_description IS NULL OR length(registration_description) BETWEEN 1 AND 2000)
    AND (registration_address     IS NULL OR length(registration_address)     BETWEEN 1 AND 200)
    AND (registration_brand_color IS NULL OR registration_brand_color ~ '^#[0-9A-Fa-f]{6}$')
    AND (registration_cover_path  IS NULL OR registration_cover_path ~ ('^' || event_id::text || '/cover-[a-z0-9]{8,32}\.(jpg|png|webp)$'))
    AND (registration_logo_path   IS NULL OR registration_logo_path  ~ ('^' || event_id::text || '/logo-[a-z0-9]{8,32}\.(jpg|png|webp)$')));

-- Who may change an event's registration page. STABLE, answers false for a
-- stranger (guard G10 checks exactly that).
CREATE OR REPLACE FUNCTION checkin_can_edit_page(p_event_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND COALESCE(checkin_is_owner(p_event_id) OR checkin_role_for_event(p_event_id) = 'organizer', false);
$$;
REVOKE ALL ON FUNCTION checkin_can_edit_page(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_can_edit_page(uuid) TO authenticated;

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
  RETURN jsonb_build_object(
    'host_name', v_row.registration_host_name, 'description', v_row.registration_description,
    'address', v_row.registration_address, 'brand_color', v_row.registration_brand_color,
    'cover_path', v_row.registration_cover_path, 'logo_path', v_row.registration_logo_path,
    'show_programme', v_row.registration_show_programme);
END;
$$;
REVOKE ALL ON FUNCTION checkin_set_registration_page(uuid, text, text, text, text, text, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_set_registration_page(uuid, text, text, text, text, text, text, boolean) TO authenticated;

-- ── Storage ───────────────────────────────────────────────────────
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('checkin-public', 'checkin-public', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO UPDATE
  SET public = true, file_size_limit = 5242880, allowed_mime_types = ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- The name is checked by pattern BEFORE the uuid cast (CASE, not AND: SQL
-- does not promise AND evaluates left to right).
DROP POLICY IF EXISTS checkin_public_insert ON storage.objects;
CREATE POLICY checkin_public_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'checkin-public' AND CASE
    WHEN name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(cover|logo)-[a-z0-9]{8,32}\.(jpg|png|webp)$'
    THEN checkin_can_edit_page(substr(name, 1, 36)::uuid) ELSE false END);

DROP POLICY IF EXISTS checkin_public_delete ON storage.objects;
CREATE POLICY checkin_public_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'checkin-public' AND CASE
    WHEN name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(cover|logo)-[a-z0-9]{8,32}\.(jpg|png|webp)$'
    THEN checkin_can_edit_page(substr(name, 1, 36)::uuid) ELSE false END);
