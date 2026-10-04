DROP POLICY IF EXISTS checkin_op_write  ON leod_checkin_operators;
DROP POLICY IF EXISTS checkin_op_update ON leod_checkin_operators;
DROP POLICY IF EXISTS checkin_op_delete ON leod_checkin_operators;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON leod_checkin_operators FROM anon, authenticated;
-- Reads stay (checkin_op_read). Writers: checkin-invite-staff, checkin-enable-event (service role)
-- and checkin_auto_grant_organizer() (SECURITY DEFINER trigger, migration 045).

CREATE TABLE IF NOT EXISTS leod_checkin_invite_log (
  id         BIGSERIAL   PRIMARY KEY,
  event_id   UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  inviter_id UUID        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leod_checkin_invite_log_event_idx   ON leod_checkin_invite_log(event_id, created_at);
CREATE INDEX IF NOT EXISTS leod_checkin_invite_log_inviter_idx ON leod_checkin_invite_log(inviter_id, created_at);
ALTER TABLE leod_checkin_invite_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON leod_checkin_invite_log FROM anon, authenticated;
