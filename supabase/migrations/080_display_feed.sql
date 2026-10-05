-- 080: paired displays read through a per-display secret.
--
-- The display page (cuedeck-display.html) uses the publishable key and never
-- signs in. Since 038 leod_sessions and leod_events have no anon SELECT
-- policy, so a paired TV read [] and showed "NO ACTIVE SESSION" with no event
-- name, no branding and no realtime. It only worked in a browser where the
-- event owner happened to be signed in.
--
-- Fix: each display gets a random secret. The page sends (display id, secret)
-- to display_feed(), a SECURITY DEFINER function that returns only what the
-- page renders for that one display's event, and doubles as the heartbeat.
-- Pairing moves to two functions so that only the device that showed the code
-- can learn the secret: it sends a random nonce with the code, the database
-- keeps only sha256(nonce), and display_pair_poll() needs the nonce itself.
--
-- 1. leod_signage_displays.display_secret: 48 hex chars, filled for every
--    existing row by the volatile default (one value per row).
-- 2. leod_signage_displays.global_override jsonb: the console's identify
--    button (identifyDisplay) has always written this column, but it never
--    existed, so the update failed unread and the flash never fired. Added so
--    the identify flash actually works through the feed.
-- 3. leod_signage_pairing.device_nonce_hash: sha256 hex of the device nonce.
--    The brief named it device_nonce; it is stored hashed because
--    authenticated users can read unexpired pairing rows (the console looks a
--    code up by value), and a clear nonce there would let any signed-in user
--    poll for another customer's secret.
-- 4. display_feed, display_pair_start, display_pair_poll (anon + authenticated).
-- 5. authenticated access to displays is scoped to events the user owns or was
--    invited to (same predicate as scoped_write_sessions). auth_all_displays
--    was USING (true): with a secret on the row, every signed-in account could
--    have read every display's secret and through it any event's programme.
-- 6. authenticated access to pairing: read unexpired rows (plus 10 minutes so
--    the console can still say "code expired"), and link an unlinked,
--    unexpired row to a display of an event the user can see. Only the
--    display_id and event_id columns are updatable. The console never inserts
--    or deletes pairing rows.
-- 7. anon loses direct access to leod_signage_displays now, not in 081: the
--    secret column would otherwise be readable by anyone with the publishable
--    key until 081. Nothing anon-only works today anyway: the old page reads
--    the display row, then gets nothing for events and sessions. A browser
--    where the owner is signed in reads as authenticated and is unaffected.
--    anon_all_pairing stays until 081 so a TV still on the old pairing screen
--    keeps working until the new page is live.
--
-- Rollback (not run):
--   DROP FUNCTION public.display_feed(uuid,text), public.display_pair_start(text,text),
--                 public.display_pair_poll(text,text);
--   DROP POLICY scoped_all_displays ON leod_signage_displays;
--   CREATE POLICY auth_all_displays ON leod_signage_displays FOR ALL TO authenticated USING (true) WITH CHECK (true);
--   CREATE POLICY anon_read_displays ON leod_signage_displays FOR SELECT TO anon USING (true);
--   CREATE POLICY anon_heartbeat ON leod_signage_displays FOR UPDATE TO anon USING (true) WITH CHECK (true);
--   GRANT SELECT ON leod_signage_displays TO anon; GRANT UPDATE (last_seen_at) ON leod_signage_displays TO anon;
--   DROP POLICY auth_read_pairing ON leod_signage_pairing; DROP POLICY auth_link_pairing ON leod_signage_pairing;
--   CREATE POLICY auth_all_pairing ON leod_signage_pairing FOR ALL TO authenticated USING (true) WITH CHECK (true);
--   GRANT INSERT, UPDATE, DELETE ON leod_signage_pairing TO authenticated;
--   ALTER TABLE leod_signage_displays DROP COLUMN display_secret, DROP COLUMN global_override;
--   ALTER TABLE leod_signage_pairing DROP COLUMN device_nonce_hash;

-- ── 1-3. Columns ──────────────────────────────────────────────
ALTER TABLE public.leod_signage_displays
  ADD COLUMN IF NOT EXISTS display_secret text NOT NULL
    DEFAULT encode(extensions.gen_random_bytes(24), 'hex');
ALTER TABLE public.leod_signage_displays
  ADD COLUMN IF NOT EXISTS global_override jsonb;
ALTER TABLE public.leod_signage_pairing
  ADD COLUMN IF NOT EXISTS device_nonce_hash text;

