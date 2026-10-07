-- ============================================================
-- CueDeck Migration 128: message to speaker
-- ============================================================
-- A director or stage operator sends a short message (1 to 60 characters)
-- for one session. The stage-timer TV showing that session and the
-- console's stage monitor show it in a band until it is cleared or the
-- session leaves LIVE, OVERRUN or HOLD.
--
-- Rulings (owner-approved mock, 2026-10-07):
--   * keyed by session, one active message per session;
--   * "until the session ends" is decided at read time: display_feed only
--     returns uncleared messages whose session is LIVE, OVERRUN or HOLD.
--     No cron, so nothing can go dead. A trigger also clears the message
--     when the session stops running, so a restart cannot revive it;
--   * clear = set cleared_at, never DELETE (realtime does not deliver
--     DELETE to filtered listeners);
--   * send/clear: cuedeck_event_role(event_id) IN ('director','stage');
--     read: any event role; anon: no grant at all (TVs read via display_feed).
--
-- display_feed below is the live body (pg_get_functiondef, 2026-10-07,
-- last changed by 083) with one key added at the end: 'stage_messages'.
-- CREATE OR REPLACE keeps its ACL (anon and authenticated EXECUTE).
-- ============================================================

-- ── Table ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS leod_stage_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    uuid NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  -- no FK: sessions are archived and deleted by the cleanup cron
  session_id  uuid NOT NULL,
  text        text NOT NULL CHECK (char_length(btrim(text)) BETWEEN 1 AND 60),
  sent_by     uuid NOT NULL DEFAULT auth.uid(),
  sent_at     timestamptz NOT NULL DEFAULT now(),
  cleared_at  timestamptz,
  cleared_by  uuid
);

-- one active message per session
CREATE UNIQUE INDEX IF NOT EXISTS leod_stage_messages_one_active
  ON leod_stage_messages (session_id) WHERE cleared_at IS NULL;
CREATE INDEX IF NOT EXISTS leod_stage_messages_event_active
  ON leod_stage_messages (event_id) WHERE cleared_at IS NULL;

ALTER TABLE leod_stage_messages ENABLE ROW LEVEL SECURITY;
-- Read only for clients. Every write goes through stage_message_send /
-- stage_message_clear (role check, session-in-event check, log row) or the
-- stop trigger below, so nobody can forge sent_by/cleared_by, rewrite the
-- text on the TV, un-clear a message, or plant a row in another event's
-- session slot without a trace.
REVOKE ALL ON leod_stage_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT ON leod_stage_messages TO authenticated;

DROP POLICY IF EXISTS stage_messages_member_read ON leod_stage_messages;
CREATE POLICY stage_messages_member_read ON leod_stage_messages FOR SELECT TO authenticated
  USING (cuedeck_event_role(event_id) IS NOT NULL);

-- no INSERT, UPDATE or DELETE policy (and no grant): writes are RPC-only;
-- clearing is an UPDATE of cleared_at inside stage_message_clear
DROP POLICY IF EXISTS stage_messages_sender_insert ON leod_stage_messages;
DROP POLICY IF EXISTS stage_messages_sender_update ON leod_stage_messages;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'leod_stage_messages') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE leod_stage_messages;
  END IF;
END $$;

