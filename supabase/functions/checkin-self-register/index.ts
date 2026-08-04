// supabase/functions/checkin-self-register/index.ts
// Self-registration for the unattended kiosk. See
// docs/superpowers/specs/2026-08-03-checkin-station-ui-design.md and
// tests/checkin-kiosk.spec.ts, which is the validation specification —
// the pure functions below are mirrored from it deliberately, not
// coincidentally.
//
// THE CALLER IS A PUBLIC TOUCH SCREEN. It holds no operator session,
// no user JWT and no RLS policy. Its only credential is a kiosk device
// key, which this function validates against
// leod_checkin_devices.api_key_hash. The Authorization header carries
// the publishable key because the platform wants a JWT there; it is
// NOT this function's idea of identity and is never read.
//
// Exactly two success bodies exist and nothing may be added to either:
//
//   { status: 'registered', code: 'B4K2C7' }
//   { status: 'already_registered' }
//
// The second one is why this function exists as a function rather than
// an anon INSERT policy. It is the answer to "is this address already
// on the list", which is a question an unattended screen must be able
// to answer usefully and must not be able to answer informatively. It
// returns no name, no id, no code, and no masked hint — a partially
// starred address still confirms the record. The code goes to the
// address ON FILE, which reaches the real owner; whoever is standing
// at the screen learns only that their typing was accepted.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendQrEmailsForAttendees } from '../_shared/qr-email.ts'

// ── Validation, mirrored from tests/checkin-kiosk.spec.ts ──────────
// The kiosk runs these too, as courtesy for the person typing. They
// are re-run here because everything a kiosk sends is
// attacker-controlled.

const MAX_NAME = 80

// A name must contain at least one LETTER in any script. \p{L} with
// the /u flag covers Latin, Latin-with-diacritics, Arabic and Cyrillic
// in one check. A naive /[a-z]/i would reject محمد and Иванов outright.
const HAS_LETTER = /\p{L}/u

// Deliberately loose: something@something.something with no spaces.
// Deliverability is proven by the code email arriving, not by a regex.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// NOT in the spec file, and the one place this function is stricter
// than the kiosk. EMAIL_SHAPE has no length bound, so a 10 kB string
// with an @ and a dot in it passes every client-side check and lands
// in the attendees table. 254 is the RFC 5321 maximum and no real
// address comes near it. Rejected rather than truncated: truncating an
// address changes which person it identifies. Task 12b should set
// maxlength="254" on the email input so the two never disagree in
// front of a real attendee.
const MAX_EMAIL = 254

// Also not in the spec file. Company has no validation rule there, so
// rejecting a long one would dead-end someone whose own screen told
// them it was fine. Truncated instead — it is a display field, and 80
// characters is already past what fits on badge stock. Task 12b should
// set maxlength="80" on the company input.
const MAX_COMPANY = 80

interface KioskForm {
  first_name: string
  last_name: string
  company: string
  email: string
  consent: boolean
}

function validateKiosk(f: KioskForm, emailRequired: boolean): string[] {
  const errors: string[] = []

  const first = f.first_name.trim()
  const last = f.last_name.trim()

  if (!first) errors.push('first_name')
  else if (first.length > MAX_NAME) errors.push('first_name_too_long')
  else if (!HAS_LETTER.test(first)) errors.push('first_name_invalid')

  if (!last) errors.push('last_name')
  else if (last.length > MAX_NAME) errors.push('last_name_too_long')
  else if (!HAS_LETTER.test(last)) errors.push('last_name_invalid')

  const email = f.email.trim()
  if (!email) {
    if (emailRequired) errors.push('email')
  } else if (!EMAIL_SHAPE.test(email) || email.length > MAX_EMAIL) {
    errors.push('email_format')
  }

  // GDPR. Always required, in both email modes, and the checkbox is
  // never pre-checked in the UI — a pre-ticked box is not consent.
  if (!f.consent) errors.push('consent')

  return errors
}