-- ── 4. Functions ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.display_feed(p_display_id uuid, p_secret text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
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
    RETURN NULL;  -- same answer whether the id exists or not
  END IF;

  -- Heartbeat. The console counts a display online for 60 s; writing at most
  -- every 20 s keeps a 2 s poll from flooding the console's realtime channel.
  IF d.last_seen_at IS NULL OR d.last_seen_at < now() - interval '20 seconds' THEN
    UPDATE leod_signage_displays SET last_seen_at = now() WHERE id = d.id;
  END IF;

  RETURN jsonb_build_object(
    'server_time', clock_timestamp(),
    'display',     to_jsonb(d) - 'display_secret',
    -- The page reads event.name (header, stage-timer standby) and
    -- event.brand_color (--brand). Nothing else.
    'event', (SELECT jsonb_build_object('name', e.name, 'brand_color', e.brand_color)
                FROM leod_events e WHERE e.id = d.event_id),
    -- Only the columns some display mode renders or uses for ordering/state.
    -- notes, checks, crew fields etc. never leave the database.
    'sessions', COALESCE((
       SELECT jsonb_agg(jsonb_build_object(
                'id',              s.id,
                'sort_order',      s.sort_order,
                'title',           s.title,
                'speaker',         s.speaker,
                'company',         s.company,
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
        WHERE sp.event_id = d.event_id AND sp.active), '[]'::jsonb)
  );
END
$function$;

CREATE OR REPLACE FUNCTION public.display_pair_start(p_code text, p_nonce text)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- 6 symbols from the page's pairing alphabet (no 0/O/1/I); nonce 32-64 hex.
  IF p_code IS NULL OR p_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$' THEN
    RETURN false;
  END IF;
  IF p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{32,64}$' THEN
    RETURN false;
  END IF;

  -- Pairing rows are only useful for minutes; keep the table bounded
  -- (4585 rows on 2026-10-05, none live).
  DELETE FROM leod_signage_pairing WHERE expires_at < now() - interval '1 day';
  -- Free this code if it is past its poll window (expiry + 10 minutes).
  DELETE FROM leod_signage_pairing
   WHERE code = p_code AND expires_at < now() - interval '10 minutes';

  INSERT INTO leod_signage_pairing (code, event_id, expires_at, device_nonce_hash)
  VALUES (p_code,
          '00000000-0000-0000-0000-000000000000',  -- placeholder; the console sets the real event
          now() + interval '5 minutes',
          encode(extensions.digest(p_nonce, 'sha256'), 'hex'))
  ON CONFLICT (code) DO NOTHING;

  RETURN FOUND;  -- false when the code is still taken
END
$function$;

CREATE OR REPLACE FUNCTION public.display_pair_poll(p_code text, p_nonce text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v jsonb;
BEGIN
  IF p_code IS NULL OR p_nonce IS NULL OR p_nonce !~ '^[0-9a-f]{32,64}$' THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object('display_id', d.id, 'secret', d.display_secret)
    INTO v
    FROM leod_signage_pairing p
    JOIN leod_signage_displays d ON d.id = p.display_id AND d.event_id = p.event_id
   WHERE p.code = p_code
     AND p.device_nonce_hash = encode(extensions.digest(p_nonce, 'sha256'), 'hex')
     AND p.expires_at > now() - interval '10 minutes';

  RETURN v;  -- NULL until the console links the code
END
$function$;

REVOKE ALL ON FUNCTION public.display_feed(uuid, text)       FROM PUBLIC;
REVOKE ALL ON FUNCTION public.display_pair_start(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.display_pair_poll(text, text)  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.display_feed(uuid, text)       TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.display_pair_start(text, text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.display_pair_poll(text, text)  TO anon, authenticated, service_role;

-- ── 5. Displays: authenticated scoped to own/invited events ───
DROP POLICY IF EXISTS auth_all_displays ON public.leod_signage_displays;
CREATE POLICY scoped_all_displays ON public.leod_signage_displays
  FOR ALL TO authenticated
  USING (event_id IN (
    SELECT leod_events.id FROM leod_events
     WHERE leod_events.created_by = auth.uid()
        OR leod_events.created_by IN (SELECT leod_users.invited_by FROM leod_users
                                       WHERE leod_users.id = auth.uid()
                                         AND leod_users.invited_by IS NOT NULL)))
  WITH CHECK (event_id IN (
    SELECT leod_events.id FROM leod_events
     WHERE leod_events.created_by = auth.uid()
        OR leod_events.created_by IN (SELECT leod_users.invited_by FROM leod_users
                                       WHERE leod_users.id = auth.uid()
                                         AND leod_users.invited_by IS NOT NULL)));

-- ── 6. Pairing: authenticated may look up and link, nothing else ──
DROP POLICY IF EXISTS auth_all_pairing ON public.leod_signage_pairing;
CREATE POLICY auth_read_pairing ON public.leod_signage_pairing
  FOR SELECT TO authenticated
  USING (expires_at > now() - interval '10 minutes');
-- The display subquery runs under the displays policy above, so only a
-- display of an event the user owns or was invited to passes.
CREATE POLICY auth_link_pairing ON public.leod_signage_pairing
  FOR UPDATE TO authenticated
  USING (display_id IS NULL AND expires_at > now())
  WITH CHECK (display_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM leod_signage_displays d
     WHERE d.id = leod_signage_pairing.display_id
       AND d.event_id = leod_signage_pairing.event_id));
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.leod_signage_pairing FROM authenticated;
GRANT UPDATE (display_id, event_id) ON public.leod_signage_pairing TO authenticated;

-- ── 7. Displays: no direct anon access (the feed replaces it) ──
DROP POLICY IF EXISTS anon_read_displays ON public.leod_signage_displays;
DROP POLICY IF EXISTS anon_heartbeat     ON public.leod_signage_displays;
REVOKE ALL ON public.leod_signage_displays FROM anon;
