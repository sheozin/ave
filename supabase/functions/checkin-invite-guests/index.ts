// supabase/functions/checkin-invite-guests/index.ts
// Personal invitations (migration 116). Owner and organizers only.
//
//   POST { event_id, action: 'send' }                    every guest on the
//        list not yet invited, in batches of BATCH; answers { sent, failed,
//        remaining } and the Event admin calls again while remaining > 0
//   POST { event_id, action: 'resend', attendee_ids }    a fresh link each,
//        replacing the old one
//   POST { event_id, action: 'test' }                    the caller gets the
//        invitation themselves, with a link that opens no real invitation
//
// Invitations go to guests only once the event is live: test mode never
// emails guests, as everywhere else in check-in. Only the organizer's own
// guests (source 'import') with an email are invited; checkin_web_invite_issue
// checks that again. The link carries its token in the fragment
// (/r/<code>#i=<token>), so it stays out of server logs.

import { adminClient } from '../_shared/client.ts'
import { corsHeaders }  from '../_shared/cors.ts'
import { sendEmail }    from '../_shared/resend.ts'
import { withBrand, escapeHtml } from '../_shared/qr-email.ts'
import { loadCallerRole } from '../_shared/checkin-roles.ts'
import { functionGate } from '../_shared/checkin-gates.ts'
import { longDate } from '../_shared/reminder-email.ts'
import { et, emailDate, dirOf, sepOf, alignOf, langsFor, type Lang } from '../_shared/email-i18n.ts'

const BATCH = 80
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, '0')).join('')
}

type Ev = { name: string; date: string; venue: string | null; brand_color?: string | null; logo_url?: string | null; host_name?: string | null; start: string | null }

