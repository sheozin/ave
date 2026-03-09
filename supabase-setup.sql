-- ══════════════════════════════════════════════════════════════════
-- CueDeck — Full Schema Setup
-- Paste this entire script into Supabase SQL Editor and run once.
-- ══════════════════════════════════════════════════════════════════

-- ── 0. Cleanup (safe re-run) ──────────────────────────────────────
DROP TABLE IF EXISTS leod_event_log  CASCADE;
DROP TABLE IF EXISTS leod_broadcast  CASCADE;
DROP TABLE IF EXISTS leod_sessions   CASCADE;
DROP TABLE IF EXISTS leod_clock      CASCADE;
DROP TABLE IF EXISTS leod_events     CASCADE;
DROP TYPE  IF EXISTS session_status  CASCADE;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;
DROP FUNCTION IF EXISTS get_server_clock  CASCADE;


-- ── 1. Helper trigger function ────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ── 2. Enums ──────────────────────────────────────────────────────
CREATE TYPE session_status AS ENUM (
  'PLANNED', 'READY', 'CALLING', 'LIVE',
  'OVERRUN', 'HOLD', 'ENDED', 'CANCELLED'
);


-- ── 3. leod_events ───────────────────────────────────────────────
CREATE TABLE leod_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT        NOT NULL,
  date        DATE        NOT NULL,
  venue       TEXT,
  timezone    TEXT        NOT NULL DEFAULT 'Europe/Warsaw',
  active      BOOLEAN     NOT NULL DEFAULT true,
  event_start TIME(0)     NOT NULL,
  event_end   TIME(0)     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_events_updated
  BEFORE UPDATE ON leod_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── 4. leod_clock ────────────────────────────────────────────────
-- Stores a single row. Clients use get_server_clock() RPC
-- which writes NOW() on every call — no cron needed.
CREATE TABLE leod_clock (
  id          TEXT        PRIMARY KEY DEFAULT 'master',
  server_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  tick        BIGINT      NOT NULL DEFAULT 0
);

INSERT INTO leod_clock (id, server_time, tick)
VALUES ('master', NOW(), 0);

-- RPC: clients call this for clock sync.
-- Writes NOW() atomically so the timestamp is fresh on every read.
CREATE OR REPLACE FUNCTION get_server_clock()
RETURNS TABLE(server_time TIMESTAMPTZ, tick BIGINT)
LANGUAGE SQL SECURITY DEFINER AS $$
  UPDATE leod_clock
  SET    server_time = NOW(),
         tick        = tick + 1
  WHERE  id = 'master'
  RETURNING server_time, tick;
$$;


-- ── 5. leod_sessions ─────────────────────────────────────────────
CREATE TABLE leod_sessions (
  -- Identity
  id               UUID           PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID           NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  sort_order       SMALLINT       NOT NULL,

  -- Display
  title            TEXT           NOT NULL,
  type             TEXT           NOT NULL DEFAULT 'Keynote',
  room             TEXT,
  speaker          TEXT,
  company          TEXT,
  notes            TEXT,

  -- Planned times — immutable once event starts
  planned_start    TIME(0)        NOT NULL,
  planned_end      TIME(0)        NOT NULL,

  -- Live schedule — shifts with delay cascade
  scheduled_start  TIME(0)        NOT NULL,
  scheduled_end    TIME(0)        NOT NULL,

  -- Actuals — written by server on LIVE / ENDED transitions
  actual_start     TIMESTAMPTZ,
  actual_end       TIMESTAMPTZ,

  -- Delay tracking
  delay_minutes    SMALLINT       NOT NULL DEFAULT 0,
  cumulative_delay SMALLINT       NOT NULL DEFAULT 0,

  -- Cascade behaviour
  is_anchor        BOOLEAN        NOT NULL DEFAULT false,

  -- State machine
  status           session_status NOT NULL DEFAULT 'PLANNED',
  state_changed_at TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  state_changed_by UUID,          -- will reference leod_users once auth is set up

  -- Optimistic lock
  version          INTEGER        NOT NULL DEFAULT 1,

  -- Technical flags
  remote           BOOLEAN        NOT NULL DEFAULT false,
  speaker_arrived  BOOLEAN        NOT NULL DEFAULT false,
  mics             SMALLINT       NOT NULL DEFAULT 0,
  mic_type         TEXT,
  slides           BOOLEAN        NOT NULL DEFAULT false,
  video_file       BOOLEAN        NOT NULL DEFAULT false,
  recording        BOOLEAN        NOT NULL DEFAULT false,
  streaming        BOOLEAN        NOT NULL DEFAULT false,
  interpretation   BOOLEAN        NOT NULL DEFAULT false,
  languages        TEXT[]         NOT NULL DEFAULT '{}',
  checks           JSONB          NOT NULL DEFAULT '[]',

  updated_at       TIMESTAMPTZ    NOT NULL DEFAULT NOW(),

  CONSTRAINT chk_planned   CHECK (planned_start   < planned_end),
  CONSTRAINT chk_scheduled CHECK (scheduled_start < scheduled_end)
);

CREATE INDEX idx_sessions_event  ON leod_sessions (event_id, sort_order);
CREATE INDEX idx_sessions_status ON leod_sessions (status);

CREATE TRIGGER trg_sessions_updated
  BEFORE UPDATE ON leod_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();


