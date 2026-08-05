// supabase/functions/checkin-kiosk-pair/index.ts
// Provisioning for the self-registration kiosk. See migration
// 056_checkin_kiosk_pairing.sql, whose header carries the full
// reasoning for the table, the expiry, the code space and the limiter.
//
// This function exists because checkin-self-register authenticates a
// lobby tablet with a device key hashed into
// leod_checkin_devices.api_key_hash, and until now nothing could
// create one. The manual alternative — generate a key in a terminal,
// SHA-256 it by hand, INSERT the row, then get the raw value onto a
// tablet — is not something a volunteer does at 07:00 in a hotel.
//
// TWO OPERATIONS, ONE FUNCTION. They could have been split, and the
// argument for splitting is real: mint requires a JWT and claim must
// not, so one handler holds both an authenticated and an
// unauthenticated path. It is one function anyway because the two
// halves share the code alphabet, the expiry, and the exact meaning of
// "burned", and those three things drifting apart across two files is
// a worse failure than the one splitting would prevent. The auth
// asymmetry is contained by dispatching on `action` once, at the top,
// into branches that share no code and that each establish their own
// caller identity from nothing — there is no path that reaches the
// mint branch without a validated organizer JWT. `manage-operator` and
// `admin-manage-user` already dispatch this way in this codebase.
//
//   MINT  (organizer, Authorization: Bearer <user JWT>)
//     { action: 'mint', event_id, label }
//     -> { ok: true, code: 'ABCD-EFGH', expires_at }
//
//   CLAIM (kiosk, unauthenticated)
//     { action: 'claim', code: 'ABCD-EFGH' }
//     -> { ok: true, event_id, device_id, label, device_key }
//
// THE RAW DEVICE KEY IS RETURNED EXACTLY ONCE, by the claim branch,
// and exists nowhere else. Only its SHA-256 is stored, and
// checkin_dev_read (migration 048) lets crew SELECT device rows — so a
// raw key written to that table would be a kiosk credential readable
// by every crew member on the event. It is never logged either: the
// logs are the other place a secret leaks by accident.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'

// ── Pairing code ──────────────────────────────────────────────────
// The same 32-symbol alphabet cuedeck-display.html's
// generatePairingCode() uses: A-Z and 2-9 with I, O, 0 and 1 removed,
// because a code that is read aloud across a lobby must not contain a
// pair that sounds or looks alike. Migration 056 enforces it as a
// CHECK constraint, so a future edit here that widens the alphabet
// fails at the database rather than quietly shipping ambiguous codes.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

// 256 % 32 === 0, so a plain modulo over CSPRNG bytes is uniform — no
// rejection sampling needed. Getting this wrong would bias the code
// space, which is the entire security argument (32^8, see migration
// 056 section 4).
function generatePairingCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  let code = ''
  for (const b of bytes) code += ALPHABET[b % ALPHABET.length]
  return code
}

// Hyphenated for the human, stored bare. The kiosk sends back whatever
// the volunteer typed and normalizeCode() puts it back into storage
// form, so the display format is free to change without a migration.
function formatPairingCode(code: string): string {
  return code.slice(0, 4) + '-' + code.slice(4)
}

// Strip everything that is not a letter or digit, then uppercase. That
// covers the hyphen we printed, a space someone typed instead of it,
// and a stray trailing character from a tablet keyboard.
//
// Deliberately NO confusable-character remapping — no O to 0, no 1 to
// L. Those characters are absent from the alphabet precisely so they
// are never in a real code, and guessing what someone meant by an
// impossible character would silently expand the accepted space around
// every valid code.
function normalizeCode(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9]/g, '').toUpperCase()
}

// ── Device key ────────────────────────────────────────────────────
// 256 bits of CSPRNG output, hex. checkin-self-register's own header
// explains at length why the stored form is an unsalted SHA-256 rather
// than a salted KDF, and the short version is that verification there
// is a lookup on migration 048's UNIQUE index on api_key_hash — a
// per-row KDF cannot be looked up at all, only scanned, on a public
// unauthenticated endpoint. The property that makes it safe is this
// function: a full-entropy secret nobody chooses and nobody types.
function generateDeviceKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Byte-identical to checkin-self-register's sha256Hex. The two must
// agree or every key this function issues fails to authenticate.
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// Devices are named by a human and shown in a device list. 60 is past
// what anyone types for "Lobby kiosk 2" and short of what turns the
// list unreadable. Truncated rather than rejected: it is a display
// field, and failing a mint over a long label would be theatre.
const MAX_LABEL = 60

