-- 083: pairing goes through one function; per-display key rotation; sponsors
-- leave anon and are scoped to the events a user can see.
--
-- Follow-ups to 080/081 (release review, 2026-10-05).
--
-- 1. Pairing hijack. 080 let every signed-in account list all unexpired
--    pairing codes (auth_read_pairing) and link any of them to a display of
--    its own (auth_link_pairing), so a stranger could take over a TV while it
--    showed its code. display_pair_link() replaces both: the caller names the
--    code it was told and a display it can see (own or invited event, the
--    same predicate as scoped_all_displays), and gets back 'linked' or a
--    reason ('forbidden', 'not_found', 'used', 'expired'). Nothing is listed.
--    authenticated loses every privilege on leod_signage_pairing; after this
--    only the SECURITY DEFINER functions touch the table.
-- 2. display_rotate_secret(): a fresh key for one display (own or invited
--    event). The TV holding the old key gets NULL from display_feed and goes
--    back to pairing. Pairing rows that point at the display are deleted, so
--    the device that paired it cannot collect the new key with its nonce
--    during display_pair_poll's 10-minute window.
-- 3. anon_read_sponsors (roles {anon}, checked live 2026-10-05) is unused:
--    the display reads sponsors through display_feed and the console is
--    signed in. Dropped, and anon's table grants revoked.
--    auth_all_sponsors was FOR ALL TO authenticated USING (true): any signed-in
--    account could read, replace or delete every customer's sponsors, which
--    the TVs show. Replaced with the scoped_all_displays predicate. The console
--    (the only caller; no edge function or admin page touches the table) reads
--    and writes sponsors of S.event only.
--
-- 4. Deactivated operators. An invited operator whose leod_users.active is
--    false still passed the invited branch of every predicate above and of
--    scoped_all_displays (080). All of them now also require
--    active IS NOT FALSE; scoped_all_displays is re-created with the same
--    predicate plus that condition. Live 2026-10-05: active is boolean
--    NOT NULL DEFAULT true, 21 users, none inactive, so nobody loses access.
--
-- leod_clock is left alone on purpose.
--
-- Callers checked 2026-10-05: leod_signage_pairing is used by
-- cuedeck-console.html pairDisplayByCode (moved to display_pair_link in the
-- same branch) and by cuedeck-display.html through display_pair_start /
-- display_pair_poll (RPC only). Apply this migration together with the
-- console change: the old console reads the table directly and would show
-- "Invalid pairing code" for every code once this is applied.
--
-- Rollback (not run):
--   DROP FUNCTION public.display_pair_link(text, uuid), public.display_rotate_secret(uuid);
--   GRANT SELECT ON leod_signage_pairing TO authenticated;
--   GRANT UPDATE (display_id, event_id) ON leod_signage_pairing TO authenticated;
--   CREATE POLICY auth_read_pairing ON leod_signage_pairing FOR SELECT TO authenticated
--     USING (expires_at > now() - interval '10 minutes');
--   CREATE POLICY auth_link_pairing ON leod_signage_pairing FOR UPDATE TO authenticated
--     USING (display_id IS NULL AND expires_at > now())
--     WITH CHECK (display_id IS NOT NULL AND EXISTS (SELECT 1 FROM leod_signage_displays d
--       WHERE d.id = leod_signage_pairing.display_id AND d.event_id = leod_signage_pairing.event_id));
--   (scoped_all_displays: re-create without "AND leod_users.active IS NOT FALSE", as in 080)
--   DROP POLICY scoped_all_sponsors ON leod_signage_sponsors;
--   CREATE POLICY auth_all_sponsors ON leod_signage_sponsors FOR ALL TO authenticated USING (true) WITH CHECK (true);
--   CREATE POLICY anon_read_sponsors ON leod_signage_sponsors FOR SELECT TO anon USING (true);
--   GRANT SELECT ON leod_signage_sponsors TO anon;

-- ── 1. Pairing: one function, no table access ─────────────────
CREATE OR REPLACE FUNCTION public.display_pair_link(p_code text, p_display_id uuid)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid   uuid := auth.uid();
  v_event uuid;
  v_row   leod_signage_pairing%ROWTYPE;
