-- ============================================================
-- CueDeck — Migration 016: Event ownership & user isolation
-- ============================================================
-- Each user only sees events they created (directors) or events
-- created by the director who invited them (operators).
--
-- Changes:
-- 1. Add created_by UUID column to leod_events
-- 2. Replace permissive SELECT policy with ownership-based RLS
-- 3. Restrict INSERT so created_by is always set to auth.uid()
-- ============================================================

-- 1. Add created_by column
ALTER TABLE leod_events
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id);

-- 2. Backfill: assign existing events to the oldest director account
-- (safe assumption: the first director created the demo/test events)
UPDATE leod_events
SET created_by = (
  SELECT id FROM leod_users
  WHERE role = 'director' AND invited_by IS NULL
  ORDER BY created_at ASC NULLS LAST
  LIMIT 1
)
WHERE created_by IS NULL;

-- 3. Make created_by NOT NULL going forward (after backfill)
ALTER TABLE leod_events
  ALTER COLUMN created_by SET DEFAULT auth.uid();

-- 4. Drop any existing read policies on leod_events
DROP POLICY IF EXISTS "anon_read_events"   ON leod_events;
DROP POLICY IF EXISTS "auth_read_events"   ON leod_events;
DROP POLICY IF EXISTS "auth_write_events"  ON leod_events;
DROP POLICY IF EXISTS "owner_read_events"  ON leod_events;
DROP POLICY IF EXISTS "owner_write_events" ON leod_events;

-- 5. Enable RLS (idempotent)
ALTER TABLE leod_events ENABLE ROW LEVEL SECURITY;

-- 6. SELECT: user sees events they created OR events created by their inviter
CREATE POLICY owner_read_events ON leod_events
  FOR SELECT TO authenticated
  USING (
    created_by = auth.uid()
    OR
    created_by IN (
      SELECT invited_by FROM leod_users WHERE id = auth.uid() AND invited_by IS NOT NULL
    )
  );

-- 7. INSERT: directors can create events (created_by auto-set to their uid)
CREATE POLICY owner_insert_events ON leod_events
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

-- 8. UPDATE: only the creator can edit their events
CREATE POLICY owner_update_events ON leod_events
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

-- 9. DELETE: only the creator can delete their events
CREATE POLICY owner_delete_events ON leod_events
  FOR DELETE TO authenticated
  USING (created_by = auth.uid());