// Recognises the Postgres unique-violation raised by migration 050's
// partial index on (event_id, lower(email)). Must not fire on anything
// else: reporting a permission or connection failure as "already
// registered" would show a reassuring screen for a write that never
// landed, and the person would walk to the desk expecting a badge that
// does not exist.
//
// The only other unique constraint reachable from this insert is
// attendees.qr_token, whose value is a fresh UUID — a collision there
// is a 122-bit coincidence, and the cost of being wrong about it is
// one person being told to check their email.
function isDuplicateEmail(err: { code?: string; message?: string }): boolean {
  if (err.code === '23505') return true
  const m = (err.message ?? '').toLowerCase()
  return m.includes('duplicate key') || m.includes('unique constraint')
}

// The human-readable code shown on screen and read aloud at the desk.
// Non-alphanumerics are dropped first so punctuation never lands on a
// badge or in a spoken code; a short or letterless token yields a
// shorter string rather than throwing, since the caller is an
// unattended screen with nowhere to report an exception.
//
// SIX characters, not four. qr_token is a UUID with its dashes
// stripped, so the surviving alphabet is uppercase hex — 16 symbols.
// Four of those is 16^4 = 65,536 values, and by the birthday bound a
// 200-person walk-up queue has a 26% chance of two people being handed
// the same code. At the desk that is not a rare curiosity, it is one
// morning in four where two strangers read out the same four letters
// and the operator picks the wrong record. Six gives 16^6 = 16,777,216
// and drops the same collision to 0.12% at 200 and 2.9% at 1,000.
//
// NO confusable characters are excluded, and that is deliberate. This
// code is DERIVED from an existing token, not generated — the only
// available move is to drop characters, which would shrink the
// alphabet rather than reshape it. Excluding the one genuinely
// confusable pair in uppercase hex (8 and B) would leave 14 symbols,
// 14^6 = 7.5M, and make collisions more than twice as likely in
// exchange for a distinction people rarely mishear. The pairs that
// actually cause trouble when read aloud — 0/O, 1/I, 5/S — cannot
// occur here at all, because O, I and S are not hex digits. Contrast
// checkin-kiosk-pair, which GENERATES its code and therefore does pick
// an unambiguous alphabet.
function shortCode(token: string): string {
  return token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()
}

// Trim and lowercase, nothing else — the key migration 050 indexes.
// Deliberately NOT gmail-style: no dot stripping, no plus-tag
// stripping. anna+expo@x.com and anna@x.com are two registrations, and
// collapsing them hands one person's badge to whoever typed the other.
function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase()
}

