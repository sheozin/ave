-- ============================================================
-- CueDeck — Migration 055: Check-in module — self-registration kiosk
-- ============================================================
-- Server-side support for the unattended kiosk described in
-- docs/superpowers/specs/2026-08-03-checkin-station-ui-design.md,
-- consumed by the checkin-self-register Edge Function.
--
-- The thing to hold in mind throughout: this is a PUBLIC TOUCH SCREEN
-- in a hotel lobby. It has no operator session, no RLS policy of its
-- own, and strangers type into it. Every addition below exists because
-- of that, not because the desk needed it.
--
--
-- 1. consent_at ON ATTENDEES
--
-- GDPR requires a RECORD that consent was given, not a checkbox that
-- was ticked and then forgotten. Article 7(1) puts the burden of
-- demonstrating consent on the controller, and "the kiosk wouldn't
-- have let them through without ticking it" is not a demonstration —
-- it is an assertion about code that has since been redeployed.
--
-- Nullable, deliberately. Every row that exists today came from a CSV
-- import or an organizer's own insert, where consent was collected
-- elsewhere (the external registration system) and CueDeck holds no
-- evidence of it. Backfilling those with now() would be manufacturing
-- a compliance record, which is worse than having none. NULL means
-- exactly "this system did not witness consent".
--
--
-- 2. source ON ATTENDEES — walk-up vs pre-registered
--
-- The organizer needs to know who arrived unregistered: it is the
-- number that decides whether next year's kiosk count goes up, and at
-- the desk it explains why someone is not on the printed list.
--
-- Mechanism: a small CHECKed TEXT column, not a boolean and not an
-- inference.
--
--   - NOT a boolean (self_registered). Booleans stop answering the
--     question the moment a third path exists, and the desk's own
--     "add a walk-in" flow is already foreseeable. Adding a value to a
--     CHECK is one statement; splitting a boolean into a taxonomy
--     after the fact means rewriting live rows.
--   - NOT inferred from `consent_at IS NOT NULL`. That conflates a
--     legal record with a provenance record. The day an import path
--     starts carrying consent timestamps from the upstream registration
--     system — which is the correct thing for it to do — every imported
--     attendee silently becomes a walk-up in the report.
--   - CHECKed rather than free text, because a report that splits on
--     'kiosk' is broken silently by one writer that stores 'Kiosk'.
--
-- Only the two values that actually exist are allowed. 'import' is the
-- default and means "the organizer put this person on the list",
-- whether by CSV or by direct insert — that is the distinction the
-- report is asking about, and it is true of every pre-existing row.
--
--
-- 3. 'kiosk' ADDED TO leod_checkin_devices.kind
--
-- Without this there is no way to provision a kiosk at all: the CHECK
-- from migration 048 allows only 'checkin_station' and 'scanner'.
--
-- Registering the lobby screen as a 'checkin_station' would "work" and
-- is exactly what must not be possible. A checkin_station key drives
-- the staffed desk; a kiosk key drives an anonymous insert endpoint.
-- One kind means a key lifted off the public screen in the lobby is
-- also a desk credential, and a desk device left in a drawer can be
-- pointed at the kiosk endpoint. checkin-self-register requires
-- kind = 'kiosk' precisely so those two blast radii stay separate.
--
-- The existing CHECK (kind != 'scanner' OR scan_point_id IS NOT NULL)
-- is untouched and unaffected: a kiosk has no scan point.
--
--
-- 4. RATE LIMITING — leod_checkin_kiosk_attempts + rate check
--
-- An unattended screen on a public network is two things at once:
--
--   - a badge-printing DoS. Every accepted submission is an attendee
--     row, a QR email out of the event's sending reputation, and on a
--     self-print event a physical badge.
--   - an enumeration probe. checkin-self-register answers
--     'already_registered' for an address on file. That response is
--     deliberately empty of detail, but it is still a yes/no oracle,
--     and an oracle answers as many questions as it is asked. Ten
--     thousand questions is a membership list of the conference.
--
-- Two buckets, because they fail differently:
--
--   - PER DEVICE KEY, 30 per 10 minutes. A human self-registering at a
--     touch screen takes 60-90 seconds of typing, so one screen cannot
--     physically exceed ~1/minute sustained. 3/minute is far above any
--     real queue and far below a script.
--   - PER EVENT, 300 per hour across every kiosk. The per-device
--     bucket alone is defeated by provisioning (or stealing) several
--     keys; this is the cap on the total damage one event can take in
--     an hour, regardless of how many screens are involved.
--
-- WHY THIS IS A DATABASE FUNCTION AND NOT TWO QUERIES FROM THE
-- EDGE FUNCTION
--
-- A limiter written as "SELECT count(), decide, INSERT" from the
-- caller is not a limiter. The attacker it exists to stop is the one
-- sending requests in parallel — fifty concurrent requests all read
-- count = 29, all conclude they are under the limit, and all proceed.
-- Edge Functions scale out horizontally, so there is no shared
-- in-process state to lean on either. The check and the increment have
-- to be one atomic operation, and the only place that can happen is
-- inside a single database transaction.
--
-- The advisory lock is keyed on the EVENT, which covers both buckets:
-- a device belongs to exactly one event, so serialising per event
-- serialises every device bucket nested under it. One lock, no lock
-- ordering to get wrong, and contention scoped to a single event's
-- kiosks.
--
-- WHAT IS AND IS NOT RECORDED
--
-- Only ACCEPTED attempts are counted. A rejected attempt writes
-- nothing, so a sustained attack cannot inflate this table without
-- bound, and the bucket drains on schedule instead of extending itself
-- into a permanent lockout of a legitimate screen. Rejections are
-- logged by the Edge Function (device id and outcome only).
--
-- The table holds NO personal data — event, device, timestamp. It is a
-- counter, not an audit log, and it is not a place to look up who
-- tried to register. Rows older than the longest window are deleted
-- opportunistically under the lock already held, which keeps the table
-- naturally bounded without a cron job.
--
-- RLS POSTURE: enabled with NO policies at all, plus an explicit
-- REVOKE. RLS-enabled-and-policy-less denies every authenticated and
-- anon read and write; the REVOKE means that stays true even if
-- someone later adds a policy without thinking about this table. The
-- service role bypasses RLS and is the only intended caller. EXECUTE
-- on the function is revoked from anon and authenticated for the same
-- reason it matters most: an anon-callable rate checker is itself the
-- denial of service, since every call burns a slot in the bucket.
--
--
-- 5. checkin_kiosk_lookup_by_email
--
-- On an email collision the Edge Function has to reach the EXISTING
-- attendee to mail the code to the address on file. The key it must
-- match on is lower(email) — migration 050's unique index — and
-- PostgREST cannot express a filter on an expression index.
--
-- The alternative was ILIKE, which is wrong in a way that matters: '_'
-- and '%' are legal in the local part of an address and are wildcards
-- to ILIKE, so 'a_b@x.com' also matches 'axb@x.com'. That returns the
-- wrong person's row and mails their code to their own address — no
-- leak, but the person standing at the screen never gets theirs, and
-- it is inducible on purpose.
--
-- The other alternative was reading the event's whole attendee list
-- into the function and filtering in TypeScript, which pulls the
-- entire roster's PII into memory on every collision. That is the
-- exact thing the kiosk architecture exists to avoid.
--
-- Returns the four columns the QR email needs and nothing else, and
-- EXECUTE is revoked from anon and authenticated — this function is a
-- lookup from an email address to a qr_token, which is the single most
-- dangerous shape in the check-in module if it is ever reachable by a
-- caller holding only the publishable key.
--
--
-- 6. checkin_guard_attendee_columns EXTENDED (from migration 054)
--
-- 054 stops a crew operator holding the anon key from PATCHing
-- checked_in_at, ticket_type, email and external_ref directly. The two
-- columns added by this migration belong in the same list:
--
--   consent_at — fabricating a consent timestamp manufactures evidence
--     for a data subject request; erasing one destroys it. Neither is
--     a desk task.
--   source — flipping 'kiosk' to 'import' falsifies the walk-up count
--     the organizer bases next year's plan on. Same class as
--     external_ref: a reporting/identity key, not a display field.
--
-- The function is replaced here rather than editing 054, following the
-- precedent migration 051 set when it replaced
-- checkin_lock_attendee_identity(). The rest of the body is unchanged;
-- the service-role exemption still applies, so checkin-self-register
-- writes both columns freely.
-- ============================================================

