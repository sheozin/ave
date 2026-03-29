-- Migration 005 — RPC cleanup_old_commands
-- Deletes leod_commands rows older than 24h. Called by the console client
-- at loadSnapshot() time (best-effort, non-blocking, failure is non-fatal).
-- Idempotent: CREATE OR REPLACE

CREATE OR REPLACE FUNCTION cleanup_old_commands()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM leod_commands
  WHERE created_at < NOW() - INTERVAL '24 hours';
END;
$$;

GRANT EXECUTE ON FUNCTION cleanup_old_commands() TO authenticated;
