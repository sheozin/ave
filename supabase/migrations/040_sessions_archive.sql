-- ============================================================
-- Migration 040: Create leod_sessions_archive for soft-delete
-- ============================================================
-- Instead of hard-deleting ENDED sessions after 7 days,
-- we archive them to this table for historical reference.
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_sessions_archive (
  -- Mirror all columns from leod_sessions
  id               UUID        PRIMARY KEY,
  event_id         UUID,
  sort_order       SMALLINT,
  title            TEXT,
  type             TEXT,
  room             TEXT,
  speaker          TEXT,
  company          TEXT,
  notes            TEXT,
  planned_start    TIME(0),
  planned_end      TIME(0),
  scheduled_start  TIME(0),
  scheduled_end    TIME(0),
  actual_start     TIMESTAMPTZ,
  actual_end       TIMESTAMPTZ,
  delay_minutes    SMALLINT    DEFAULT 0,
  cumulative_delay SMALLINT    DEFAULT 0,
  is_anchor        BOOLEAN     DEFAULT false,
  status           TEXT,
  state_changed_at TIMESTAMPTZ,
  state_changed_by UUID,
  version          INTEGER     DEFAULT 1,
  remote           BOOLEAN     DEFAULT false,
  speaker_arrived  BOOLEAN     DEFAULT false,
  mics             SMALLINT    DEFAULT 0,
  mic_type         TEXT,
  slides           BOOLEAN     DEFAULT false,
  video_file       BOOLEAN     DEFAULT false,
  recording        BOOLEAN     DEFAULT false,
  streaming        BOOLEAN     DEFAULT false,
  interpretation   BOOLEAN     DEFAULT false,
  languages        TEXT[]      DEFAULT '{}',
  checks           JSONB       DEFAULT '[]',
  updated_at       TIMESTAMPTZ,
  -- Archive metadata
  archived_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_archive_event ON leod_sessions_archive (event_id);
CREATE INDEX IF NOT EXISTS idx_archive_date  ON leod_sessions_archive (archived_at);

-- RLS: only admins can read archived sessions
ALTER TABLE leod_sessions_archive ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_read_archive ON leod_sessions_archive
  FOR SELECT TO authenticated
  USING (
    EXISTS (SELECT 1 FROM leod_users WHERE id = auth.uid() AND role = 'admin')
    OR
    event_id IN (
      SELECT id FROM leod_events WHERE created_by = auth.uid()
    )
  );
