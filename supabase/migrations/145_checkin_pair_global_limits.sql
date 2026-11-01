-- 145_checkin_pair_global_limits.sql
-- Pairing rate limits that do not trust the caller's address. The per-source
-- limit (056, checkin_kiosk_pair_rate_check) keys on the first
-- X-Forwarded-For entry, which a caller can set, so it is only a first
-- filter: rotating that header gives unlimited buckets. These limits hold
-- whatever the header says:
--   * every wrong pairing code (a failed claim, an unknown code looked up or
--     approved) counts toward one ceiling for the whole service: 300 per
--     10 minutes. 32^8 codes against 300 guesses per 10 minutes is centuries
--     per live code. Under a flood, real pairing waits a few minutes (said
--     on screen) rather than guessing getting through.
--   * at most 2000 print-station codes may be waiting at once.
--   * signed-in checks (request_info, approve) are limited per person, by
--     user id, which a caller cannot choose (checkin-kiosk-pair).
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
  RETURN (SELECT count(*) FROM leod_checkin_pair_failures WHERE failed_at > now() - interval '10 minutes') < 300;
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
  SELECT count(*) < 2000 FROM leod_checkin_device_requests WHERE approved_at IS NULL AND expires_at > now()
$$;

REVOKE ALL ON FUNCTION checkin_pair_global_ok() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION checkin_pair_note_failure() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION checkin_print_request_ok() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_pair_global_ok() TO service_role;
GRANT EXECUTE ON FUNCTION checkin_pair_note_failure() TO service_role;
GRANT EXECUTE ON FUNCTION checkin_print_request_ok() TO service_role;
