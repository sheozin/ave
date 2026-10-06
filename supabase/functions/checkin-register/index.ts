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
//   confirm  -> { status: 'registered', first_name }    (also for 'already')
//               { status: 'invalid' | 'full' | 'closed' }

import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendQrEmailsForAttendees } from '../_shared/qr-email.ts'
import { sendConfirmEmail } from '../_shared/registration-confirm-email.ts'
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

// The client IP as the platform saw it. The LEFT-most X-Forwarded-For entry
// is whatever the client sent (Cloudflare appends, it does not replace), so
// it is never used: cf-connecting-ip first, else the right-most entry.
// Null when neither exists, and the caller refuses rather than pooling
// everyone into one bucket.
function clientIp(req: Request): string | null {
  const cf = (req.headers.get('cf-connecting-ip') ?? '').trim()
  if (cf) return cf
  const parts = (req.headers.get('x-forwarded-for') ?? '').split(',').map(x => x.trim()).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : null
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
    // TEMPORARY (2026-10-06): which IP headers this platform sets, as
    // booleans only, to confirm clientIp() reads the right one. Remove once
    // verified.
    {
      const xff = (req.headers.get('x-forwarded-for') ?? '').split(',').map(x => x.trim()).filter(Boolean)
      const cf = req.headers.get('cf-connecting-ip')
      console.log('checkin-register: ip headers', JSON.stringify({ cf: !!cf, xff_n: xff.length, cf_is_last: !!cf && cf === xff[xff.length - 1], cf_is_first: !!cf && cf === xff[0], x_real: !!req.headers.get('x-real-ip') }))
    }
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

  // ── confirm ─────────────────────────────────────────────────────
  // The caller holds the token from the emailed link, so is the address
  // owner. No Turnstile: the token is 256 bits and single use.
  if (body.action === 'confirm') {
    const token = typeof body.token === 'string' ? body.token : ''
    if (!TOKEN_SHAPE.test(token)) return json({ status: 'invalid' })
    const { data: out, error } = await sb.rpc('checkin_web_confirm', { p_code: code, p_token_hash: await sha256Hex(token) })
    if (error || !out) {
      console.error('checkin-register: confirm failed', error?.code ?? 'no result')
      return json({ error: 'Something went wrong. Please try the link again.' }, 500)
    }
    const status = String(out.status)
    if (status === 'not_found') return json({ error: 'not_found' }, 404)
    if (status !== 'registered' && status !== 'already') return json({ status })
    const attendee = out.attendee as { id: string; first_name: string; email: string; qr_token: string; qr_email_sent_at: string | null } | null
    // 'already': the owner of an address already on the list gets their QR
    // again, at most every 10 minutes.
    if (attendee && (status === 'registered' || mayResend(attendee.qr_email_sent_at, Date.now()))) {
      const res = await sendQrEmailsForAttendees(sb, { name: event.name, date: event.date, venue: event.venue }, [attendee])
      if (res.some(r => r.status === 'error')) console.error('checkin-register: QR email failed, attendee', attendee.id)
    }
    console.log('checkin-register: confirmed (' + status + '), event', ent.event_id)
    return json({ status: 'registered', first_name: String(out.first_name ?? '') })
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

  const ip = clientIp(req)
  if (!ip) {
    console.error('checkin-register: no client IP header; refusing')
    return json({ error: 'Registration is not available right now' }, 503)
  }
  if (!(await turnstileOk(secret, str(body.turnstile_token), ip))) {
    return json({ error: 'Please complete the check that you are not a robot, then try again.', code: 'captcha' }, 400)
  }

  const ipHash = await hmacHex(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? 'cuedeck', 'checkin-web:' + ip)
  const { data: allowed, error: rateErr } = await sb.rpc('checkin_web_rate_check', { p_event_id: ent.event_id, p_ip_hash: ipHash })
  if (rateErr || allowed !== true) {
    if (rateErr) console.error('checkin-register: rate check failed', rateErr.code)
    return json({ error: 'Too many registrations from this connection just now. Please try again in a few minutes.' }, 429)
  }

  const raw = crypto.getRandomValues(new Uint8Array(32))
  const token = b64url(raw)
  const { data: out, error: regErr } = await sb.rpc('checkin_web_request', {
    p_code: code, p_first_name: form.first_name, p_last_name: form.last_name,
    p_email: form.email, p_company: form.company, p_answers: answers, p_token_hash: await sha256Hex(token),
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
    console.log('checkin-register: test registration (' + status + '), event', ent.event_id)
    return json(status === 'registered' ? { status: 'ok', test: true, code: shortCode(String(out.qr_token)) } : { status: 'ok', test: true })
  }

  if (out.send === true) {
    const link = 'https://app.cuedeck.io/r/' + code + '?t=' + token
    const sending = sendConfirmEmail(form.email.trim(), { name: event.name, date: event.date, venue: event.venue }, link)
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
