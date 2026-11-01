-- 146_downloads_bucket.sql
-- Public downloads: the CueDeck Print Station app (print-station-app/),
-- linked from Event admin > Kiosk & scanners > Print stations. Anyone with
-- the link can download (public bucket, read by URL); nobody but the service
-- role can write: no storage.objects policy grants insert, update or delete
-- on this bucket to anon or authenticated.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('downloads', 'downloads', true, 314572800, ARRAY['application/x-apple-diskimage', 'application/octet-stream', 'application/vnd.microsoft.portable-executable'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = EXCLUDED.file_size_limit, allowed_mime_types = EXCLUDED.allowed_mime_types;