-- ── 1. Consent record ─────────────────────────────────────────────

ALTER TABLE leod_checkin_attendees
  ADD COLUMN IF NOT EXISTS consent_at TIMESTAMPTZ;


-- ── 2. Walk-up vs pre-registered ──────────────────────────────────

ALTER TABLE leod_checkin_attendees
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'import';

ALTER TABLE leod_checkin_attendees
  DROP CONSTRAINT IF EXISTS leod_checkin_attendees_source_check;

ALTER TABLE leod_checkin_attendees
  ADD CONSTRAINT leod_checkin_attendees_source_check
  CHECK (source IN ('import', 'kiosk'));

-- Partial: the reporting question is always "which of these arrived
-- unregistered", never "which were imported", and walk-ups are the
-- minority on every event this is built for.
CREATE INDEX IF NOT EXISTS idx_checkin_attendees_kiosk_source
  ON leod_checkin_attendees (event_id) WHERE source = 'kiosk';


-- ── 3. Kiosk device kind ──────────────────────────────────────────

ALTER TABLE leod_checkin_devices
  DROP CONSTRAINT IF EXISTS leod_checkin_devices_kind_check;

ALTER TABLE leod_checkin_devices
  ADD CONSTRAINT leod_checkin_devices_kind_check
  CHECK (kind IN ('checkin_station', 'scanner', 'kiosk'));


