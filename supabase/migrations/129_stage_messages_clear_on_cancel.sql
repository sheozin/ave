-- ============================================================
-- CueDeck Migration 129: a cancelled session drops its queued message
-- ============================================================
-- 128's stop trigger only fired when a session LEFT LIVE/OVERRUN/HOLD.
-- A message queued on a READY or CALLING session therefore survived a
-- Cancel; if the session was reinstated and went live, the old text came
-- back on the stage timer (review of the console part, 2026-10-08).
-- Now the trigger also fires whenever a session becomes CANCELLED, from
-- any status. Same function, unchanged.
-- ============================================================

DROP TRIGGER IF EXISTS trg_stage_messages_clear_on_session_stop ON leod_sessions;
CREATE TRIGGER trg_stage_messages_clear_on_session_stop
  AFTER UPDATE OF status ON leod_sessions
  FOR EACH ROW
  WHEN (
    (OLD.status IN ('LIVE', 'OVERRUN', 'HOLD') AND NEW.status NOT IN ('LIVE', 'OVERRUN', 'HOLD'))
    OR (NEW.status = 'CANCELLED' AND OLD.status IS DISTINCT FROM 'CANCELLED')
  )
  EXECUTE FUNCTION public.stage_messages_clear_on_session_stop();
