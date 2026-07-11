-- ============================================================
-- Migration 042: Webhook integrations for state transitions
-- ============================================================
-- Directors can configure webhook URLs that fire on session
-- state changes (LIVE, ENDED, DELAY, etc.)
-- ============================================================

CREATE TABLE IF NOT EXISTS leod_webhooks (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  url         TEXT        NOT NULL,
  secret      TEXT,                          -- optional HMAC secret
  events      TEXT[]      NOT NULL DEFAULT '{SESSION_STATUS_CHANGE,DELAY}',
  active      BOOLEAN     NOT NULL DEFAULT true,
  created_by  UUID        REFERENCES auth.users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhooks_event ON leod_webhooks (event_id) WHERE active = true;

ALTER TABLE leod_webhooks ENABLE ROW LEVEL SECURITY;

CREATE POLICY owner_manage_webhooks ON leod_webhooks
  FOR ALL TO authenticated
  USING (
    event_id IN (
      SELECT id FROM leod_events WHERE created_by = auth.uid()
    )
  )
  WITH CHECK (
    event_id IN (
      SELECT id FROM leod_events WHERE created_by = auth.uid()
    )
  );

-- Function to fire webhooks (called by event_log trigger)
CREATE OR REPLACE FUNCTION fire_webhooks()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  wh RECORD;
BEGIN
  -- Only fire for relevant actions
  IF NEW.action NOT IN ('SESSION_STATUS_CHANGE', 'DELAY', 'BROADCAST') THEN
    RETURN NEW;
  END IF;

  -- Find active webhooks for this event
  FOR wh IN
    SELECT url, secret FROM leod_webhooks
    WHERE event_id = NEW.event_id AND active = true
      AND NEW.action = ANY(events)
  LOOP
    -- Queue webhook via pg_net (async HTTP)
    PERFORM net.http_post(
      url     := wh.url,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-CueDeck-Event', NEW.action,
        'X-CueDeck-Signature', COALESCE(
          encode(hmac(NEW.payload::text, COALESCE(wh.secret, ''), 'sha256'), 'hex'),
          ''
        )
      ),
      body    := jsonb_build_object(
        'event',      NEW.action,
        'session_id', NEW.session_id,
        'event_id',   NEW.event_id,
        'from_status', NEW.from_status,
        'to_status',  NEW.to_status,
        'timestamp',  NEW.ts,
        'payload',    NEW.payload
      )::text
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block event_log inserts if webhook delivery fails
  RETURN NEW;
END;
$$;

-- Only apply trigger if pg_net extension is available
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net') THEN
    DROP TRIGGER IF EXISTS trg_fire_webhooks ON leod_event_log;
    CREATE TRIGGER trg_fire_webhooks
      AFTER INSERT ON leod_event_log
      FOR EACH ROW
      EXECUTE FUNCTION fire_webhooks();
  END IF;
END $$;