-- ── 6. leod_event_log ────────────────────────────────────────────
CREATE TABLE leod_event_log (
  id             BIGSERIAL    PRIMARY KEY,
  event_id       UUID         REFERENCES leod_events(id),
  session_id     UUID         REFERENCES leod_sessions(id),
  ts             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  operator_id    UUID,
  operator_role  TEXT,
  action         TEXT         NOT NULL,
  from_status    TEXT,
  to_status      TEXT,
  payload        JSONB        NOT NULL DEFAULT '{}',
  server_time_ms BIGINT       NOT NULL DEFAULT 0,
  ip_address     INET,
  user_agent     TEXT
);

CREATE INDEX idx_log_event   ON leod_event_log (event_id,   ts DESC);
CREATE INDEX idx_log_session ON leod_event_log (session_id, ts DESC);


-- ── 7. leod_broadcast ────────────────────────────────────────────
CREATE TABLE leod_broadcast (
  id         TEXT        PRIMARY KEY DEFAULT 'global',
  event_id   UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  message    TEXT        NOT NULL DEFAULT '',
  priority   TEXT        NOT NULL DEFAULT 'info'
             CHECK (priority IN ('info','warn','critical')),
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_by    UUID,
  expires_at TIMESTAMPTZ
);


-- ── 8. Row Level Security ─────────────────────────────────────────
-- Open policies for testing (anon key can read + write).
-- Tighten to authenticated-only once auth is set up.

ALTER TABLE leod_events     ENABLE ROW LEVEL SECURITY;
ALTER TABLE leod_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE leod_event_log  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leod_broadcast  ENABLE ROW LEVEL SECURITY;
ALTER TABLE leod_clock      ENABLE ROW LEVEL SECURITY;

-- Anon read
CREATE POLICY anon_read_events     ON leod_events     FOR SELECT USING (true);
CREATE POLICY anon_read_sessions   ON leod_sessions   FOR SELECT USING (true);
CREATE POLICY anon_read_log        ON leod_event_log  FOR SELECT USING (true);
CREATE POLICY anon_read_broadcast  ON leod_broadcast  FOR SELECT USING (true);
CREATE POLICY anon_read_clock      ON leod_clock      FOR SELECT USING (true);

-- ⚠️  DEV-ONLY POLICIES — CRITICAL: MUST BE REMOVED BEFORE PRODUCTION ⚠️
-- These allow the anon key to write all core tables.
-- They exist ONLY to allow local development without full auth setup.
-- Before any production deploy, run:
--   supabase/migrations/001_remove_dev_policies.sql
-- to drop these and replace with authenticated-only write policies.
CREATE POLICY anon_write_sessions   ON leod_sessions  FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY anon_write_log        ON leod_event_log FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY anon_write_broadcast  ON leod_broadcast FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY anon_write_clock      ON leod_clock     FOR ALL USING (true) WITH CHECK (true);


-- ── 9. Realtime publications ──────────────────────────────────────
ALTER PUBLICATION supabase_realtime ADD TABLE leod_sessions;
ALTER PUBLICATION supabase_realtime ADD TABLE leod_event_log;
ALTER PUBLICATION supabase_realtime ADD TABLE leod_broadcast;


-- ══════════════════════════════════════════════════════════════════
-- SEED DATA — test event + 6 sessions
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  ev_id UUID;
BEGIN
  -- Insert test event
  INSERT INTO leod_events (name, date, timezone, event_start, event_end)
  VALUES ('AVE Test Event', CURRENT_DATE, 'Europe/Warsaw', '09:00', '18:00')
  RETURNING id INTO ev_id;

  -- Insert test sessions
  INSERT INTO leod_sessions
    (event_id, sort_order, title, type, room, speaker, company,
     planned_start, planned_end, scheduled_start, scheduled_end,
     mics, slides, recording)
  VALUES
    (ev_id, 1, 'Opening Ceremony',         'Other',    'Main Stage', 'Sherif Saleh',     'AVE Events',  '09:00', '09:15', '09:00', '09:15', 1, false, true),
    (ev_id, 2, 'Keynote: The Future of AI','Keynote',  'Main Stage', 'Anna Kowalska',    'TechCorp',    '09:15', '10:00', '09:15', '10:00', 2, true,  true),
    (ev_id, 3, 'Coffee Break',             'Break',    'Foyer',       NULL,               NULL,          '10:00', '10:30', '10:00', '10:30', 0, false, false),
    (ev_id, 4, 'Panel: Startups in 2025',  'Panel',    'Main Stage', 'Piotr Nowak',      'StartupHub',  '10:30', '11:30', '10:30', '11:30', 4, false, true),
    (ev_id, 5, 'Workshop: AI Tools',       'Workshop', 'Room B',     'Marta Wiśniewska', 'AI Lab',      '11:30', '12:30', '11:30', '12:30', 2, true,  false),
    (ev_id, 6, 'Closing & Networking',     'Other',    'Main Stage', NULL,               NULL,          '12:30', '13:30', '12:30', '13:30', 0, false, false);

  -- Insert broadcast placeholder for this event
  INSERT INTO leod_broadcast (id, event_id, message, priority)
  VALUES ('global', ev_id, '', 'info');

  RAISE NOTICE 'Created event id: %', ev_id;
END $$;