-- ── 4. Rate limiting ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leod_checkin_kiosk_attempts (
  id           BIGSERIAL   PRIMARY KEY,
  event_id     UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  device_id    UUID        NOT NULL REFERENCES leod_checkin_devices(id) ON DELETE CASCADE,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkin_kiosk_attempts_device
  ON leod_checkin_kiosk_attempts (device_id, attempted_at DESC);

CREATE INDEX IF NOT EXISTS idx_checkin_kiosk_attempts_event
  ON leod_checkin_kiosk_attempts (event_id, attempted_at DESC);

ALTER TABLE leod_checkin_kiosk_attempts ENABLE ROW LEVEL SECURITY;

-- No policy is created, and that is the point: RLS enabled with zero
-- policies denies everything to anon and authenticated. Listed here so
-- a future reader does not "fix" the missing policy.
DROP POLICY IF EXISTS checkin_kiosk_attempts_read  ON leod_checkin_kiosk_attempts;
DROP POLICY IF EXISTS checkin_kiosk_attempts_write ON leod_checkin_kiosk_attempts;

REVOKE ALL ON TABLE leod_checkin_kiosk_attempts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_kiosk_attempts_id_seq FROM anon, authenticated;

-- Returns TRUE if this attempt is within both buckets and has been
-- counted; FALSE if either bucket is full. Deliberately a bare
-- boolean with no reason code: the caller returns one generic refusal
-- either way, so an attacker cannot tell which limit they hit and tune
-- their rate to sit just under it.
CREATE OR REPLACE FUNCTION public.checkin_kiosk_rate_check(
  p_event_id  UUID,
  p_device_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c_device_window CONSTANT INTERVAL := INTERVAL '10 minutes';
  c_device_limit  CONSTANT INT      := 30;
  c_event_window  CONSTANT INTERVAL := INTERVAL '1 hour';
  c_event_limit   CONSTANT INT      := 300;
  -- Must stay >= the longest window above, or the prune deletes rows
  -- that are still being counted and the limiter quietly stops working.
  c_retention     CONSTANT INTERVAL := INTERVAL '2 hours';
  v_count INT;
BEGIN
  -- Serialises check-and-increment for this event. Held until the
  -- transaction ends, which for a PostgREST RPC is the end of the
  -- request. Without it, concurrent requests each read a stale count
  -- and every one of them passes.
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_kiosk_rate:' || p_event_id::TEXT, 0));

  DELETE FROM leod_checkin_kiosk_attempts
   WHERE event_id = p_event_id
     AND attempted_at < now() - c_retention;

  SELECT count(*) INTO v_count
    FROM leod_checkin_kiosk_attempts
   WHERE event_id = p_event_id
     AND attempted_at > now() - c_event_window;
  IF v_count >= c_event_limit THEN
    RETURN false;
  END IF;

  SELECT count(*) INTO v_count
    FROM leod_checkin_kiosk_attempts
   WHERE device_id = p_device_id
     AND attempted_at > now() - c_device_window;
  IF v_count >= c_device_limit THEN
    RETURN false;
  END IF;

  INSERT INTO leod_checkin_kiosk_attempts (event_id, device_id)
  VALUES (p_event_id, p_device_id);

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.checkin_kiosk_rate_check(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_kiosk_rate_check(UUID, UUID) TO service_role;


-- ── 5. Collision lookup ───────────────────────────────────────────

-- Every reference is qualified through the `a` alias so the RETURNS
-- TABLE output names cannot shadow the table's own columns.
CREATE OR REPLACE FUNCTION public.checkin_kiosk_lookup_by_email(
  p_event_id UUID,
  p_email    TEXT
)
RETURNS TABLE (id UUID, first_name TEXT, email TEXT, qr_token TEXT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT a.id, a.first_name, a.email, a.qr_token
  FROM leod_checkin_attendees a
  WHERE a.event_id = p_event_id
    AND lower(a.email) = lower(trim(p_email))
  LIMIT 1
$function$;

REVOKE ALL ON FUNCTION public.checkin_kiosk_lookup_by_email(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_kiosk_lookup_by_email(UUID, TEXT) TO service_role;


-- ── 6. Extend the migration 054 column guard ──────────────────────

CREATE OR REPLACE FUNCTION public.checkin_guard_attendee_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller TEXT := auth.role();
  v_role   TEXT;
BEGIN
  -- See migration 054's header: role-based, not uid-based.
  IF v_caller IS NULL OR v_caller = 'service_role' THEN
    RETURN NEW;
  END IF;

  v_role := checkin_role_for_event(OLD.event_id);

  IF v_role = 'organizer' THEN
    RETURN NEW;
  END IF;

  IF NEW.checked_in_at IS DISTINCT FROM OLD.checked_in_at THEN
    RAISE EXCEPTION
      'checked_in_at may only be changed by an organizer or through the check-in Edge Function'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.ticket_type IS DISTINCT FROM OLD.ticket_type THEN
    RAISE EXCEPTION 'ticket_type may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW.external_ref IS DISTINCT FROM OLD.external_ref THEN
    RAISE EXCEPTION 'external_ref may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Added in migration 055. A consent record is evidence for a GDPR
  -- Article 7(1) demonstration; a desk operator neither creates nor
  -- destroys it.
  IF NEW.consent_at IS DISTINCT FROM OLD.consent_at THEN
    RAISE EXCEPTION 'consent_at may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Added in migration 055. Provenance, not presentation: the walk-up
  -- count is a reported number, and a field that can be rewritten at
  -- the desk is not a measurement.
  IF NEW.source IS DISTINCT FROM OLD.source THEN
    RAISE EXCEPTION 'source may only be changed by an organizer'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- badge_printed_at stays UNGUARDED (see migration 054): the desk page
  -- stamps it from the operator's own JWT right after window.print(),
  -- and crew is the role that works the desk.
  --
  -- first_name, last_name, company, role_title and custom_fields stay
  -- writable by crew: correcting a misspelled badge at the desk is a
  -- core part of the job, and none of them carry privilege.
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_checkin_guard_attendee_columns ON leod_checkin_attendees;

CREATE TRIGGER trg_checkin_guard_attendee_columns
  BEFORE UPDATE ON leod_checkin_attendees
  FOR EACH ROW
  EXECUTE FUNCTION public.checkin_guard_attendee_columns();
