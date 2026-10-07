-- 107_checkin_public_storage_read.sql
-- Branding uploads failed for every organizer: Supabase Storage saves an
-- upload with INSERT ... RETURNING, and Postgres applies SELECT policies to
-- the returned row. Migration 104 had no SELECT policy on purpose (nobody
-- may list the bucket), so every upload was refused with "new row violates
-- row-level security policy". The 104 probe used a plain INSERT and missed
-- it; it now uses RETURNING, as Storage does.
--
-- Read access is the same as write access: the event's owner and its
-- organizers, inside that event's folder only. Guests still load images by
-- public URL, which needs no policy, and nobody else can list the bucket.
DROP POLICY IF EXISTS checkin_public_select ON storage.objects;
CREATE POLICY checkin_public_select ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'checkin-public' AND CASE
    WHEN name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/(cover|logo)-[a-z0-9]{8,32}\.(jpg|png|webp)$'
    THEN checkin_can_edit_page(substr(name, 1, 36)::uuid) ELSE false END);
