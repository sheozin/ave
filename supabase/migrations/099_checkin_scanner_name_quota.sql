-- 099_checkin_scanner_name_quota.sql
-- Review of 5cfd6e2: record-scans decided "may this scanner see a name" by
-- counting the device's scans in the last minute, before inserting the new
-- ones, so parallel single-scan requests all read the same count and all got
-- names. The quota is now claimed atomically: one UPDATE on the device row,
-- which takes the row lock, so concurrent claims serialise and at most
-- p_limit succeed per window. (record-scans also returns names only for a
-- scan that checked the guest in, so learning a name means checking them in.)
ALTER TABLE leod_checkin_devices
  ADD COLUMN IF NOT EXISTS name_quota_window timestamptz,
  ADD COLUMN IF NOT EXISTS name_quota_used int NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION checkin_device_name_quota(p_device_id uuid, p_limit int)
RETURNS boolean
LANGUAGE sql VOLATILE SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE leod_checkin_devices
     SET name_quota_window = CASE WHEN name_quota_window IS NULL OR name_quota_window <= now() - interval '1 minute'
                                  THEN now() ELSE name_quota_window END,
         name_quota_used   = CASE WHEN name_quota_window IS NULL OR name_quota_window <= now() - interval '1 minute'
                                  THEN 1 ELSE name_quota_used + 1 END
   WHERE id = p_device_id AND revoked_at IS NULL
  RETURNING name_quota_used <= p_limit;
$$;
REVOKE ALL ON FUNCTION checkin_device_name_quota(uuid, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_device_name_quota(uuid, int) TO service_role;
