// supabase/functions/checkin-register/index.ts
// The public registration page (app.cuedeck.io/r/<code>). Spec:
// docs/superpowers/specs/2026-10-06-checkin-public-registration-design.md
//
// THE CALLER IS ANYONE ON THE INTERNET. It holds no session and no device
// key; the registration code in the link is the only thing that names the
// event. Deployed with --no-verify-jwt; the Authorization header carries the
// publishable key and is never read.
//
//   POST { action: 'config', code }    -> what the page needs to render
//   POST { action: 'register', code, first_name, last_name, email, company,
//          answers, consent, turnstile_token, website }
//   POST { action: 'confirm', code, token }   the link from the email
//
// DOUBLE OPT-IN (migration 101, after the security review of 100). A live
// registration answers { status: 'check_email' } for every address, new,
// pending or already listed, and the only email it can cause is the
// fixed-text confirmation in _shared/registration-confirm-email.ts. The
// guest joins the list, and gets the QR, when the address owner confirms.
//   register -> { status: 'check_email' }               live, always
//               { status: 'ok', test: true, code? }     test mode, no email
//               { status: 'full' | 'closed' | 'test_cap' }
//   preview  -> { status: 'ok', first_name, last_name, company } | { status: 'invalid' }
//   confirm  -> { status: 'registered', first_name }    (also for 'already')
//               { status: 'invalid' | 'full' | 'closed' }
// Test mode answers { status: 'ok', test: true } for a new and a listed
// address alike (102): no code, no email.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendQrEmailsForAttendees, withBrand } from '../_shared/qr-email.ts'
import { sendConfirmEmail } from '../_shared/registration-confirm-email.ts'
import { isWindowClosed, zonedTimeUtc } from '../_shared/checkin-policy.ts'
import qrcode from 'https://esm.sh/qrcode-generator@1.4.4'
import {
  isRegistrationCode, validateRegistration, mayResend, cleanText, clientKey, type Question,
} from '../_shared/checkin-register.ts'

const TURNSTILE_VERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
// Same widget as CueDeck sign-in (cuedeck-auth.js). Public by design.
const TURNSTILE_SITE_KEY = '0x4AAAAAAFNjmmDszwstOkPo'
const ALLOWED_HOSTS = new Set(['app.cuedeck.io'])

// Both "ok" branches answer no sooner than this, so response time does not
// tell a new registration from an address already on the list. Same
// reasoning and value as checkin-self-register.
const MIN_RESPONSE_MS = 1200

