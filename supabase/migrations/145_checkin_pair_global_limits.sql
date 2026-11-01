-- 145_checkin_pair_global_limits.sql
-- Pairing rate limits. The per-source limit (056) keyed on the first
-- X-Forwarded-For entry, which a caller sets (a forged value arrives
-- untouched), so rotating it gave unlimited buckets. checkin-kiosk-pair now
-- keys on cf-connecting-ip, which Cloudflare sets and will not accept from a
-- caller: 30 attempts per address per 10 minutes is a real limit again.
-- Behind it, two backstops set high enough that tripping them takes
-- hundreds of real addresses, so they cannot be used to lock everyone out:
--   * wrong pairing codes (failed claim, unknown code looked up or
--     approved), service-wide: 5000 per 10 minutes;
--   * print-station codes waiting at once: 20000.
-- Signed-in checks (request_info, approve) are also limited per person, by
-- user id, which a caller cannot choose.
CREATE TABLE IF NOT EXISTS leod_checkin_pair_failures (
  id        bigserial   PRIMARY KEY,
  failed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_checkin_pair_failures_at ON leod_checkin_pair_failures (failed_at);
ALTER TABLE leod_checkin_pair_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_pair_failures FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_pair_failures_id_seq FROM anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_pair_global_ok()
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM leod_checkin_pair_failures WHERE failed_at < now() - interval '20 minutes';
  RETURN (SELECT count(*) FROM leod_checkin_pair_failures WHERE failed_at > now() - interval '10 minutes') < 5000;
END;
$$;

CREATE OR REPLACE FUNCTION checkin_pair_note_failure()
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = public
AS $$ INSERT INTO leod_checkin_pair_failures DEFAULT VALUES $$;

CREATE OR REPLACE FUNCTION checkin_print_request_ok()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*) < 20000 FROM leod_checkin_device_requests WHERE approved_at IS NULL AND expires_at > now()
$$;

REVOKE ALL ON FUNCTION checkin_pair_global_ok() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION checkin_pair_note_failure() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION checkin_print_request_ok() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_pair_global_ok() TO service_role;
GRANT EXECUTE ON FUNCTION checkin_pair_note_failure() TO service_role;
GRANT EXECUTE ON FUNCTION checkin_print_request_ok() TO service_role;
