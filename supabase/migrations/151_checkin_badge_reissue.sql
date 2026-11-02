-- 151_checkin_badge_reissue.sql
-- A reprinted badge replaces the old one. The guest gets a new QR code,
-- and the old code (on the first badge AND in the QR email) is kept here
-- so a scan of it answers "old badge, blocked" instead of "not on the
-- list". Organizer decision, 2026-11-02: block everything old.

CREATE TABLE IF NOT EXISTS leod_checkin_old_badges (
  qr_token     TEXT        PRIMARY KEY,
  attendee_id  UUID        NOT NULL REFERENCES leod_checkin_attendees(id) ON DELETE CASCADE,
  event_id     UUID        NOT NULL,
  replaced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  replaced_by  UUID
);
CREATE INDEX IF NOT EXISTS leod_checkin_old_badges_event ON leod_checkin_old_badges (event_id);
CREATE INDEX IF NOT EXISTS leod_checkin_old_badges_by ON leod_checkin_old_badges (replaced_by, replaced_at);

ALTER TABLE leod_checkin_old_badges ENABLE ROW LEVEL SECURITY;
-- Read like the guest list itself; written only by checkin_reissue_badge.
DROP POLICY IF EXISTS checkin_old_badges_read ON leod_checkin_old_badges;
CREATE POLICY checkin_old_badges_read ON leod_checkin_old_badges FOR SELECT TO authenticated
  USING (checkin_role_for_event(event_id) = ANY (ARRAY['organizer', 'lead', 'crew']));
REVOKE ALL ON leod_checkin_old_badges FROM anon;
REVOKE INSERT, UPDATE, DELETE ON leod_checkin_old_badges FROM authenticated;
GRANT SELECT ON leod_checkin_old_badges TO authenticated;

-- The identity lock silently keeps qr_token for anyone but an organizer.
-- checkin_reissue_badge marks the one row it is changing, for the length
-- of its own transaction; the event_id lock is never relaxed. A client
-- cannot set this value: set_config is not callable through the API.
CREATE OR REPLACE FUNCTION checkin_lock_attendee_identity()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF current_setting('checkin.reissue_attendee', true) = OLD.id::text
     AND NEW.event_id IS NOT DISTINCT FROM OLD.event_id THEN
    RETURN NEW;
  END IF;
  IF checkin_role_for_event(OLD.event_id) IS DISTINCT FROM 'organizer'
     OR (NEW.event_id IS DISTINCT FROM OLD.event_id
         AND checkin_role_for_event(NEW.event_id) IS DISTINCT FROM 'organizer') THEN
    NEW.event_id := OLD.event_id;
    NEW.qr_token := OLD.qr_token;
  END IF;
  RETURN NEW;
END;
$$;

-- Desk staff and up may reissue (they are the ones printing). Returns the
-- new code, which the desk prints on the badge.
CREATE OR REPLACE FUNCTION checkin_reissue_badge(p_attendee_id UUID)
RETURNS TEXT
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event UUID;
  v_old   TEXT;
  v_new   TEXT := replace(gen_random_uuid()::text, '-', '');
BEGIN
  SELECT event_id, qr_token INTO v_event, v_old
    FROM leod_checkin_attendees WHERE id = p_attendee_id FOR UPDATE;
  IF v_event IS NULL THEN
    RAISE EXCEPTION 'Guest not found' USING ERRCODE = 'P0002';
  END IF;
  IF checkin_role_for_event(v_event) IS DISTINCT FROM 'organizer'
     AND checkin_role_for_event(v_event) IS DISTINCT FROM 'lead'
     AND checkin_role_for_event(v_event) IS DISTINCT FROM 'crew' THEN
    RAISE EXCEPTION 'Only desk staff can print a new badge' USING ERRCODE = '42501';
  END IF;
  -- A reprint is rare at a real desk. The cap stops one account from
  -- blocking a whole guest list's badges and email codes in a loop.
  IF (SELECT count(*) FROM leod_checkin_old_badges
       WHERE replaced_by = auth.uid() AND replaced_at > now() - interval '10 minutes') >= 20 THEN
    RAISE EXCEPTION 'Too many new badges in 10 minutes. Wait a few minutes, or ask the organizer.' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO leod_checkin_old_badges (qr_token, attendee_id, event_id, replaced_by)
  VALUES (v_old, p_attendee_id, v_event, auth.uid());

  PERFORM set_config('checkin.reissue_attendee', p_attendee_id::text, true);
  UPDATE leod_checkin_attendees SET qr_token = v_new WHERE id = p_attendee_id;
  PERFORM set_config('checkin.reissue_attendee', '', true);
  RETURN v_new;
END;
$$;

REVOKE ALL ON FUNCTION checkin_reissue_badge(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_reissue_badge(UUID) TO authenticated;
