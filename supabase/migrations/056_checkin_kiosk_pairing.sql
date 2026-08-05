-- ============================================================
-- CueDeck — Migration 056: Check-in module — kiosk pairing
-- ============================================================
-- Migration 048 gave kiosks a credential (leod_checkin_devices.
-- api_key_hash) and migration 055 gave them a kind ('kiosk'), but
-- nothing anywhere could CREATE one. The only path that existed was:
-- open a SQL editor, generate a key, compute its SHA-256 by hand,
-- INSERT the row, then get the raw value from a terminal onto a lobby
-- tablet. That is not a provisioning flow, it is a reason the kiosk
-- never ships. This migration is the missing half.
--
-- The shape is taken from leod_signage_pairing (migration 018), which
-- solved the same problem for display screens: a short code, an event,
-- an expiry, and a slot for the id that pairing produces. Three things
-- are deliberately different, and each difference is the point.
--
--
-- 1. THE DIRECTION IS REVERSED
--
-- In signage the DISPLAY mints the code and the console claims it. The
-- display is unauthenticated, so migration 018 had to give `anon` full
-- CRUD on leod_signage_pairing to let it write its own row. That is
-- survivable there: the prize is a binding to a read-only screen.
--
-- Here the prize is a WRITE credential — a key that creates attendee
-- rows, sends mail out of the event's sending reputation and, on a
-- self-print event, produces physical badges. So the ORGANIZER mints
-- (holding their own JWT) and the KIOSK claims. The unauthenticated
-- party never writes, which means this table needs no anon policy at
-- all, which means the 018 posture never has to be repeated.
--
--
-- 2. RLS: ENABLED, NO POLICIES, PLUS AN EXPLICIT REVOKE
--
-- Reason it through from who has to touch a row:
--
--   - The KIOSK claiming a code holds no session and no JWT. It is
--     `anon`. It cannot be given a SELECT policy without publishing
--     every live pairing code on the platform to the publishable key,
--     and it cannot be given an UPDATE policy without being able to
--     burn other events' codes. It gets nothing, and reaches the table
--     only through checkin-kiosk-pair's service-role client.
--   - The ORGANIZER minting a code never needs to READ the table
--     either: the Edge Function returns the code in its HTTP response,
--     which is the only moment the code is useful. A SELECT policy
--     would exist purely so a console could show a "paired" tick, and
--     would cost a table of live claimable credentials readable by
--     anyone the read policy covers.
--   - CREW must specifically NOT read it. checkin_dev_read (048) lets
--     crew SELECT device rows, so crew is already the widest role with
--     any device visibility; a readable pairing row would let a crew
--     member claim a code minted for a kiosk and walk away with a
--     kiosk key. Crew is not the role that provisions hardware.
--
-- So: nobody. RLS enabled with zero policies denies every anon and
-- authenticated read and write, and the REVOKE keeps that true if
-- someone later adds a policy to this file without re-reading this
-- paragraph. Same posture, for the same reasons, as
-- leod_checkin_kiosk_attempts in migration 055.
--
-- If a future console wants a live "kiosk paired" indicator, it polls
-- an Edge Function, not this table.
--
--
-- 3. TEN MINUTES, NOT THIRTY DAYS
--
-- A pairing code is read aloud across a hotel lobby, or texted, or
-- left on a laptop screen at an unattended desk. Its confidentiality
-- is measured in the length of a conversation, so its lifetime has to
-- be too. Signage uses five minutes; this uses ten.
--
-- Ten rather than five because the walk is longer than the signage
-- walk. The organizer mints on their laptop at the production desk,
-- then crosses the lobby to a tablet that may need unlocking, may have
-- dropped off the venue wifi, and may need the kiosk page opened from
-- a bookmark. Five minutes is enough to fail that sequence once, and a
-- volunteer who has to walk back and re-mint at 07:00 is exactly the
-- experience this migration exists to remove.
--
-- Ten rather than sixty because a code that outlives the conversation
-- it was spoken in is a credential lying around the lobby. Nothing
-- about the flow needs longer: minting again is one click.
--
--
-- 4. THE CODE SPACE
--
-- Eight characters over the 32-symbol alphabet the signage pairing
-- screen already uses — A-Z and 2-9 with I, O, 0 and 1 removed,
-- because those are the pairs people actually confuse when a code is
-- spoken across a room or read off a screen at an angle. The CHECK
-- constraint below makes that alphabet a database invariant rather
-- than a convention in one TypeScript file.
--
--   32^8 = 1,099,511,627,776 codes (40 bits)
--
-- Against a ten-minute life and the claim limiter below (30 per IP
-- per 10 minutes), an attacker guessing from a single source gets 30
-- tries per live code, for a hit probability of about
-- 3 in 10^11. Even with the limiter entirely bypassed and a million
-- guesses per second sustained for the full ten minutes — six hundred
-- million requests, which Supabase would not serve and which no
-- attacker would pay for — the chance of hitting a given live code is
-- about 5 in 10,000. The code space is the control here; the limiter
-- is defence in depth (see 5).
--
-- Eight rather than signage's six (32^6, 30 bits) precisely because of
-- what the two codes buy. Six characters would still be adequate on
-- the numbers above, but the margin costs one extra beat when read
-- aloud and buys a factor of 1,024 in front of a credential that
-- writes to the attendee table.
--
--
-- 5. WHY A SECOND LIMITER, AND NOT checkin_kiosk_rate_check
--
-- Migration 055's limiter takes (event_id, device_id) and counts into
-- a table whose columns are NOT NULL foreign keys to real events and
-- real devices. A claim attempt has neither: an invalid pairing code
-- identifies no event, and no device exists yet by definition. Reusing
-- it would mean inventing sentinel UUIDs to satisfy two foreign keys,
-- and folding guess attempts into the same buckets that govern how
-- fast a legitimate lobby screen may register attendees. Different
-- question, different counter.
--
-- EVERY ATTEMPT IS CHARGED, SUCCESS OR FAILURE, and the limit is
-- sized around that. The tempting refinement is to charge only
-- failures, so legitimate pairing is never billed. It is rejected
-- because a limiter that decides after the fact is not a limiter: to
-- refund a success the charge has to be reversed after the claim has
-- already run, which means the claim always runs, which means the
-- attacker is never actually stopped. Charging first and blocking
-- first is the only ordering that denies anything.
--
-- THIRTY, because the bucket is shared by a whole venue. Every tablet
-- in a hotel lobby sits behind one NAT, so a congress provisioning
-- eight kiosks makes eight claims plus a handful of mistyped codes
-- from what the platform sees as a single address. Ten would turn a
-- large event's own provisioning into a lockout — the 07:00 failure
-- again, this time self-inflicted. Thirty sits roughly three times
-- above the worst plausible legitimate burst, and a tripped bucket
-- clears in ten minutes rather than needing an operator.
--
-- PER IP, AND DELIBERATELY NO GLOBAL BUCKET. The obvious second
-- bucket is a platform-wide cap, mirroring 055's per-event backstop.
-- It is not here on purpose. A global bucket on an unauthenticated
-- endpoint is a global lockout anybody can trigger: a few hundred junk
-- codes from one laptop, repeated cheaply, and no venue anywhere can
-- pair a kiosk. That is the 07:00 failure this whole migration exists
-- to prevent, handed to an attacker for the price of a shell loop.
-- Section 4 shows the code space already defeats online guessing by
-- six orders of magnitude, so the global bucket would be buying
-- almost no security with a very cheap denial of service. Availability
-- wins, and the reasoning is written down here so the trade is
-- re-argued rather than rediscovered.
--
-- The consequence is stated plainly: an attacker who can rotate source
-- addresses is not meaningfully rate limited. That is accepted. The
-- limiter's job is to stop one source hammering the database and to
-- keep a mistyped code from becoming a script, not to be the thing
-- standing between a stranger and a device key.
--
-- IP ADDRESSES ARE HASHED, NEVER STORED. An IP is personal data, and
-- this table is a counter, not a visitor log. The Edge Function
-- SHA-256s the address before it ever reaches the database, so a dump
-- of this table is a list of opaque digests with a twenty-minute
-- retention, and nothing here answers "who tried to pair".
--
--
-- 6. BURNING A CODE
--
-- checkin_kiosk_claim_pairing() below is a database function and not
-- a PostgREST update for two reasons.
--
-- Atomicity: two kiosks (or a kiosk and a thief) submitting the same
-- code at the same instant must not both receive a device key. A
-- single UPDATE with `WHERE claimed_at IS NULL` is atomic under
-- Postgres row locking — the loser re-evaluates the predicate against
-- the winner's committed row and updates zero rows. A read-then-write
-- from the Edge Function is not, for exactly the reason migration 055
-- gives about its own limiter.
--
-- Clock: expiry has to be judged against the DATABASE's now(), not
-- against whatever an Edge Function instance believes the time is.
--
-- The burn happens BEFORE the device row is created, and that ordering
-- is deliberate. If device creation then fails, the code is spent and
-- the volunteer mints another — one wasted click. The other ordering
-- fails the other way: a device row, and a live key, created against a
-- code that was never successfully burned.
--
-- Claimed rows are kept, not deleted. The row is the provenance record
-- for the device — which code produced this kiosk, when, and who
-- minted it. There is no prune here because mints are a human action a
-- few times per event; only leod_checkin_pair_attempts, which is
-- written at machine rate, needs one.
-- ============================================================

