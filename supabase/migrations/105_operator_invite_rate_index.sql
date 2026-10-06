-- 105_operator_invite_rate_index.sql
-- invite-operator counts its team's OPERATOR_INVITED rows in the last 24
-- hours before every invite (20 per team per day: the invitation email is
-- ours now, so Supabase's own invite rate limit no longer applies). Those
-- rows carry no event_id, so no existing index serves the count.
CREATE INDEX IF NOT EXISTS idx_log_operator_invited
  ON leod_event_log ((payload->>'team_owner'), ts DESC)
  WHERE action = 'OPERATOR_INVITED';
