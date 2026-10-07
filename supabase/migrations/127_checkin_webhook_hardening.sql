-- 127_checkin_webhook_hardening.sql
-- Security review of 126:
--   1. A webhook outlived the organizer who added it: removed from the team,
--      they kept receiving guest data at their own address. A webhook now
--      records who added it and delivers only while that person is still
--      the owner or an organizer of the event (also for deliveries already
--      queued). Removing someone silences their integrations.
--   2. Addresses with a custom port or credentials are refused: the
--      standard https port only, so internal services on other ports are
--      out of reach. (DNS rebinding to an internal address also fails the
--      TLS check against the organizer's hostname, and the sender refuses
--      private addresses after resolving; see _shared/net-guard.ts.)

ALTER TABLE leod_checkin_webhooks ADD COLUMN IF NOT EXISTS created_by uuid;
-- Webhooks added before this have no recorded author: they stop until re-added.
UPDATE leod_checkin_webhooks SET active = false WHERE created_by IS NULL;

-- Whether a given user (not the caller) may manage an event: its owner or
-- one of its organizers.
CREATE OR REPLACE FUNCTION checkin_user_can_edit(p_event_id uuid, p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT p_user IS NOT NULL AND (
    EXISTS (SELECT 1 FROM leod_events WHERE id = p_event_id AND created_by = p_user)
    OR EXISTS (SELECT 1 FROM leod_checkin_operators o WHERE o.event_id = p_event_id AND o.user_id = p_user AND o.role = 'organizer'));
$$;
REVOKE ALL ON FUNCTION checkin_user_can_edit(uuid, uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_webhook_enqueue(p_event_id uuid, p_topic text, p_data jsonb)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO leod_checkin_webhook_deliveries (webhook_id, topic, payload)
  SELECT w.id, p_topic, jsonb_build_object('topic', p_topic, 'event_id', p_event_id,
           'event_name', (SELECT name FROM leod_events WHERE id = p_event_id), 'occurred_at', now(), 'data', p_data)
    FROM leod_checkin_webhooks w
   WHERE w.event_id = p_event_id AND w.active AND p_topic = ANY (w.topics)
     -- (127) Only while the person who added it may still manage the event.
     AND checkin_user_can_edit(p_event_id, w.created_by);
$$;
REVOKE ALL ON FUNCTION checkin_webhook_enqueue(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_webhook_add(p_event_id uuid, p_url text, p_topics text[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_row leod_checkin_webhooks; v_host text;
BEGIN
  IF NOT checkin_can_edit_page(p_event_id) THEN
    RAISE EXCEPTION 'Only the event owner or an organizer can add webhooks' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF COALESCE(p_url, '') !~ '^https://[^\s/?#]+[^\s]*$' OR char_length(p_url) > 500 THEN
    RAISE EXCEPTION 'The address must start with https://' USING ERRCODE = 'check_violation';
  END IF;
  v_host := lower(split_part(split_part(substr(p_url, 9), '/', 1), ':', 1));
  -- (127) The standard https port only: a custom port reaches services that
  -- were never meant to be called from outside.
  IF split_part(substr(p_url, 9), '/', 1) LIKE '%:%' AND split_part(substr(p_url, 9), '/', 1) NOT LIKE '%:443' THEN
    RAISE EXCEPTION 'Use the standard https port (no :port in the address)' USING ERRCODE = 'check_violation';
  END IF;
  IF split_part(substr(p_url, 9), '/', 1) LIKE '%@%' THEN
    RAISE EXCEPTION 'The address cannot contain a user name or password' USING ERRCODE = 'check_violation';
  END IF;
  IF v_host ~ '^(localhost|.*\.local|.*\.internal|[0-9.]+|\[.*\])$' THEN
    RAISE EXCEPTION 'Use a public web address, not a local one or an IP address' USING ERRCODE = 'check_violation';
  END IF;
  IF p_topics IS NULL OR cardinality(p_topics) = 0 OR NOT (p_topics <@ ARRAY['guest.created', 'guest.checked_in', 'order.paid', 'invitation.answered']) THEN
    RAISE EXCEPTION 'Choose what to send' USING ERRCODE = 'check_violation';
  END IF;
  IF (SELECT count(*) FROM leod_checkin_webhooks WHERE event_id = p_event_id) >= 5 THEN
    RAISE EXCEPTION 'At most 5 webhooks per event' USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO leod_checkin_webhooks (event_id, url, secret, topics, created_by)
  VALUES (p_event_id, p_url, 'whsec_' || encode(extensions.gen_random_bytes(24), 'hex'), (SELECT array_agg(DISTINCT t) FROM unnest(p_topics) t), auth.uid())
  RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'secret', v_row.secret);
END;
$$;
REVOKE ALL ON FUNCTION checkin_webhook_add(uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION checkin_webhook_add(uuid, text, text[]) TO authenticated;

CREATE OR REPLACE FUNCTION checkin_webhooks_due(p_limit int)
RETURNS TABLE (id bigint, webhook_id uuid, topic text, payload jsonb, attempts int, url text, secret text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.id, d.webhook_id, d.topic, d.payload, d.attempts, w.url, w.secret
    FROM leod_checkin_webhook_deliveries d JOIN leod_checkin_webhooks w ON w.id = d.webhook_id
   WHERE d.status = 'pending' AND d.next_at <= now() AND w.active
     AND checkin_user_can_edit(w.event_id, w.created_by)   -- (127) queued before they lost access: not sent
   ORDER BY d.next_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 500));
$$;
REVOKE ALL ON FUNCTION checkin_webhooks_due(int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_webhooks_due(int) TO service_role;
