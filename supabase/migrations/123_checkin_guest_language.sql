-- 123_checkin_guest_language.sql
-- The language each guest uses, so their emails (confirmation, ticket,
-- reminder, thank-you, invitation) come in it. Recorded by checkin-register
-- whenever the guest acts on the page (register, confirm, answer an
-- invitation), per event and address. At send time: this, else the event's
-- fixed page language (122), else English.

CREATE TABLE IF NOT EXISTS leod_checkin_web_lang (
  event_id   uuid        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  email_key  text        NOT NULL,
  lang       text        NOT NULL CHECK (lang IN ('en', 'pl', 'de', 'ar')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, email_key)
);
ALTER TABLE leod_checkin_web_lang ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE leod_checkin_web_lang FROM anon, authenticated;

CREATE OR REPLACE FUNCTION checkin_web_set_lang(p_event_id uuid, p_email text, p_lang text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO leod_checkin_web_lang (event_id, email_key, lang)
  SELECT p_event_id, checkin_web_email_key(p_email), p_lang
   WHERE p_lang IN ('en', 'pl', 'de', 'ar') AND COALESCE(btrim(p_email), '') <> ''
  ON CONFLICT (event_id, email_key) DO UPDATE SET lang = EXCLUDED.lang, updated_at = now();
$$;
REVOKE ALL ON FUNCTION checkin_web_set_lang(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_set_lang(uuid, text, text) TO service_role;

-- The language to write to each address: theirs, else the event's fixed
-- page language, else English.
CREATE OR REPLACE FUNCTION checkin_web_langs(p_event_id uuid, p_emails text[])
RETURNS TABLE (email text, lang text) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT e, COALESCE(l.lang,
           (SELECT NULLIF(registration_language, 'auto') FROM leod_checkin_entitlements WHERE event_id = p_event_id), 'en')
    FROM unnest(p_emails) e
    LEFT JOIN leod_checkin_web_lang l ON l.event_id = p_event_id AND l.email_key = checkin_web_email_key(e);
$$;
REVOKE ALL ON FUNCTION checkin_web_langs(uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION checkin_web_langs(uuid, text[]) TO service_role;
