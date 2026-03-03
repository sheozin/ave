-- ============================================================
-- Migration 002 — Add leod_commands table (idempotency)
--
-- Provides server-side deduplication for all Edge Function calls.
-- Every transition (go_live, end_session, apply_delay, etc.) must:
--   1. INSERT into leod_commands with command_id (fails if duplicate)
--   2. Execute the state change
--   3. UPDATE leod_commands status to EXECUTED or REJECTED
--
-- Clients send command_id = crypto.randomUUID() per button click.
-- On retry, the Edge Function finds the EXECUTED row and returns
-- the cached result without re-applying the state change.
--
-- Run: paste into Supabase SQL Editor → Run
-- Idempotent: uses CREATE TABLE IF NOT EXISTS
-- ============================================================

-- ── Table ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leod_commands (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  command_id  UUID        NOT NULL UNIQUE,               -- client-generated per click
  event_id    UUID        REFERENCES leod_events(id) ON DELETE CASCADE,
  session_id  UUID        REFERENCES leod_sessions(id)  ON DELETE SET NULL,
  operator_id UUID        REFERENCES auth.users(id)     ON DELETE SET NULL,
  fn_name     TEXT        NOT NULL,                      -- 'go_live' | 'end_session' | etc.
  status      TEXT        NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','EXECUTED','REJECTED')),
  result      JSONB,                                     -- cached success payload
  error       TEXT,                                      -- rejection reason
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- ── Indexes ───────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_commands_command_id  ON leod_commands (command_id);
CREATE INDEX IF NOT EXISTS idx_commands_session_id  ON leod_commands (session_id);
CREATE INDEX IF NOT EXISTS idx_commands_created_at  ON leod_commands (created_at);

-- ── TTL cleanup — auto-delete commands older than 24 hours ────
-- Requires pg_cron extension. If not available, run manually.
-- SELECT cron.schedule('leod-commands-ttl', '0 * * * *',
--   $$DELETE FROM leod_commands WHERE created_at < NOW() - INTERVAL '24 hours'$$);

-- ── RLS ───────────────────────────────────────────────────────
ALTER TABLE leod_commands ENABLE ROW LEVEL SECURITY;

-- Authenticated operators: full access
CREATE POLICY "auth_all_commands"
  ON leod_commands FOR ALL TO authenticated
  USING (true) WITH CHECK (true);

-- Anon: no access (commands are server-internal)
-- (No anon policy = anon is denied by default)

-- ── How to use in Edge Functions ──────────────────────────────
-- In transition.ts / apply-delay/index.ts, add at the top:
--
--   // 1. Check idempotency
--   const { data: existing } = await adminClient
--     .from('leod_commands')
--     .select('status, result, error')
--     .eq('command_id', command_id)
--     .single();
--
--   if (existing?.status === 'EXECUTED') {
--     return new Response(JSON.stringify(existing.result), { status: 200 });
--   }
--
--   // 2. Register command (unique constraint prevents duplicate)
--   const { error: regErr } = await adminClient
--     .from('leod_commands')
--     .insert({ command_id, session_id, fn_name: 'go_live', status: 'PENDING' });
--
--   if (regErr) {
--     return new Response(JSON.stringify({ error: 'IN_FLIGHT' }), { status: 409 });
--   }
--
--   // 3. Execute ... then:
--   await adminClient.from('leod_commands')
--     .update({ status: 'EXECUTED', result: payload, resolved_at: new Date() })
--     .eq('command_id', command_id);
