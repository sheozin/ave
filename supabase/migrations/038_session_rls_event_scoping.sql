-- ============================================================
-- Migration 038: Scope leod_sessions RLS by event ownership
-- ============================================================
-- Previously: anon_read_sessions USING (true) — all auth users
-- see ALL sessions across ALL events.
--
-- Fix: Users only see sessions for events they own or were invited to.
-- This prevents multi-tenant data leakage.
-- ============================================================

-- 1. Drop old permissive SELECT policy
DROP POLICY IF EXISTS anon_read_sessions ON leod_sessions;
DROP POLICY IF EXISTS auth_read_sessions ON leod_sessions;

-- 2. Create scoped SELECT: sessions visible only if user owns the event
--    or was invited by the event owner
CREATE POLICY scoped_read_sessions ON leod_sessions
  FOR SELECT TO authenticated
  USING (
    event_id IN (
      SELECT id FROM leod_events
      WHERE created_by = auth.uid()
         OR created_by IN (
           SELECT invited_by FROM leod_users
           WHERE leod_users.id = auth.uid() AND invited_by IS NOT NULL
         )
    )
  );

-- 3. Scope WRITE policies similarly (replace old auth_write_sessions)
DROP POLICY IF EXISTS auth_write_sessions ON leod_sessions;

CREATE POLICY scoped_write_sessions ON leod_sessions
  FOR ALL TO authenticated
  USING (
    event_id IN (
      SELECT id FROM leod_events
      WHERE created_by = auth.uid()
         OR created_by IN (
           SELECT invited_by FROM leod_users
           WHERE leod_users.id = auth.uid() AND invited_by IS NOT NULL
         )
    )
  )
  WITH CHECK (
    event_id IN (
      SELECT id FROM leod_events
      WHERE created_by = auth.uid()
         OR created_by IN (
           SELECT invited_by FROM leod_users
           WHERE leod_users.id = auth.uid() AND invited_by IS NOT NULL
         )
    )
  );

-- 4. Also scope event_log reads to user's events
DROP POLICY IF EXISTS anon_read_log ON leod_sessions;
DROP POLICY IF EXISTS anon_read_log ON leod_event_log;
DROP POLICY IF EXISTS auth_read_log ON leod_event_log;

CREATE POLICY scoped_read_log ON leod_event_log
  FOR SELECT TO authenticated
  USING (
    event_id IN (
      SELECT id FROM leod_events
      WHERE created_by = auth.uid()
         OR created_by IN (
           SELECT invited_by FROM leod_users
           WHERE leod_users.id = auth.uid() AND invited_by IS NOT NULL
         )
    )
  );

-- 5. Keep admin override from migration 027
-- admin_read_all_sessions already exists and uses role='admin' check
