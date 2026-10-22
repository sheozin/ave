-- 138: leod-assets writes scoped to the event's director or signage staff.
--
-- Before: policy leod_assets_auth_all let ANY signed-in account insert,
-- overwrite or delete ANY object in the public leod-assets bucket, of any
-- type and any size. Anyone can create an account, so a stranger could
-- replace or delete another event's display videos and sponsor logos, or
-- host arbitrary files on our storage.
--
-- After: the console writes only displays/<event_id>/... (Video Loop) and
-- sponsors/<event_id>/... (sponsor logos and videos). A write is allowed
-- only under those two prefixes, for an event where the caller is a
-- director or signage operator: the same rule that guards
-- leod_signage_displays and leod_signage_sponsors. Reading stays public
-- (paired TVs read anonymously). The bucket now accepts images and videos
-- only, up to 1 GB (the project's global limit).

DROP POLICY IF EXISTS leod_assets_auth_all ON storage.objects;

CREATE OR REPLACE FUNCTION public.leod_assets_can_write(p_name text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT split_part(p_name, '/', 1) IN ('displays', 'sponsors')
     AND split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     AND split_part(p_name, '/', 3) <> ''
     AND coalesce(cuedeck_event_role(split_part(p_name, '/', 2)::uuid) IN ('director', 'signage'), false)
$$;
REVOKE ALL ON FUNCTION public.leod_assets_can_write(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leod_assets_can_write(text) TO authenticated;

CREATE POLICY leod_assets_auth_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'leod-assets');
CREATE POLICY leod_assets_signage_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'leod-assets' AND public.leod_assets_can_write(name));
CREATE POLICY leod_assets_signage_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'leod-assets' AND public.leod_assets_can_write(name))
  WITH CHECK (bucket_id = 'leod-assets' AND public.leod_assets_can_write(name));
CREATE POLICY leod_assets_signage_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'leod-assets' AND public.leod_assets_can_write(name));

UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/gif','image/webp',
                                  'video/mp4','video/webm','video/quicktime','video/ogg'],
       file_size_limit = 1073741824
 WHERE id = 'leod-assets';
