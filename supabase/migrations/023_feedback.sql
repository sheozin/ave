-- 023: Feedback table for in-app user feedback
CREATE TABLE IF NOT EXISTS leod_feedback (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     UUID REFERENCES auth.users(id),
  email       TEXT,
  role        TEXT,
  event_id    UUID,
  rating      SMALLINT CHECK (rating BETWEEN 1 AND 5),
  category    TEXT CHECK (category IN ('bug', 'feature', 'general', 'praise')),
  message     TEXT NOT NULL,
  app_version TEXT,
  user_agent  TEXT,
  resolved    BOOLEAN DEFAULT false
);

ALTER TABLE leod_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own feedback"
  ON leod_feedback FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

-- No SELECT policy for authenticated users.
-- Feedback is read-only via Supabase dashboard or service role key (admin/owner only).