BEGIN
  -- The display must belong to an event the caller owns or was invited to.
  -- Checked first, so a caller without a display learns nothing about codes.
  SELECT d.event_id INTO v_event
    FROM leod_signage_displays d
    JOIN leod_events e ON e.id = d.event_id
   WHERE d.id = p_display_id
     AND v_uid IS NOT NULL
     AND (e.created_by = v_uid
          OR e.created_by IN (SELECT u.invited_by FROM leod_users u
                               WHERE u.id = v_uid AND u.invited_by IS NOT NULL
                                 AND u.active IS NOT FALSE));
  IF NOT FOUND THEN
    RETURN 'forbidden';
  END IF;

  UPDATE leod_signage_pairing
     SET display_id = p_display_id, event_id = v_event
   WHERE code = p_code AND display_id IS NULL AND expires_at > now()
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN 'linked';
  END IF;

  SELECT * INTO v_row FROM leod_signage_pairing WHERE code = p_code;
  IF NOT FOUND THEN
    RETURN 'not_found';
  ELSIF v_row.display_id IS NOT NULL THEN
    RETURN 'used';
  END IF;
  RETURN 'expired';
END
$function$;

DROP POLICY IF EXISTS auth_read_pairing ON public.leod_signage_pairing;
DROP POLICY IF EXISTS auth_link_pairing ON public.leod_signage_pairing;
REVOKE UPDATE (display_id, event_id) ON public.leod_signage_pairing FROM authenticated;
REVOKE ALL ON public.leod_signage_pairing FROM authenticated;

-- ── 2. Key rotation ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.display_rotate_secret(p_display_id uuid)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL OR p_display_id IS NULL THEN
    RETURN false;
  END IF;

  UPDATE leod_signage_displays d
     SET display_secret = encode(extensions.gen_random_bytes(24), 'hex')
   WHERE d.id = p_display_id
     AND d.event_id IN (
       SELECT e.id FROM leod_events e
        WHERE e.created_by = v_uid
           OR e.created_by IN (SELECT u.invited_by FROM leod_users u
                                WHERE u.id = v_uid AND u.invited_by IS NOT NULL
                                 AND u.active IS NOT FALSE));
  IF NOT FOUND THEN
    RETURN false;
  END IF;

  DELETE FROM leod_signage_pairing WHERE display_id = p_display_id;
  RETURN true;
END
$function$;

REVOKE ALL ON FUNCTION public.display_pair_link(text, uuid)   FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.display_rotate_secret(uuid)     FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.display_pair_link(text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.display_rotate_secret(uuid)   TO authenticated, service_role;

-- ── 3. Sponsors: no anon, authenticated scoped ────────────────
DROP POLICY IF EXISTS anon_read_sponsors ON public.leod_signage_sponsors;
REVOKE ALL ON public.leod_signage_sponsors FROM anon;

DROP POLICY IF EXISTS auth_all_sponsors ON public.leod_signage_sponsors;
DROP POLICY IF EXISTS scoped_all_sponsors ON public.leod_signage_sponsors;
CREATE POLICY scoped_all_sponsors ON public.leod_signage_sponsors
  FOR ALL TO authenticated
  USING (event_id IN (
    SELECT leod_events.id FROM leod_events
     WHERE leod_events.created_by = auth.uid()
        OR leod_events.created_by IN (SELECT leod_users.invited_by FROM leod_users
                                       WHERE leod_users.id = auth.uid()
                                         AND leod_users.invited_by IS NOT NULL
                                         AND leod_users.active IS NOT FALSE)))
  WITH CHECK (event_id IN (
    SELECT leod_events.id FROM leod_events
     WHERE leod_events.created_by = auth.uid()
        OR leod_events.created_by IN (SELECT leod_users.invited_by FROM leod_users
                                       WHERE leod_users.id = auth.uid()
                                         AND leod_users.invited_by IS NOT NULL
                                         AND leod_users.active IS NOT FALSE)));

-- ── 4. Displays: same scope, deactivated operators excluded ───
DROP POLICY IF EXISTS scoped_all_displays ON public.leod_signage_displays;
CREATE POLICY scoped_all_displays ON public.leod_signage_displays
  FOR ALL TO authenticated
  USING (event_id IN (
    SELECT leod_events.id FROM leod_events
     WHERE leod_events.created_by = auth.uid()
        OR leod_events.created_by IN (SELECT leod_users.invited_by FROM leod_users
                                       WHERE leod_users.id = auth.uid()
                                         AND leod_users.invited_by IS NOT NULL
                                         AND leod_users.active IS NOT FALSE)))
  WITH CHECK (event_id IN (
    SELECT leod_events.id FROM leod_events
     WHERE leod_events.created_by = auth.uid()
        OR leod_events.created_by IN (SELECT leod_users.invited_by FROM leod_users
                                       WHERE leod_users.id = auth.uid()
                                         AND leod_users.invited_by IS NOT NULL
                                         AND leod_users.active IS NOT FALSE)));