function makeQrToken(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

// ── Device key ────────────────────────────────────────────────────
// SHA-256 of the raw key, hex, unsalted — and that is the right choice
// here rather than a concession.
//
// The stored hash is looked up through migration 048's UNIQUE index on
// api_key_hash, so verification is one indexed read regardless of how
// many devices exist. A per-row salted KDF (bcrypt/argon2) cannot be
// looked up at all: it forces a scan of every device row and a KDF
// evaluation against each, on a public unauthenticated endpoint. That
// turns the authentication step itself into the denial of service.
//
// The reason slow salted hashing exists is to make guessing a
// LOW-ENTROPY human-chosen password expensive. A kiosk key is 256 bits
// of CSPRNG output that a human never chooses and never types, so
// there is nothing to guess and no dictionary to run. SHA-256 over a
// full-entropy secret is not invertible by brute force.
//
// No constant-time comparison is needed because no comparison happens
// in this process: the equality test is an index lookup on a value
// that is already a hash. Leaking timing about a hash prefix is only
// useful to someone who can invert SHA-256.
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Response timing ───────────────────────────────────────────────
// The two success bodies name their own branch, so an attacker who can
// READ the response learns which one ran no matter what this function
// does about timing. That is accepted by the design (see the spec's
// "reveal nothing" section); the control against enumeration is the
// rate limit, not secrecy about the branch.
//
// The channel that timing actually closes is the one where the body is
// unreadable. A page on the venue wifi can fire a cross-origin POST at
// this function with a device key lifted off the lobby screen; the
// CORS allowlist in _shared/cors.ts stops it reading the response, but
// nothing stops it measuring how long the request took. Without a
// floor, "fast" versus "slow" reconstructs the branch the body was
// hiding, and the enumeration oracle is back through a side channel.
//
// So both success branches are padded to the same floor. They are
// already close in shape — each does one insert-or-lookup and one
// email send — and the floor absorbs the remainder. When an email send
// runs long the floor stops binding and the residual signal is the
// variance of the mail provider, which is large and has nothing to do
// with which branch ran.
//
// 1200 ms is not felt by someone who has just spent a minute typing
// their details, and it costs an attacker a further second per probe
// on top of the rate limit.
const MIN_RESPONSE_MS = 1200

async function padTo(startedAt: number): Promise<void> {
  const remaining = MIN_RESPONSE_MS - (Date.now() - startedAt)
  if (remaining > 0) await new Promise(r => setTimeout(r, remaining))
}

Deno.serve(async (req) => {
  const startedAt = Date.now()
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })

  let body: Record<string, unknown>
  try { body = await req.json() } catch {
    return json({ error: 'Bad request' }, 400)
  }

  if (body._ping) return json({ pong: true })

  const event_id   = String(body.event_id || '')
  const device_key = String(body.device_key || '')
  if (!event_id || !device_key) {
    return json({ error: 'Bad request' }, 400)
  }

  const sb = adminClient()

  // ── 1. Device key ───────────────────────────────────────────────
  // One response for all three failures — no such key, key belongs to
  // another event, key is a desk device rather than a kiosk. Splitting
  // them would let someone holding a desk key discover which events it
  // is good for.
  const { data: device } = await sb.from('leod_checkin_devices')
    .select('id, event_id, kind')
    .eq('api_key_hash', await sha256Hex(device_key))
    .maybeSingle()

  if (!device || device.event_id !== event_id || device.kind !== 'kiosk') {
    // No device id to log — by definition we do not have a valid one.
    console.warn('checkin-self-register: device key rejected for event', event_id)
    return json({ error: 'Unauthorized device' }, 401)
  }

  // ── 2. Entitlements ─────────────────────────────────────────────
  // The service-role client bypasses RLS entirely, so migration 051's
  // entitlement gate inside checkin_role_for_event() is never
  // consulted — the same explicit re-check every other check-in
  // function makes. Both flags produce one message: an unattended
  // screen has nobody to read a more precise one, and the distinction
  // is an organizer's billing state, not a stranger's business.
  const { data: entRow } = await sb.from('leod_checkin_entitlements')
    .select('checkin_core, self_registration').eq('event_id', event_id).single()
  if (!entRow?.checkin_core || !entRow?.self_registration) {
    console.warn('checkin-self-register: self-registration not enabled, device', device.id)
    return json({ error: 'Self-registration is not enabled for this event' }, 403)
  }

  // ── 3. Field validation ─────────────────────────────────────────
  // emailRequired is TRUE unconditionally in this build. The spec's
  // optional-email mode has no per-event flag behind it today, and
  // inventing one would be inventing a switch that silently disables
  // duplicate detection: with no email there is no collision key, so
  // the 'already_registered' branch — the whole basis of the "we
  // emailed the address on file" design — can never fire. Task 12b
  // must render the email field as required.
  //
  // consent is compared to true rather than coerced, so a truthy
  // string from a hand-rolled client is not consent.
  const form: KioskForm = {
    first_name: typeof body.first_name === 'string' ? body.first_name : '',
    last_name:  typeof body.last_name  === 'string' ? body.last_name  : '',
    company:    typeof body.company    === 'string' ? body.company    : '',
    email:      typeof body.email      === 'string' ? body.email      : '',
    consent:    body.consent === true,
  }

  const errors = validateKiosk(form, true)
  if (errors.length) {
    // The field codes are the caller's own input reflected back
    // structurally. They describe nobody else, so returning them leaks
    // nothing — and without them a client/server validation drift is a
    // silent dead end on a screen in a lobby at 7am.
    console.warn('checkin-self-register: validation rejected, device', device.id, errors.join(','))
    return json({ error: 'Invalid submission', fields: errors }, 400)
  }

  // ── 4. Rate limit ───────────────────────────────────────────────
  // Charged only once the submission is real: the device is known, the
  // event allows self-registration and the fields are valid. Both the
  // badge-printing DoS and the enumeration probe require exactly that,
  // so that is what the budget is spent on. One generic refusal covers
  // both the per-device and the per-event bucket.
  const { data: allowed, error: rateErr } = await sb.rpc('checkin_kiosk_rate_check', {
    p_event_id: event_id, p_device_id: device.id,
  })
  if (rateErr || allowed !== true) {
    if (rateErr) console.error('checkin-self-register: rate check failed, device', device.id, rateErr.code)
    else console.warn('checkin-self-register: rate limited, device', device.id)
    // Fails closed. A limiter that opens when the database is
    // unreachable is not a limiter.
    return json({ error: 'Too many registrations from this screen just now. Please see the desk.' }, 429)
  }

  // Best-effort liveness for the organizer: last_seen_at is otherwise
  // unused, and "is the lobby screen still alive" is a question worth
  // being able to answer. Never fails the registration.
  const { error: seenErr } = await sb.from('leod_checkin_devices')
    .update({ last_seen_at: new Date().toISOString() }).eq('id', device.id)
  if (seenErr) console.error('checkin-self-register: last_seen_at update failed, device', device.id, seenErr.code)

  // Fetched before the branch so both paths pay for it identically.
  const { data: event } = await sb.from('leod_events')
    .select('name, date, venue').eq('id', event_id).single()

  // Stored as typed (trimmed) for display; compared as lower(email),
  // which is the key migration 050's unique index is built on — the
  // database performs that comparison itself when the insert below
  // either succeeds or raises 23505.
  const typedEmail = form.email.trim()
  const company = form.company.trim().slice(0, MAX_COMPANY)

  const qr_token = makeQrToken()
  const { data: created, error: insErr } = await sb.from('leod_checkin_attendees')
    .insert({
      event_id,
      first_name: form.first_name.trim(),
      last_name:  form.last_name.trim(),
      email:      typedEmail || null,
      company:    company || null,
      qr_token,
      source:     'kiosk',
      consent_at: new Date().toISOString(),
    })
    .select('id, first_name, email, qr_token')
    .single()

  // ── 5a. Already registered ──────────────────────────────────────
  if (insErr && isDuplicateEmail(insErr)) {
    // The lookup runs through checkin_kiosk_lookup_by_email so the
    // match is on lower(email) exactly as the index is — an ILIKE
    // filter would treat '_' and '%' in a local part as wildcards and
    // could return a different person's row.
    const { data: rows, error: lookupErr } = await sb.rpc('checkin_kiosk_lookup_by_email', {
      p_event_id: event_id, p_email: normalizeEmail(typedEmail),
    })
    const existing = Array.isArray(rows) ? rows[0] : rows

    if (lookupErr) {
      console.error('checkin-self-register: collision lookup failed, device', device.id, lookupErr.code)
    } else if (existing && event) {
      // To the address ON FILE, never to what was typed. Those are the
      // same string in the ordinary case and different in exactly the
      // case this protects against: someone probing a colleague's
      // address at a public screen.
      const results = await sendQrEmailsForAttendees(sb, event, [existing])
      if (results.some(r => r.status === 'error')) {
        console.error('checkin-self-register: collision email failed, device', device.id)
      }
    }

    console.log('checkin-self-register: outcome already_registered, device', device.id)
    await padTo(startedAt)
    // Constructed inline, from nothing. No spread of a fetched row, no
    // conditional field, nothing that a later edit could widen without
    // noticing.
    return json({ status: 'already_registered' })
  }

  // ── 5b. Genuine failure ─────────────────────────────────────────
  if (insErr || !created) {
    // insErr.code ONLY. A Postgres unique-violation carries the
    // offending key in its details/message — logging the object would
    // put the submitted email address in the function logs, which is
    // the one thing this function must never write down.
    console.error('checkin-self-register: insert failed, device', device.id, insErr?.code ?? 'no row returned')
    return json({ error: 'Registration failed' }, 500)
  }

  // ── 5c. Registered ──────────────────────────────────────────────
  // The kiosk always emails the code, independent of
  // auto_send_qr_email — that flag governs CSV import, and the kiosk's
  // own design puts the durable copy in the inbox and the short code
  // on the screen for the walk to the desk. It also keeps the two
  // branches symmetrical: both send exactly one email.
  if (event && created.email) {
    const results = await sendQrEmailsForAttendees(sb, event, [created])
    if (results.some(r => r.status === 'error')) {
      console.error('checkin-self-register: registration email failed, device', device.id)
    }
  } else if (!event) {
    console.error('checkin-self-register: event fetch failed, code shown but not emailed, device', device.id)
  }

  console.log('checkin-self-register: outcome registered, device', device.id)
  await padTo(startedAt)
  return json({ status: 'registered', code: shortCode(created.qr_token) })
})
