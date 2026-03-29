-- Migration 004 — Add seq column to leod_sessions
-- Stamps a monotonically increasing sequence number on every INSERT/UPDATE.
-- Used by the console client to detect dropped or out-of-order realtime events.
-- Idempotent: CREATE SEQUENCE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS + CREATE OR REPLACE

-- ── Sequence ──────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS leod_sessions_seq;

-- ── Column ────────────────────────────────────────────────────────────────
ALTER TABLE leod_sessions ADD COLUMN IF NOT EXISTS seq BIGINT;

-- ── Trigger function ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION leod_sessions_stamp_seq()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.seq = nextval('leod_sessions_seq');
  RETURN NEW;
END;
$$;

-- ── Trigger ───────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS leod_sessions_seq_trigger ON leod_sessions;
CREATE TRIGGER leod_sessions_seq_trigger
  BEFORE INSERT OR UPDATE ON leod_sessions
  FOR EACH ROW EXECUTE FUNCTION leod_sessions_stamp_seq();