async function hmacHex(key: string, input: string): Promise<string> {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(input))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// The client IP as Cloudflare saw it. Verified on this platform 2026-10-06:
// cf-connecting-ip is always set, equals the client, and cannot be forged
// (Cloudflare rejects a request that sends it). X-Forwarded-For is not used:
// its right-most entries are proxies, so taking one would pool every guest
// into one bucket. Null when absent, and the caller refuses.
//
function clientIp(req: Request): string | null {
  return clientKey(req.headers.get('cf-connecting-ip') ?? '')
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

async function turnstileOk(secret: string, token: string, ip: string): Promise<boolean> {
  if (!token || token.length > 4096) return false
  try {
    const form = new FormData()
    form.append('secret', secret)
    form.append('response', token)
    form.append('remoteip', ip)
    const r = await fetch(TURNSTILE_VERIFY, { method: 'POST', body: form })
    const j = await r.json()
    // action binds the token to this form: a token minted by the sign-in
    // widget (same site key) is not accepted here.
    return j?.success === true && ALLOWED_HOSTS.has(String(j.hostname ?? '')) && j.action === 'register'
  } catch (e) {
    console.error('checkin-register: turnstile verify failed', (e as Error).message)
    return false
  }
}

function questionsOf(raw: unknown): Question[] {
  return Array.isArray(raw) ? raw as Question[] : []
}

Deno.serve(async (req) => {
  const startedAt = Date.now()
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, 'Content-Type': 'application/json' },
  })
  const pad = async () => {
    const left = MIN_RESPONSE_MS - (Date.now() - startedAt)
    if (left > 0) await new Promise(r => setTimeout(r, left))
  }

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Bad request' }, 400)
  if (body._ping) return json({ pong: true })

  const code = body.code
  // One answer for a malformed code, an unknown code and a disabled page.
  if (!isRegistrationCode(code)) return json({ error: 'not_found' }, 404)

  const sb = adminClient()
  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('event_id, status, checkin_core, registration_enabled, registration_capacity, registration_closes_at, registration_questions, registration_waitlist, registration_approval, registration_host_name, registration_description, registration_address, registration_brand_color, registration_cover_path, registration_logo_path, registration_show_programme')
    .eq('registration_code', code).maybeSingle()
  if (entErr) {
    console.error('checkin-register: entitlement read failed', entErr.code)
    return json({ error: 'Registration is not available right now' }, 503)
  }
  if (!ent || !ent.registration_enabled || !ent.checkin_core) return json({ error: 'not_found' }, 404)

  const { data: event, error: evErr } = await sb.from('leod_events')
    .select('name, date, venue, timezone, event_start, event_end, brand_color').eq('id', ent.event_id).single()
  if (evErr || !event) {
    console.error('checkin-register: event read failed', evErr?.code)
    return json({ error: 'Registration is not available right now' }, 503)
  }
  const questions = questionsOf(ent.registration_questions)
  const test = ent.status !== 'live'

  // ── config ──────────────────────────────────────────────────────
  if (body.action === 'config') {
    // The same closing rules checkin_web_register applies; the database is
    // the authority at submit time, this is so the page can say so first.
    let state: 'open' | 'closed' | 'full' | 'waitlist' = 'open'
    const closeAt = ent.registration_closes_at ? Date.parse(ent.registration_closes_at) : NaN
    if (!Number.isNaN(closeAt) && Date.now() >= closeAt) state = 'closed'
    // Guarded like the SQL: an event without a date or timezone has no window to close.
    if (event.date && event.timezone && isWindowClosed(event.date, event.timezone)) state = 'closed'
    let placesLeft: number | null = null
    if (ent.registration_capacity) {
      const { count, error } = await sb.from('leod_checkin_attendees')
        .select('id', { count: 'exact', head: true }).eq('event_id', ent.event_id).eq('is_test', test)
      if (!error) {
        placesLeft = Math.max(0, ent.registration_capacity - (count ?? 0))
        // (108) Full with a waitlist: the page offers the waitlist instead.
        if (state === 'open' && placesLeft === 0) state = ent.registration_waitlist ? 'waitlist' : 'full'
      }
    }
    // The page's design (migration 104). Only the brand colour falls back
    // to the event's own branding.
    const hex = (c: unknown) => typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c) ? c : null
    const pub = (path: string | null) => path ? Deno.env.get('SUPABASE_URL') + '/storage/v1/object/public/checkin-public/' + path : null
    const hhmm = (t: unknown) => typeof t === 'string' ? t.slice(0, 5) : null
    const start = event.date && event.timezone && hhmm(event.event_start) ? zonedTimeUtc(event.date, hhmm(event.event_start)!, event.timezone) : null
    const end = event.date && event.timezone && hhmm(event.event_end) ? zonedTimeUtc(event.date, hhmm(event.event_end)!, event.timezone) : null
    // The programme: only when the organizer turned it on, from the live run
    // of show (scheduled times follow delays), cancelled sessions left out.
    let programme: { time: string | null; title: string; room: string | null; speaker: string | null }[] = []
    if (ent.registration_show_programme) {
      const { data: rows, error } = await sb.from('leod_sessions')
        .select('title, room, speaker, scheduled_start, planned_start, status')
        .eq('event_id', ent.event_id).neq('status', 'CANCELLED').order('sort_order').limit(60)
      if (error) console.error('checkin-register: programme read failed', error.code)
      programme = (rows ?? []).map(r => ({ time: hhmm(r.scheduled_start ?? r.planned_start), title: r.title, room: r.room ?? null, speaker: r.speaker ?? null }))
    }
    return json({
      state, test, places_left: placesLeft, approval: !!ent.registration_approval,
      event: { name: event.name, date: event.date, venue: event.venue, timezone: event.timezone,
               start: hhmm(event.event_start), end: hhmm(event.event_end),
               start_utc: start?.toISOString() ?? null, end_utc: end?.toISOString() ?? null },
      page: {
        // Only what the organizer set for the page: the event's client_name is
        // internal (an agency's client) and is never published by default.
        host_name: ent.registration_host_name ?? null,
        description: ent.registration_description ?? null,
        address: ent.registration_address ?? null,
        brand_color: hex(ent.registration_brand_color) ?? hex(event.brand_color),
        cover_url: pub(ent.registration_cover_path), logo_url: pub(ent.registration_logo_path),
        programme,
      },
      questions: questions.map(q => ({ id: q.id, label: q.label, type: q.type, required: q.required, options: q.options })),
      turnstile_site_key: TURNSTILE_SITE_KEY,
    })
  }

  // Per (event, IP) budget shared by register, preview and confirm.
  const rateOk = async (): Promise<boolean | null> => {
    const ip = clientIp(req)
    if (!ip) { console.error('checkin-register: no client IP header; refusing'); return null }
    const ipHash = await hmacHex(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'cuedeck', 'checkin-web:' + ip)
    const { data, error } = await sb.rpc('checkin_web_rate_check', { p_event_id: ent.event_id, p_ip_hash: ipHash })
    if (error) console.error('checkin-register: rate check failed', error.code)
    return !error && data === true
  }
  // Preview, confirm and decline: their own per-IP budget with no event-wide
  // cap, so nobody can spend an event's register budget to block real
  // guests' links (the 256-bit token makes guessing pointless anyway).
  const tokenRateOk = async (): Promise<boolean | null> => {
    const ip = clientIp(req)
    if (!ip) { console.error('checkin-register: no client IP header; refusing'); return null }
    const ipHash = await hmacHex(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'cuedeck', 'checkin-web:' + ip)
    const { data, error } = await sb.rpc('checkin_web_token_rate_check', { p_ip_hash: ipHash })
    if (error) console.error('checkin-register: token rate check failed', error.code)
    return !error && data === true
  }
  const tooMany = () => json({ error: 'Too many attempts from this connection just now. Please try again in a few minutes.' }, 429)

  // ── preview ─────────────────────────────────────────────────────
  // The token holder (the address owner) sees what they are confirming, so
  // a request someone else overwrote is visible before it counts.
  if (body.action === 'preview') {
    const token = typeof body.token === 'string' ? body.token : ''
    if (!TOKEN_SHAPE.test(token)) return json({ status: 'invalid' })
    const ok = await tokenRateOk(); if (ok === null) return json({ error: 'Registration is not available right now' }, 503); if (!ok) return tooMany()
    const { data, error } = await sb.rpc('checkin_web_pending_preview', { p_code: code, p_token_hash: await sha256Hex(token) })
    if (error || !data) { console.error('checkin-register: preview failed', error?.code); return json({ status: 'invalid' }) }
    return json(data)
  }

  // ── decline: "This is not me" ───────────────────────────────────
  if (body.action === 'decline') {
    const token = typeof body.token === 'string' ? body.token : ''
    if (!TOKEN_SHAPE.test(token)) return json({ status: 'invalid' })
    const ok = await tokenRateOk(); if (ok === null) return json({ error: 'Registration is not available right now' }, 503); if (!ok) return tooMany()
    const { data, error } = await sb.rpc('checkin_web_decline', { p_code: code, p_token_hash: await sha256Hex(token) })
    if (error || !data) { console.error('checkin-register: decline failed', error?.code); return json({ error: 'Something went wrong. Please try again.' }, 500) }
    return json(data)
  }

  // ── confirm ─────────────────────────────────────────────────────
  // The caller holds the token from the emailed link, so is the address
  // owner. No Turnstile: the token is 256 bits and single use.
  if (body.action === 'confirm') {
    const token = typeof body.token === 'string' ? body.token : ''
    if (!TOKEN_SHAPE.test(token)) return json({ status: 'invalid' })
    const ok = await tokenRateOk(); if (ok === null) return json({ error: 'Registration is not available right now' }, 503); if (!ok) return tooMany()
    const { data: out, error } = await sb.rpc('checkin_web_confirm', { p_code: code, p_token_hash: await sha256Hex(token) })
    if (error || !out) {
      console.error('checkin-register: confirm failed', error?.code ?? 'no result')
      return json({ error: 'Something went wrong. Please try the link again.' }, 500)
    }
    const status = String(out.status)
    if (status === 'not_found') return json({ error: 'not_found' }, 404)
    // (108) Held on the waitlist or for approval: no ticket yet.
    if (status === 'waitlisted' || status === 'awaiting_approval') {
      console.log('checkin-register: confirmed into ' + status + ', event', ent.event_id)
      return json({ status, first_name: String(out.first_name ?? ''), position: typeof out.position === 'number' ? out.position : null })
    }
    if (status !== 'registered' && status !== 'already') return json({ status })
    const attendee = out.attendee as { id: string; first_name: string; email: string; qr_token: string; qr_email_sent_at: string | null } | null
    // 'already': the owner of an address already on the list gets their QR
    // again, at most every 10 minutes.
    if (attendee && (status === 'registered' || mayResend(attendee.qr_email_sent_at, Date.now()))) {
      const res = await sendQrEmailsForAttendees(sb, await withBrand(sb, ent.event_id, { name: event.name, date: event.date, venue: event.venue }), [attendee])
      if (res.some(r => r.status === 'error')) console.error('checkin-register: QR email failed, attendee', attendee.id)
    }
    console.log('checkin-register: confirmed (' + status + '), event', ent.event_id)
    // The ticket, shown to the token holder (the address owner) only.
    let ticket = null
    if (attendee) {
      const { data: a } = await sb.from('leod_checkin_attendees')
        .select('first_name, last_name, ticket_type, qr_token').eq('id', attendee.id).single()
      if (a) {
        const qr = qrcode(0, 'M'); qr.addData(a.qr_token); qr.make()
        ticket = {
          first_name: a.first_name, last_name: a.last_name, ticket_type: a.ticket_type,
          code: a.qr_token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase(),
          qr_svg: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(qr.createSvgTag({ cellSize: 8, margin: 0, scalable: true })),
        }
      }
    }
    return json({ status: 'registered', first_name: String(out.first_name ?? ''), ticket })
  }

  if (body.action !== 'register') return json({ error: 'Bad request' }, 400)

  // ── register ────────────────────────────────────────────────────
  // Fails closed: without the secret nothing can be verified, so nothing
  // is accepted.
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY')
  if (!secret) {
    console.error('checkin-register: TURNSTILE_SECRET_KEY is not set; refusing registrations')
    return json({ error: 'Registration is not available right now' }, 503)
  }

  const str = (v: unknown) => typeof v === 'string' ? v : ''
  const form = {
    first_name: str(body.first_name), last_name: str(body.last_name), email: str(body.email),
    company: str(body.company),
    answers: (body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)) ? body.answers as Record<string, unknown> : {},
    consent: body.consent === true,
  }
  const { errors, answers } = validateRegistration(form, questions)
  if (errors.length) return json({ error: 'Invalid submission', fields: errors }, 400)

  // Honeypot: a field people never see. Bots that fill it get the normal
  // answer and nothing is written or sent.
  if (str(body.website).trim()) {
    console.warn('checkin-register: honeypot filled, event', ent.event_id)
    await pad()
    return json(test ? { status: 'ok', test: true } : { status: 'check_email' })
  }

  const ip = (req.headers.get('cf-connecting-ip') ?? '').trim()
  if (!ip) {
    console.error('checkin-register: no client IP header; refusing')
    return json({ error: 'Registration is not available right now' }, 503)
  }
  if (!(await turnstileOk(secret, str(body.turnstile_token), ip))) {
    return json({ error: 'Please complete the check that you are not a robot, then try again.', code: 'captcha' }, 400)
  }
  const ok = await rateOk()
  if (ok === null) return json({ error: 'Registration is not available right now' }, 503)
  if (!ok) return tooMany()

  const raw = crypto.getRandomValues(new Uint8Array(32))
  const token = b64url(raw)
  const { data: out, error: regErr } = await sb.rpc('checkin_web_request', {
    p_code: code, p_first_name: cleanText(form.first_name), p_last_name: cleanText(form.last_name),
    p_email: form.email.trim(), p_company: cleanText(form.company), p_answers: answers, p_token_hash: await sha256Hex(token),
  })
  if (regErr || !out) {
    // Code only: the message of a constraint error can carry the address.
    console.error('checkin-register: request failed', regErr?.code ?? 'no result')
    return json({ error: 'Registration failed. Please try again.' }, 500)
  }

  const status = String(out.status)
  if (status === 'full' || status === 'closed' || status === 'test_cap') return json({ status })
  if (status === 'not_found') return json({ error: 'not_found' }, 404)

  if (test) {
    // Test mode: immediate, never any email (test mode is not free email
    // delivery). A new guest sees their code on screen.
    // One answer for a new and an already listed address (security review of 101).
    console.log('checkin-register: test registration (' + status + '), event', ent.event_id)
    await pad()
    const held = status === 'waitlisted' ? 'waitlist' : status === 'awaiting_approval' ? 'approval' : null
    return json(held ? { status: 'ok', test: true, held } : { status: 'ok', test: true })
  }

  if (out.send === true) {
    // Token in the fragment: browsers never send it to a server, so it stays
    // out of request logs and click-tracking redirects.
    const link = 'https://app.cuedeck.io/r/' + code + '#t=' + token
    const tokenHash = await sha256Hex(token)
    // A refused send gives the guest's budget back (103, F7).
    const sending = sendConfirmEmail(form.email.trim(), { name: event.name, date: event.date, venue: event.venue }, link)
      .then(async (sent) => {
        if (sent) return
        const { error } = await sb.rpc('checkin_web_send_failed', { p_code: code, p_token_hash: tokenHash })
        if (error) console.error('checkin-register: send_failed refund failed', error.code)
      })
    // After the response where the runtime allows it, so how long the mail
    // provider takes is not visible in the answer.
    const rt = (globalThis as { EdgeRuntime?: { waitUntil(p: Promise<unknown>): void } }).EdgeRuntime
    if (rt) rt.waitUntil(sending); else await sending
  }
  console.log('checkin-register: confirmation ' + (out.send === true ? 'sent' : 'not sent (throttled)') + ', event', ent.event_id)
  // The same answer, after the same floor, whether a mail went or not.
  await pad()
  return json({ status: 'check_email' })
})