const PAIRING_TTL_MS = 10 * 60 * 1000

// The source address, for the claim limiter. Supabase sets
// x-forwarded-for at the edge; the first entry is the client. Hashed
// before it reaches the database (migration 056 section 5) so the
// counter table never holds an address.
//
// 'unknown' when the header is absent puts every header-less caller in
// one shared bucket, which is the conservative direction: it cannot
// lock out a real venue, because a real venue always arrives through
// the edge with the header set.
function sourceAddress(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  return xff?.split(',')[0]?.trim() || 'unknown'
}

Deno.serve(async (req) => {
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

  const action = String(body.action || '').trim()
  const sb = adminClient()

  // ════════════════════════════════════════════════════════════════
  // MINT — organizer, authenticated
  // ════════════════════════════════════════════════════════════════
  if (action === 'mint') {
    // Same JWT-then-role-then-entitlement sequence as
    // checkin-import-attendees, in that order, for the same reason:
    // the service-role client below bypasses RLS entirely, so
    // migration 051's entitlement gate inside checkin_role_for_event()
    // is never consulted and has to be re-checked by hand.
    const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
    if (!jwt) return json({ error: 'Unauthorized' }, 401)

    const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
    if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

    const event_id = String(body.event_id || '')
    const label = String(body.label || '').trim().slice(0, MAX_LABEL)
    if (!event_id || !label) {
      return json({ error: 'Missing event_id or label' }, 400)
    }

    const { data: opRow } = await sb.from('leod_checkin_operators')
      .select('role').eq('event_id', event_id).eq('user_id', user.id).single()
    if (opRow?.role !== 'organizer') {
      return json({ error: 'Forbidden — organizers only' }, 403)
    }

    // BOTH flags. checkin_core alone is not enough: self_registration
    // is the flag that says this event bought an unattended screen
    // (migration 053, default false), and a kiosk key issued without
    // it is a credential for an endpoint that will refuse every
    // request it makes. Unlike the claim branch, the caller here is a
    // named organizer looking at their own console, so the two
    // failures are worth telling apart.
    const { data: entRow } = await sb.from('leod_checkin_entitlements')
      .select('checkin_core, self_registration').eq('event_id', event_id).single()
    if (!entRow?.checkin_core) {
      return json({ error: 'Check-in is not enabled for this event' }, 403)
    }
    if (!entRow.self_registration) {
      return json({ error: 'Self-registration is not enabled for this event' }, 403)
    }

    // The code is the PRIMARY KEY over every row this table has ever
    // held, so a collision is a 23505 rather than a silent overwrite.
    // At 32^8 against a few hundred rows it will not happen; the retry
    // is here so that if it ever does, the organizer sees a working
    // button instead of an error nobody can reproduce.
    const expires_at = new Date(Date.now() + PAIRING_TTL_MS).toISOString()
    let code = ''
    let lastErr: { code?: string } | null = null
    for (let attempt = 0; attempt < 3; attempt++) {
      code = generatePairingCode()
      const { error } = await sb.from('leod_checkin_kiosk_pairing').insert({
        code, event_id, label, created_by: user.id, expires_at,
      })
      if (!error) { lastErr = null; break }
      lastErr = error
      if (error.code !== '23505') break
    }
    if (lastErr) {
      // Code only. Never the pairing code itself, and never the label.
      console.error('checkin-kiosk-pair: mint insert failed for event', event_id, lastErr.code)
      return json({ error: 'Could not create a pairing code' }, 500)
    }

    // No code, no label, no user id in the log line. The response body
    // is the only place the code appears.
    console.log('checkin-kiosk-pair: minted pairing code for event', event_id)
    return json({ ok: true, code: formatPairingCode(code), expires_at })
  }

  // ════════════════════════════════════════════════════════════════
  // CLAIM — kiosk, unauthenticated
  // ════════════════════════════════════════════════════════════════
  if (action === 'claim') {
    // Charged before anything is looked up, so a source over budget
    // never reaches the claim at all. Fails closed: a limiter that
    // opens when the database is unreachable is not a limiter.
    const ipHash = await sha256Hex(sourceAddress(req))
    const { data: allowed, error: rateErr } = await sb.rpc('checkin_kiosk_pair_rate_check', {
      p_ip_hash: ipHash,
    })
    if (rateErr || allowed !== true) {
      if (rateErr) console.error('checkin-kiosk-pair: rate check failed', rateErr.code)
      else console.warn('checkin-kiosk-pair: claim rate limited')
      return json({ error: 'Too many pairing attempts. Please wait a few minutes and try again.' }, 429)
    }

    const code = normalizeCode(String(body.code || ''))
    if (!code) return json({ error: 'Invalid or expired pairing code' }, 400)

    // Burns the code atomically and returns zero rows for every
    // failure — unknown, expired, already claimed. The burn happens
    // BEFORE the device exists, so a code cannot survive a partially
    // completed claim (migration 056 section 6).
    const { data: claimRows, error: claimErr } = await sb.rpc('checkin_kiosk_claim_pairing', {
      p_code: code,
    })
    if (claimErr) {
      console.error('checkin-kiosk-pair: claim rpc failed', claimErr.code)
      return json({ error: 'Pairing failed' }, 500)
    }

    const claimed = Array.isArray(claimRows) ? claimRows[0] : claimRows
    if (!claimed) {
      // One message for all three failures. Splitting them would tell
      // a guesser that a code exists but is expired, which is the
      // difference between searching the whole space and searching a
      // recently-used corner of it.
      console.warn('checkin-kiosk-pair: claim rejected')
      return json({ error: 'Invalid or expired pairing code' }, 400)
    }

    // Re-checked after the burn, not before. The code was minted while
    // both flags were on, but that was up to ten minutes ago, and
    // handing a device key to an event that has since lost the feature
    // creates a credential whose every request checkin-self-register
    // will refuse. Checked after so a revoked event still spends the
    // code rather than leaving it live.
    const { data: entRow } = await sb.from('leod_checkin_entitlements')
      .select('checkin_core, self_registration').eq('event_id', claimed.event_id).single()
    if (!entRow?.checkin_core || !entRow?.self_registration) {
      console.warn('checkin-kiosk-pair: claim for event without self-registration', claimed.event_id)
      return json({ error: 'Self-registration is not enabled for this event' }, 403)
    }

    const device_key = generateDeviceKey()
    const { data: device, error: devErr } = await sb.from('leod_checkin_devices')
      .insert({
        event_id: claimed.event_id,
        label: claimed.label,
        // Never 'checkin_station'. Migration 055's header explains why
        // the two kinds must stay separate: a kiosk key lives on a
        // public screen in a lobby, a station key drives the staffed
        // desk, and one kind would make each a credential for the
        // other. checkin-self-register requires kind === 'kiosk'.
        kind: 'kiosk',
        // Only the digest. The raw key below is returned once and
        // never written anywhere — see this file's header.
        api_key_hash: await sha256Hex(device_key),
      })
      .select('id')
      .single()

    if (devErr || !device) {
      // The code is already spent at this point and stays spent. That
      // is the safe direction: the volunteer mints another, which is
      // one click, and no code survives a failed claim to be replayed.
      console.error('checkin-kiosk-pair: device insert failed for event', claimed.event_id, devErr?.code ?? 'no row returned')
      return json({ error: 'Pairing failed' }, 500)
    }

    // Bookkeeping, after the fact and best-effort: the pairing row is
    // the provenance record for this device. Failing it must not fail
    // a pairing that has already succeeded — the device exists and its
    // key is about to be handed over exactly once, so there is no
    // second chance to deliver it.
    const { error: linkErr } = await sb.from('leod_checkin_kiosk_pairing')
      .update({ device_id: device.id }).eq('code', code)
    if (linkErr) {
      console.error('checkin-kiosk-pair: pairing link update failed, device', device.id, linkErr.code)
    }

    console.log('checkin-kiosk-pair: kiosk paired, device', device.id)
    return json({
      ok: true,
      event_id: claimed.event_id,
      device_id: device.id,
      label: claimed.label,
      // The only time this value is ever transmitted or exists outside
      // this request.
      device_key,
    })
  }

  return json({ error: 'Invalid action — must be mint or claim' }, 400)
})