export function inviteEmail(e: Ev, firstName: string, link: string, lang: Lang = 'en'): { subject: string; html: string } {
  const accent = /^#[0-9A-Fa-f]{6}$/.test(e.brand_color ?? '') ? e.brand_color! : '#1a1a2e'
  const when = [lang === 'en' ? longDate(e.date) : emailDate(lang, e.date), e.start, e.venue].filter(Boolean).join(sepOf(lang))
  const brand = e.logo_url || e.host_name
    ? `<div style="padding:16px 24px;border-bottom:1px solid #eee;">${e.logo_url ? `<img src="${escapeHtml(e.logo_url)}" alt="" width="36" height="36" style="display:inline-block;width:36px;height:36px;border-radius:8px;object-fit:contain;vertical-align:middle;">` : ''}${e.host_name ? `<span dir="auto" style="font-size:14px;font-weight:600;color:#374151;vertical-align:middle;margin-left:${e.logo_url ? '10px' : '0'};">${escapeHtml(e.host_name)}</span>` : ''}</div>`
    : ''
  const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dirOf(lang)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(e.name)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="width:100%;background-color:#f4f4f5;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);border-top:4px solid ${accent};">
      ${brand}
      <div style="padding:28px 24px 8px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${accent};">${escapeHtml(et(lang, 'You are invited'))}</div>
        <div dir="auto" style="text-align:${alignOf(lang)};font-size:24px;font-weight:700;color:#111827;margin-top:6px;line-height:1.2;">${escapeHtml(e.name)}</div>
        <div dir="auto" style="text-align:${alignOf(lang)};font-size:14px;color:#6b7280;margin-top:6px;">${escapeHtml(when)}</div>
      </div>
      <div style="padding:12px 24px 28px;color:#374151;font-size:15px;line-height:1.55;">
        <p style="margin:0 0 18px;">${escapeHtml(et(lang, 'Hi {name}, we would love to see you there. Please let us know if you can come.', { name: firstName }))}</p>
        <p style="margin:0;text-align:center;"><a href="${escapeHtml(link)}" style="display:inline-block;background:${accent};color:#ffffff;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px;text-decoration:none;">${escapeHtml(et(lang, 'Reply to the invitation'))}</a></p>
        <p style="margin:14px 0 0;font-size:12px;color:#9ca3af;text-align:center;">${escapeHtml(et(lang, 'This link is personal to you. Your ticket arrives by email once you say you are coming.'))}</p>
      </div>
      <div style="background:#fafafa;padding:12px 24px;text-align:center;border-top:1px solid #f0f0f0;">
        <span style="font-size:10px;color:#b0b0b8;">${escapeHtml(et(lang, 'Invitations powered by'))}</span>
        <span style="font-size:11px;color:#8a8a95;font-weight:600;margin-left:4px;">CueDeck</span>
      </div>
    </div>
  </div>
</body></html>`
  return { subject: et(lang, 'You are invited: {event}', { event: e.name }), html }
}

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

  let body: Record<string, unknown>
  try { body = await req.json() } catch { return json({ error: 'Bad request' }, 400) }
  if (!body || typeof body !== 'object') return json({ error: 'Bad request' }, 400)
  if (body._ping) return json({ pong: true })

  const jwt = req.headers.get('Authorization')?.replace('Bearer ', '')
  if (!jwt) return json({ error: 'Unauthorized' }, 401)
  const sb = adminClient()
  const { data: { user }, error: authErr } = await sb.auth.getUser(jwt)
  if (authErr || !user) return json({ error: 'Unauthorized' }, 401)

  const event_id = String(body.event_id || '')
  if (!UUID.test(event_id)) return json({ error: 'Missing event_id' }, 400)
  const action = String(body.action || '')
  if (!['send', 'resend', 'test'].includes(action)) return json({ error: 'Bad request' }, 400)
  const gate = functionGate('checkin-invite-guests', await loadCallerRole(sb, event_id, user.id))
  if (!gate.ok) return json(gate.body, gate.status)

  const { data: ent, error: entErr } = await sb.from('leod_checkin_entitlements')
    .select('status, checkin_core, registration_enabled, registration_code').eq('event_id', event_id).maybeSingle()
  if (entErr) return json({ error: entErr.message }, 500)
  if (!ent?.checkin_core) return json({ error: 'Check-in is not enabled for this event' }, 403)
  if (!ent.registration_enabled || !ent.registration_code) {
    return json({ error: 'Turn on the registration page first: invitations open on it.', code: 'registration_off' }, 409)
  }
  const { data: ev, error: evErr } = await sb.from('leod_events').select('name, date, venue, event_start').eq('id', event_id).single()
  if (evErr || !ev) return json({ error: 'Event not found' }, 404)
  const e: Ev = { ...(await withBrand(sb, event_id, { name: ev.name, date: ev.date, venue: ev.venue })),
                  start: typeof ev.event_start === 'string' ? ev.event_start.slice(0, 5) : null }
  const fromName = (ev.name.replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, 64) || 'CueDeck')
  const base = 'https://app.cuedeck.io/r/' + ent.registration_code

  if (action === 'test') {
    if (!user.email) return json({ error: 'Your account has no email address' }, 400)
    const first = String(user.user_metadata?.first_name ?? user.user_metadata?.name ?? '').split(' ')[0] || 'there'
    const m = inviteEmail(e, first, base)
    const { error } = await sendEmail({ to: user.email, subject: '[Test] ' + m.subject, html: m.html, fromName })
    if (error) return json({ error: 'The email could not be sent: ' + error }, 502)
    return json({ ok: true, to: user.email })
  }

  if (ent.status !== 'live') {
    return json({ error: 'Invitations go to guests once the event is live. Send yourself a test to see one now.', code: 'test_mode' }, 409)
  }

  let ids: string[]
  if (action === 'resend') {
    ids = (Array.isArray(body.attendee_ids) ? body.attendee_ids : []).map(String).filter(x => UUID.test(x)).slice(0, BATCH)
    if (!ids.length) return json({ error: 'Choose who to invite again' }, 400)
  } else {
    // Everyone invitable, then leave out those already invited.
    const { data: rows, error } = await sb.from('leod_checkin_attendees').select('id')
      .eq('event_id', event_id).eq('source', 'import').eq('is_test', false).not('email', 'is', null).limit(5000)
    if (error) return json({ error: error.message }, 500)
    const { data: inv, error: invErr } = await sb.from('leod_checkin_web_invites').select('attendee_id').eq('event_id', event_id).limit(5000)
    if (invErr) return json({ error: invErr.message }, 500)
    const done = new Set((inv ?? []).map(r => r.attendee_id))
    ids = (rows ?? []).map(r => r.id).filter(id => !done.has(id))
  }
  const todo = ids.slice(0, BATCH)
  let sent = 0, failed = 0, tooSoon = 0, capped = false
  for (const id of todo) {
    const token = b64url(crypto.getRandomValues(new Uint8Array(32)))
    const hash = await sha256Hex(token)
    const { data: out, error } = await sb.rpc('checkin_web_invite_issue', { p_event_id: event_id, p_attendee_id: id, p_token_hash: hash })
    if (error || !out) { console.error('checkin-invite-guests: issue failed', error?.code); failed++; continue }
    // Limits (migration 120): one per guest every 10 minutes, five in all,
    // 1,000 per event a day.
    if (out.status === 'daily_cap') { capped = true; break }
    if (out.status === 'too_soon' || out.status === 'limit') { tooSoon++; continue }
    if (out.status !== 'issued') continue
    const langs = await langsFor(sb, event_id, [String(out.email)])
    const m = inviteEmail(e, String(out.first_name), base + '#i=' + token, langs.get(String(out.email).toLowerCase()) ?? 'en')
    const { error: mailErr } = await sendEmail({ to: String(out.email), subject: m.subject, html: m.html, fromName })
    if (mailErr) {
      failed++
      console.error('checkin-invite-guests: send failed, attendee', id)
      const { error: unErr } = await sb.rpc('checkin_web_invite_unissue', { p_attendee_id: id, p_token_hash: hash })
      if (unErr) console.error('checkin-invite-guests: unissue failed', unErr.code)
      continue
    }
    sent++
  }
  console.log('checkin-invite-guests:', action, 'sent', sent, 'failed', failed, 'event', event_id)
  if (action === 'resend' && !sent && tooSoon) {
    return json({ error: 'This guest was invited less than 10 minutes ago, or has already been sent five invitations.', code: 'too_soon' }, 429)
  }
  return json({ ok: failed === 0, sent, failed, skipped: tooSoon, capped,
                remaining: action === 'send' && !capped ? Math.max(0, ids.length - todo.length) : 0 })
})
