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
//
// A registration answers exactly one of:
//   { status: 'ok' }                         live: "check your email"
//   { status: 'ok', test: true, code: 'B4K2C7' }   test mode, new guest
//   { status: 'ok', test: true }             test mode, already listed
//   { status: 'full' | 'closed' | 'test_cap' }
// "Already registered" is indistinguishable from "registered" in live mode:
// both say check your email, and the QR goes to the address ON FILE.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendQrEmailsForAttendees } from '../_shared/qr-email.ts'
import { isWindowClosed } from '../_shared/checkin-policy.ts'
import {
  isRegistrationCode, validateRegistration, shortCode, mayResend, type Question,
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

function clientIp(req: Request): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown'
}

async function turnstileOk(secret: string, token: string, ip: string): Promise<boolean> {
  if (!token || token.length > 4096) return false
  try {
    const form = new FormData()
    form.append('secret', secret)
    form.append('response', token)
    if (ip !== 'unknown') form.append('remoteip', ip)
    const r = await fetch(TURNSTILE_VERIFY, { method: 'POST', body: form })
    const j = await r.json()
    return j?.success === true && ALLOWED_HOSTS.has(String(j.hostname ?? ''))
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
  if (body._ping) return json({ pong: true })

  const code = body.code
  // One answer for a malformed code, an unknown code and a disabled page.
  if (!isRegistrationCode(code)) return json({ error: 'not_found' }, 404)

  const sb = adminClient()
  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('event_id, status, checkin_core, registration_enabled, registration_capacity, registration_closes_at, registration_questions')
    .eq('registration_code', code).maybeSingle()
  if (entErr) {
    console.error('checkin-register: entitlement read failed', entErr.code)
    return json({ error: 'Registration is not available right now' }, 503)
  }
  if (!ent || !ent.registration_enabled || !ent.checkin_core) return json({ error: 'not_found' }, 404)

  const { data: event, error: evErr } = await sb.from('leod_events')
    .select('name, date, venue, timezone').eq('id', ent.event_id).single()
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
    let state: 'open' | 'closed' | 'full' = 'open'
    const closeAt = ent.registration_closes_at ? Date.parse(ent.registration_closes_at) : NaN
    if (!Number.isNaN(closeAt) && Date.now() >= closeAt) state = 'closed'
    // Guarded like the SQL: an event without a date or timezone has no window to close.
    if (event.date && event.timezone && isWindowClosed(event.date, event.timezone)) state = 'closed'
    if (state === 'open' && ent.registration_capacity) {
      const { count, error } = await sb.from('leod_checkin_attendees')
        .select('id', { count: 'exact', head: true }).eq('event_id', ent.event_id).eq('is_test', test)
      if (!error && (count ?? 0) >= ent.registration_capacity) state = 'full'
    }
    return json({
      state, test,
      event: { name: event.name, date: event.date, venue: event.venue, timezone: event.timezone },
      questions: questions.map(q => ({ id: q.id, label: q.label, type: q.type, required: q.required, options: q.options })),
      turnstile_site_key: TURNSTILE_SITE_KEY,
    })
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
    return json(test ? { status: 'ok', test: true } : { status: 'ok' })
  }

  const ip = clientIp(req)
  if (!(await turnstileOk(secret, str(body.turnstile_token), ip))) {
    return json({ error: 'Please complete the check that you are not a robot, then try again.', code: 'captcha' }, 400)
  }

  const ipHash = await hmacHex(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'cuedeck', 'checkin-web:' + ip)
  const { data: allowed, error: rateErr } = await sb.rpc('checkin_web_rate_check', { p_event_id: ent.event_id, p_ip_hash: ipHash })
  if (rateErr || allowed !== true) {
    if (rateErr) console.error('checkin-register: rate check failed', rateErr.code)
    return json({ error: 'Too many registrations from this connection just now. Please try again in a few minutes.' }, 429)
  }

  const { data: out, error: regErr } = await sb.rpc('checkin_web_register', {
    p_code: code, p_first_name: form.first_name, p_last_name: form.last_name,
    p_email: form.email, p_company: form.company, p_answers: answers,
  })
  if (regErr || !out) {
    // Code only: the message of a constraint error can carry the address.
    console.error('checkin-register: register failed', regErr?.code ?? 'no result')
    return json({ error: 'Registration failed. Please try again.' }, 500)
  }

  const status = String(out.status)
  if (status === 'full' || status === 'closed' || status === 'test_cap') return json({ status })
  if (status === 'not_found') return json({ error: 'not_found' }, 404)

  const attendee = out.attendee as { id: string; first_name: string; email: string; qr_token: string; qr_email_sent_at: string | null } | null
  const ev = { name: event.name, date: event.date, venue: event.venue }

  if (status === 'registered' && attendee) {
    if (!test) {
      const res = await sendQrEmailsForAttendees(sb, ev, [attendee])
      if (res.some(r => r.status === 'error')) console.error('checkin-register: QR email failed, attendee', attendee.id)
    }
    console.log('checkin-register: registered, event', ent.event_id, test ? '(test)' : '')
    await pad()
    // No email in test mode (test mode is not free QR delivery), so the
    // organizer trying the page sees the code on screen instead.
    return json(test ? { status: 'ok', test: true, code: shortCode(attendee.qr_token) } : { status: 'ok' })
  }

  // duplicate: re-send to the address on file, at most once per 10 minutes.
  if (!test && attendee && mayResend(attendee.qr_email_sent_at, Date.now())) {
    const res = await sendQrEmailsForAttendees(sb, ev, [attendee])
    if (res.some(r => r.status === 'error')) console.error('checkin-register: QR re-send failed, attendee', attendee.id)
  }
  console.log('checkin-register: already registered, event', ent.event_id)
  await pad()
  return json(test ? { status: 'ok', test: true } : { status: 'ok' })
})
