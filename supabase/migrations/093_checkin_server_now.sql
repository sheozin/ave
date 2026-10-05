-- 093_checkin_server_now.sql
-- The check-in desk's clock source (checkin-clock.js). get_server_clock,
-- which the console uses, UPDATEs leod_clock on every call; a room of desks
-- syncing every few minutes has no reason to write. This reads only.
-- clock_timestamp() is the time at the call, not at transaction start, so
-- the function is VOLATILE. Not SECURITY DEFINER: it reads no table.
CREATE OR REPLACE FUNCTION checkin_server_now()
RETURNS timestamptz
LANGUAGE sql VOLATILE
SET search_path = public
AS $$ SELECT clock_timestamp() $$;
REVOKE ALL ON FUNCTION checkin_server_now() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_server_now() TO authenticated;

NOTIFY pgrst, 'reload schema';