-- ── 1. Pairing codes ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leod_checkin_kiosk_pairing (
  code       TEXT        PRIMARY KEY,
  event_id   UUID        NOT NULL REFERENCES leod_events(id) ON DELETE CASCADE,
  -- The device label the organizer typed at mint time. It lives here
  -- rather than being sent by the kiosk so that the screen in the
  -- lobby cannot name itself — the label is how an organizer tells one
  -- kiosk from another when revoking a key.
  label      TEXT        NOT NULL,
  -- The slot pairing fills in, mirroring leod_signage_pairing.display_id.
  -- NULL until claimed. ON DELETE SET NULL so revoking a kiosk device
  -- never destroys the record that a pairing happened.
  device_id  UUID        REFERENCES leod_checkin_devices(id) ON DELETE SET NULL,
  created_by UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Set the instant the code is spent. This, not the presence of
  -- device_id, is what makes a code unreplayable: device_id is
  -- nullable and can be cleared by the FK above, claimed_at cannot.
  claimed_at TIMESTAMPTZ,
  -- The 32-symbol alphabet as a database invariant. I, O, 0 and 1 are
  -- absent because a code that is read aloud must not contain a pair
  -- that sounds or looks alike.
  CONSTRAINT leod_checkin_kiosk_pairing_code_check
    CHECK (code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$')
);

CREATE INDEX IF NOT EXISTS idx_checkin_kiosk_pairing_event
  ON leod_checkin_kiosk_pairing (event_id, created_at DESC);

ALTER TABLE leod_checkin_kiosk_pairing ENABLE ROW LEVEL SECURITY;

-- No policy is created, and that is the point — see section 2. RLS
-- enabled with zero policies denies everything to anon and
-- authenticated. Listed here so a future reader does not "fix" the
-- missing policy.
DROP POLICY IF EXISTS checkin_kiosk_pairing_read  ON leod_checkin_kiosk_pairing;
DROP POLICY IF EXISTS checkin_kiosk_pairing_write ON leod_checkin_kiosk_pairing;

REVOKE ALL ON TABLE leod_checkin_kiosk_pairing FROM anon, authenticated;


-- ── 2. Claim limiter ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS leod_checkin_pair_attempts (
  id           BIGSERIAL   PRIMARY KEY,
  -- SHA-256 hex of the source address, never the address. See section 5.
  ip_hash      TEXT        NOT NULL,
  attempted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_checkin_pair_attempts_ip
  ON leod_checkin_pair_attempts (ip_hash, attempted_at DESC);

ALTER TABLE leod_checkin_pair_attempts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkin_pair_attempts_read  ON leod_checkin_pair_attempts;
DROP POLICY IF EXISTS checkin_pair_attempts_write ON leod_checkin_pair_attempts;

REVOKE ALL ON TABLE leod_checkin_pair_attempts FROM anon, authenticated;
REVOKE ALL ON SEQUENCE leod_checkin_pair_attempts_id_seq FROM anon, authenticated;

-- Returns TRUE if this source was still under its budget and the
-- attempt has been counted; FALSE if it was already over. Called
-- BEFORE the claim is attempted, so a source over budget never
-- reaches checkin_kiosk_claim_pairing() at all.
--
-- Same atomicity argument as migration 055's limiter: check and
-- increment must be one transaction or parallel requests all read the
-- same stale count and all pass. The advisory lock is keyed on the
-- ip_hash, so contention is scoped to a single source rather than
-- serialising every failed claim on the platform.
CREATE OR REPLACE FUNCTION public.checkin_kiosk_pair_rate_check(
  p_ip_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c_window    CONSTANT INTERVAL := INTERVAL '10 minutes';
  c_limit     CONSTANT INT      := 30;
  -- Must stay >= c_window, or the prune deletes rows that are still
  -- being counted and the limiter quietly stops working.
  c_retention CONSTANT INTERVAL := INTERVAL '20 minutes';
  v_count INT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('checkin_kiosk_pair_rate:' || p_ip_hash, 0));

  DELETE FROM leod_checkin_pair_attempts
   WHERE attempted_at < now() - c_retention;

  SELECT count(*) INTO v_count
    FROM leod_checkin_pair_attempts
   WHERE ip_hash = p_ip_hash
     AND attempted_at > now() - c_window;

  -- An attempt that is already over budget writes NOTHING, exactly as
  -- in migration 055's limiter and for the same two reasons. A
  -- sustained attack cannot inflate this table without bound, and the
  -- bucket drains on schedule instead of extending itself into a
  -- lockout that lasts as long as someone keeps knocking — which
  -- matters most here, because a venue NAT means the source being
  -- punished may be shared with the very kiosks trying to pair.
  IF v_count >= c_limit THEN
    RETURN false;
  END IF;

  INSERT INTO leod_checkin_pair_attempts (ip_hash) VALUES (p_ip_hash);

  RETURN true;
END;
$function$;

REVOKE ALL ON FUNCTION public.checkin_kiosk_pair_rate_check(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_kiosk_pair_rate_check(TEXT) TO service_role;


-- ── 3. Atomic claim ───────────────────────────────────────────────

-- Burns the code and returns what the caller needs to build the
-- device row. Returns zero rows for every failure — no such code,
-- expired, already claimed — because the caller answers all three with
-- one message anyway, and a function that distinguished them would be
-- an oracle for which guesses were close.
--
-- device_id is NOT set here: the device does not exist yet, and it
-- must not, until the code is provably spent. checkin-kiosk-pair
-- attaches it in a follow-up update once the insert succeeds.
CREATE OR REPLACE FUNCTION public.checkin_kiosk_claim_pairing(
  p_code TEXT
)
RETURNS TABLE (event_id UUID, label TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  UPDATE leod_checkin_kiosk_pairing p
     SET claimed_at = now()
   WHERE p.code = p_code
     AND p.claimed_at IS NULL
     AND p.expires_at > now()
  RETURNING p.event_id, p.label
$function$;

REVOKE ALL ON FUNCTION public.checkin_kiosk_claim_pairing(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkin_kiosk_claim_pairing(TEXT) TO service_role;
