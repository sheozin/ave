-- ============================================================
-- CueDeck — Migration 057: Check-in — device revocation
-- ============================================================
-- A kiosk key is a write credential. It creates attendee rows, sends
-- mail out of the event's sending reputation and, on a self-print
-- event, produces physical badges. Migrations 055 and 056 gave the
-- platform a way to MAKE one; there has never been a way to take one
-- back.
--
-- That gap has a shape in the real world. The tablet is a consumer
-- device standing unattended in a hotel lobby for three days. It gets
-- picked up, it goes home in somebody's bag, it is sold with the venue's
-- old stock, or the raw key is lifted out of localStorage by anyone who
-- walks up to it with a keyboard. The only remedies available today are
-- deleting the device row — which cascades leod_checkin_kiosk_attempts
-- and destroys the rate-limiting history, and takes the provenance link
-- from leod_checkin_kiosk_pairing.device_id with it — or leaving a live
-- credential in circulation. Neither is a remedy.
--
-- So: one nullable timestamp, one Edge Function guard, and a control in
-- the organizer's own kiosk list.
--
--
-- 1. WHY RLS AND NOT A GUARD TRIGGER FOR THE CREW QUESTION
--
-- Migration 054 needed a trigger, and the reason it needed one does not
-- exist here. On leod_checkin_attendees the write policy is:
--
--   checkin_att_update FOR UPDATE TO authenticated
--   USING (checkin_role_for_event(event_id) IN ('organizer','crew'))
--
-- Crew are INSIDE that policy. The policy is column-blind, so once crew
-- can update the row at all, only a trigger comparing OLD to NEW can say
-- which columns they may touch. A WITH CHECK expression cannot see OLD.
--
-- leod_checkin_devices is the opposite shape. Its only write policy is
-- migration 048's:
--
--   checkin_dev_write FOR ALL TO authenticated
--   USING       (checkin_role_for_event(event_id) = 'organizer')
--   WITH CHECK  (checkin_role_for_event(event_id) = 'organizer')
--
-- There is NO crew write policy on this table and never has been. A crew
-- operator holding the publishable key and their own JWT matches no
-- permissive UPDATE policy, so their PATCH updates zero rows. It fails
-- closed, silently, at the policy layer, before any column is
-- considered — which is the correct outcome and needs nothing added.
-- Adding a column guard for crew here would be machinery that can never
-- fire, and machinery that can never fire is machinery nobody maintains.
--
-- STATED AS AN INVARIANT SO A LATER EDIT HAS TO NOTICE IT: everything
-- below assumes leod_checkin_devices has no write policy that admits
-- 'crew'. The day one is added, the trigger in section 3 must grow a
-- crew clause, exactly as 054's did.
--
-- checkin_dev_write is FOR ALL rather than a set of per-command
-- policies, so it already covers the UPDATE that sets revoked_at. No
-- policy change is needed to let an organizer revoke, and none is made.
--
--
-- 2. A REVOKED DEVICE STAYS READABLE
--
-- checkin_dev_read is untouched, and deliberately carries no
-- `revoked_at IS NULL` clause. "This kiosk was revoked at 09:14" is the
-- answer to the only question anybody asks afterwards, and a row that
-- vanishes on revocation is indistinguishable from a row that was never
-- there — which is precisely the confusion at 07:00 the paired-kiosk
-- list exists to remove. The revoked row is also what stops somebody
-- re-pairing the same tablet and wondering why there are now two.
--
-- Crew keep their SELECT on it (051). A revocation timestamp is not a
-- secret from the people working the desk; it is the explanation for
-- why the lobby screen stopped working.
--
--
-- 3. WHY ONE-WAY, AND WHY THAT IS A TRIGGER
--
-- The console calls this destructive and irreversible: the device must
-- re-pair, with a fresh code and a fresh key, to work again. That
-- sentence is only true if the database enforces it. An organizer holds
-- checkin_dev_write, so without this trigger they could PATCH
-- revoked_at back to NULL and the old key — still hashed in
-- api_key_hash, still sitting in the localStorage of whoever now has the
-- tablet — would start working again. Un-revoking is not an undo; it is
-- re-issuing the exact credential that was withdrawn.
--
-- A WITH CHECK cannot express this: it cannot see OLD, so it cannot say
-- "this column was already set". That is the same reason 054 reached for
-- a trigger, applied to a different question — not the crew question,
-- which section 1 disposes of, but the one-way question.
--
-- The trigger is narrow on purpose. It fires only when revoked_at is
-- ALREADY non-null and the statement changes it. Setting it for the
-- first time passes. Updating label, last_seen_at or anything else on an
-- already-revoked row passes. It constrains one transition and no other.
--
-- ROLE DETECTION IS COPIED FROM 054, including the reasoning: by
-- auth.role() and never by `auth.uid() IS NULL`, so an anon-callable
-- path added later cannot switch the guard off with no error and no
-- diff. service_role is exempt because checkin-self-register updates
-- last_seen_at on this table on every registration and must never be
-- blocked by a guard aimed at a console. A NULL caller is exempt for a
-- different reason worth saying out loud: a direct SQL session is an
-- administrator, and an administrator undoing a mis-clicked revocation
-- is the intended escape hatch. The property being bought is "the
-- console cannot quietly re-arm a withdrawn key", not "no power on
-- earth can".
--
-- It RAISES rather than reverting silently, following 054: a 200 for a
-- write that did not land is a failure mode worth not repeating.
--
--
-- 4. WHAT THIS COLUMN DOES NOT DO
--
-- Setting it does not, by itself, stop anything. RLS does not gate
-- checkin-self-register, which reaches this table with the service role
-- and bypasses policies entirely. The enforcement is one explicit check
-- in that function, added in the same change as this migration, in the
-- same condition that already rejects an unknown key, a key from
-- another event and a non-kiosk key. All four produce the same 401, so a
-- revoked key cannot be told apart from one that never existed.
--
-- ORDER OF OPERATIONS, because it is load-bearing: this migration must
-- be applied BEFORE checkin-self-register is deployed. The deployed
-- function selects revoked_at, and PostgREST answers a select of a
-- column that does not exist with an error — which that function treats
-- as "no device" and answers 401. Deploying first would take every kiosk
-- on the platform offline until the migration landed.
--
-- No index is added. The revoked check reads a column of a row already
-- fetched by the unique index on api_key_hash, and the organizer's list
-- is a handful of rows for one event.
-- ============================================================