-- ── Send: replaces the session's active message atomically ──
-- Errors: 42501 not a director/stage of the event (checked first, so a
-- stranger learns nothing); P0002 session not in this event; 55000 session
-- ENDED or CANCELLED; 22023 text empty or over 60 characters. READY and
-- CALLING are allowed on purpose: a queued message shows once it goes live.
CREATE OR REPLACE FUNCTION public.stage_message_send(p_event_id uuid, p_session_id uuid, p_text text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := cuedeck_event_role(p_event_id);
  v_text text := btrim(coalesce(p_text, ''));
  v_row  leod_stage_messages%ROWTYPE;
  v_status session_status;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('director', 'stage') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;
  -- FOR SHARE: a concurrent status change (End, Cancel, Restart) waits
  -- until this send commits, so the stop trigger then clears the new
  -- message. If the change committed first, the status read here is the
  -- new one and an ended session is refused, so no message can be left
  -- behind on a stopped session for a later restart to show again.
  SELECT s.status INTO v_status
    FROM leod_sessions s
   WHERE s.id = p_session_id AND s.event_id = p_event_id
     FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Session not found in this event' USING ERRCODE = 'P0002';
  END IF;
  IF v_status IN ('ENDED', 'CANCELLED') THEN
    RAISE EXCEPTION 'Session has ended' USING ERRCODE = '55000';
  END IF;
  IF char_length(v_text) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'Message must be 1 to 60 characters' USING ERRCODE = '22023';
  END IF;

  -- two operators pressing Send at once: the second waits, then replaces
  PERFORM pg_advisory_xact_lock(hashtextextended('stage_message:' || p_session_id::text, 0));

  UPDATE leod_stage_messages
     SET cleared_at = now(), cleared_by = auth.uid()
   WHERE session_id = p_session_id AND cleared_at IS NULL;

  INSERT INTO leod_stage_messages (event_id, session_id, text, sent_by)
  VALUES (p_event_id, p_session_id, v_text, auth.uid())
  RETURNING * INTO v_row;

  INSERT INTO leod_event_log (event_id, session_id, action, operator_id, operator_role, payload, server_time_ms)
  VALUES (p_event_id, p_session_id, 'STAGE_MESSAGE', auth.uid(), v_role,
          jsonb_build_object('text', v_text, 'session_id', p_session_id),
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint);

  RETURN jsonb_build_object('id', v_row.id, 'session_id', v_row.session_id,
                            'text', v_row.text, 'sent_at', v_row.sent_at);
END;
$$;

REVOKE ALL ON FUNCTION public.stage_message_send(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_message_send(uuid, uuid, text) TO authenticated, service_role;

-- ── Clear: true if a message was cleared, false if none was active ──
CREATE OR REPLACE FUNCTION public.stage_message_clear(p_event_id uuid, p_session_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_role text := cuedeck_event_role(p_event_id);
  v_text text;
BEGIN
  IF v_role IS NULL OR v_role NOT IN ('director', 'stage') THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  UPDATE leod_stage_messages
     SET cleared_at = now(), cleared_by = auth.uid()
   WHERE event_id = p_event_id AND session_id = p_session_id AND cleared_at IS NULL
  RETURNING leod_stage_messages.text INTO v_text;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  INSERT INTO leod_event_log (event_id, session_id, action, operator_id, operator_role, payload, server_time_ms)
  VALUES (p_event_id, p_session_id, 'STAGE_MESSAGE_CLEARED', auth.uid(), v_role,
          jsonb_build_object('text', v_text, 'session_id', p_session_id),
          (extract(epoch FROM clock_timestamp()) * 1000)::bigint);
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.stage_message_clear(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_message_clear(uuid, uuid) TO authenticated, service_role;

-- ── A session that stops running clears its message ─────────
-- Leaving LIVE/OVERRUN/HOLD for anything else (ENDED, CANCELLED, or a
-- restart back to READY/PLANNED) clears the active message, so a restarted
-- session never shows an old message again. cleared_by stays NULL: cleared
-- by the system. Nothing is logged, so the event log is not spammed.
-- A message queued while READY or CALLING is untouched: it shows once the
-- session goes live (operators may queue "Please wrap up" ahead of time).
-- UPDATE OF status only: the nightly cleanup's archive upsert (another
-- table) and its DELETE of ENDED sessions do not fire it.
CREATE OR REPLACE FUNCTION public.stage_messages_clear_on_session_stop()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE leod_stage_messages
     SET cleared_at = now()
   WHERE session_id = NEW.id AND cleared_at IS NULL;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.stage_messages_clear_on_session_stop() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_stage_messages_clear_on_session_stop ON leod_sessions;
CREATE TRIGGER trg_stage_messages_clear_on_session_stop
  AFTER UPDATE OF status ON leod_sessions
  FOR EACH ROW
  WHEN (OLD.status IN ('LIVE', 'OVERRUN', 'HOLD') AND NEW.status NOT IN ('LIVE', 'OVERRUN', 'HOLD'))
  EXECUTE FUNCTION public.stage_messages_clear_on_session_stop();

-- ── display_feed: live body + 'stage_messages' ──────────────
CREATE OR REPLACE FUNCTION public.display_feed(p_display_id uuid, p_secret text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  d leod_signage_displays%ROWTYPE;
BEGIN
  IF p_display_id IS NULL OR p_secret IS NULL OR length(p_secret) < 32 THEN
    RETURN NULL;
  END IF;
  SELECT * INTO d FROM leod_signage_displays
   WHERE id = p_display_id AND display_secret = p_secret;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '20 seconds' THEN
    UPDATE leod_signage_displays SET last_seen_at = now() WHERE id = d.id;
  END IF;
  RETURN jsonb_build_object(
    'server_time', clock_timestamp(),
    'display',     to_jsonb(d) - 'display_secret',
    'event', (SELECT jsonb_build_object('name', e.name, 'brand_color', e.brand_color,
                                        'date', e.date, 'timezone', e.timezone)
                FROM leod_events e WHERE e.id = d.event_id),
    'sessions', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'id',              s.id,
                'sort_order',      s.sort_order,
                'title',           s.title,
                'speaker',         s.speaker,
                'company',         s.company,
                'people',          s.people,
                'room',            s.room,
                'status',          s.status,
                'planned_start',   s.planned_start,
                'planned_end',     s.planned_end,
                'scheduled_start', s.scheduled_start,
                'scheduled_end',   s.scheduled_end,
                'actual_start',    s.actual_start)
              ORDER BY s.sort_order, s.id)
         FROM leod_sessions s
        WHERE s.event_id = d.event_id), '[]'::jsonb),
    'sponsors', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'id',         sp.id,
                'name',       sp.name,
                'logo_url',   sp.logo_url,
                'bg_color',   sp.bg_color,
                'sort_order', sp.sort_order)
              ORDER BY sp.sort_order, sp.name)
         FROM leod_signage_sponsors sp
        WHERE sp.event_id = d.event_id AND sp.active), '[]'::jsonb),
    'stage_messages', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'session_id', m.session_id,
                'text',       m.text,
                'sent_at',    m.sent_at)
              ORDER BY m.sent_at, m.id)
         FROM leod_stage_messages m
         JOIN leod_sessions s ON s.id = m.session_id AND s.event_id = m.event_id
        WHERE m.event_id = d.event_id
          AND m.cleared_at IS NULL
          AND s.status IN ('LIVE', 'OVERRUN', 'HOLD')), '[]'::jsonb)
  );
END
$function$;