-- ── 1. The column ─────────────────────────────────────────────────

-- Nullable, and NULL means live. No default and no backfill: every
-- device that exists today is in service, which is exactly what NULL
-- says.
ALTER TABLE leod_checkin_devices
  ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

COMMENT ON COLUMN leod_checkin_devices.revoked_at IS
  'When this device key was withdrawn. NULL means live. One-way: see checkin_guard_device_revocation(). Enforced by checkin-self-register, not by RLS.';


-- ── 2. No policy changes ──────────────────────────────────────────
--
-- Intentionally empty. checkin_dev_write (048) already scopes every
-- write on this table to the organizer, and checkin_dev_read (051)
-- already lets organizer and crew see the row including its revocation.
-- Listed here so a future reader does not add a policy that widens
-- either one by accident. See sections 1 and 2 above.


-- ── 3. Revocation is one-way ──────────────────────────────────────

-- NOT SECURITY DEFINER, and that is a deliberate departure from 054.
-- 054's guard calls checkin_role_for_event(), which reads
-- leod_checkin_operators, so it needs rights the caller does not have.
-- This one reads no table at all: OLD and NEW are already in hand and
-- auth.role() is executable by everyone. Invoker rights are sufficient,
-- so elevated rights would be privilege granted for nothing.
-- search_path is still pinned, because an unpinned one is how a
-- plpgsql function gets its function calls resolved somewhere else.
CREATE OR REPLACE FUNCTION public.checkin_guard_device_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
BEGIN
  -- See the header, section 3. Role-based, not uid-based.
  --   'service_role'  -> an Edge Function (last_seen_at, and the
  --                      pairing insert). Never blocked.
  --   NULL            -> direct admin SQL. The escape hatch.
  --   'anon'          -> unauthenticated PostgREST. No policy admits it
  --                      to this table today; guarded anyway.
  --   'authenticated' -> the console. GUARDED.
  IF v_caller IS NULL OR v_caller = 'service_role' THEN
    RETURN NEW;
  END IF;

  -- Only the transition OUT OF a revoked state. Setting revoked_at for
  -- the first time is the whole point of the column and passes here.
  IF OLD.revoked_at IS NOT NULL
     AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION
      'revoked_at cannot be cleared or changed: a revoked device must pair again for a new key'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_guard_device_revocation ON leod_checkin_devices;

-- BEFORE triggers fire in alphabetical order by name, so this runs
-- before trg_checkin_validate_device_scan_point (g < v). The two are
-- independent: that one reads NEW.scan_point_id and NEW.event_id, this
-- one reads OLD.revoked_at and NEW.revoked_at, and neither writes NEW.
CREATE TRIGGER trg_checkin_guard_device_revocation
  BEFORE UPDATE ON leod_checkin_devices
  FOR EACH ROW
  EXECUTE FUNCTION public.checkin_guard_device_revocation();
