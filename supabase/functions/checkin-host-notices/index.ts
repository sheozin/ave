// checkin-host-notices: every minute (pg_cron, migration 154), emails each
// host the guests of theirs who just checked in. Arrivals in the same
// minute go in one email, at most 25 guests an email.
//
// A notice waits 30 seconds before it is sent, so a check-in undone at the
// desk straight away is never announced. Rows are taken with
// checkin_host_notices_claim, so two overlapping runs never send the same
// notice. Skipped, never sent:
//   test    the event is in test mode (the organizer sees "would have told")
//   stopped the host pressed the stop link, or their address was changed
//   undone  the guest's check-in was undone or redone since
//   cap     the address had 60 emails today, or the event 600
//   failed  Resend refused the address for good (a 4xx other than 429)
//   late    still unsent after 2 hours (Resend down, say): old news
// Caps count leod_checkin_host_emails, one row per email, which deleting a
// host does not touch. Each run is a row in leod_checkin_job_runs.
import { adminClient } from '../_shared/client.ts'
import { corsHeaders } from '../_shared/cors.ts'
import { sendEmail } from '../_shared/resend.ts'
import { hostEmail, fromDisplayName } from '../_shared/host-email.ts'

const JOB = 'checkin-host-notices'
const HOST_DAY_CAP = 60
const EVENT_DAY_CAP = 600
const MAX_EMAILS_A_RUN = 40
const MAX_GUESTS_AN_EMAIL = 25
const STOP_URL = 'https://app.cuedeck.io/checkin/host-stop?t='

// deno-lint-ignore no-explicit-any
type Row = any

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms))

Deno.serve(async (req) => {
  const cors = corsHeaders(req)
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { /* cron */ }
  if (body._ping) return json({ pong: true })

  const sb = adminClient()
  const { data: allowed, error: secErr } = await sb.rpc('checkin_host_notices_cron_ok', { p_secret: req.headers.get('x-cron-secret') ?? '' })
  if (secErr) return json({ error: 'secret check failed' }, 500)
  if (allowed !== true) return json({ error: 'Unauthorized' }, 401)
  const { data: run, error: runErr } = await sb.from('leod_checkin_job_runs').insert({ job_name: JOB }).select('id').single()
  if (runErr || !run) return json({ error: 'could not record the run' }, 500)

  let sent = 0, skipped = 0
  const problems: string[] = []
  const skip = async (ids: number[], why: string) => {
    if (!ids.length) return
    const { error } = await sb.from('leod_checkin_host_notices').update({ skipped: why }).in('id', ids).is('sent_at', null).is('skipped', null)
    if (error) throw new Error('skip: ' + error.message)
    skipped += ids.length
  }
  // Hand rows back to the next run (a claim also lapses after 5 minutes).
  const release = async (ids: number[]) => {
    if (!ids.length) return
    const { error } = await sb.from('leod_checkin_host_notices').update({ claimed_at: null }).in('id', ids).is('sent_at', null)
    if (error) problems.push('release: ' + error.message)
  }
  const countSent = async (eventId: string, since: string, email?: string) => {
    let q = sb.from('leod_checkin_host_emails').select('id', { count: 'exact', head: true }).eq('event_id', eventId).gte('sent_at', since)
    if (email) q = q.eq('email', email)
    const { count, error } = await q
    if (error) throw new Error('count: ' + error.message)
    return count ?? 0
  }

  try {
    const now = Date.now()
    // Test mode never emails; very old notices are not news any more.
    for (const [why, q] of [
      ['test', sb.from('leod_checkin_host_notices').update({ skipped: 'test' }).is('sent_at', null).is('skipped', null).eq('is_test', true)],
      ['late', sb.from('leod_checkin_host_notices').update({ skipped: 'late' }).is('sent_at', null).is('skipped', null).lt('created_at', new Date(now - 2 * 3600e3).toISOString())],
    ] as const) {
      const { error } = await q
      if (error) throw new Error(why + ': ' + error.message)
    }

    const { data: claimed, error: claimErr } = await sb.rpc('checkin_host_notices_claim', { p_limit: 400 })
    if (claimErr) throw new Error('claim: ' + claimErr.message)
    const claimedIds = ((claimed ?? []) as Row[]).map((x) => typeof x === 'object' ? Object.values(x)[0] as number : x as number)
    const rows: Row[] = []
    for (let i = 0; i < claimedIds.length; i += 100) {
      const { data, error } = await sb.from('leod_checkin_host_notices')
        .select('id, event_id, host_id, attendee_id, checked_in_at, created_at, leod_checkin_hosts(name, email, stop_token, stopped_at), leod_checkin_attendees(first_name, last_name, company, checked_in_at)')
        .in('id', claimedIds.slice(i, i + 100))
      if (error) throw new Error('read: ' + error.message)
      rows.push(...(data ?? []))
    }
    rows.sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))

    const stopped: number[] = [], undone: number[] = []
    const byHost = new Map<string, Row[]>()
    for (const r of rows) {
      const h = r.leod_checkin_hosts, a = r.leod_checkin_attendees
      if (!h || h.stopped_at) { stopped.push(r.id); continue }
      if (!a || !a.checked_in_at || Date.parse(a.checked_in_at) !== Date.parse(r.checked_in_at)) { undone.push(r.id); continue }
      const list = byHost.get(r.host_id) ?? []
      list.push(r); byHost.set(r.host_id, list)
    }
    await skip(stopped, 'stopped')
    await skip(undone, 'undone')

    const day = new Date(now - 864e5).toISOString()
    const events = new Map<string, Row | null>()
    const eventSent = new Map<string, number>()
    const leftOver: number[] = []
    for (const [hostId, all] of byHost) {
      if (sent >= MAX_EMAILS_A_RUN) { leftOver.push(...all.map((r: Row) => r.id)); continue }   // next minute
      const list = all.slice(0, MAX_GUESTS_AN_EMAIL)
      leftOver.push(...all.slice(MAX_GUESTS_AN_EMAIL).map((r: Row) => r.id))
      const ids = list.map((r: Row) => r.id)
      const eventId = list[0].event_id
      // One host's trouble must not stop the others: note it, move on.
      try {
        if (!events.has(eventId)) {
          const [{ data: ev, error: evErr }, { data: ent, error: entErr }] = await Promise.all([
            sb.from('leod_events').select('name, timezone').eq('id', eventId).maybeSingle(),
            sb.from('leod_checkin_entitlements').select('status, white_label').eq('event_id', eventId).maybeSingle(),
          ])
          if (evErr || entErr) throw new Error('event: ' + (evErr || entErr)!.message)
          events.set(eventId, ev && ent ? { ...ev, ...ent } : null)
          eventSent.set(eventId, await countSent(eventId, day))
        }
        const ev = events.get(eventId)
        if (!ev || ev.status !== 'live') { await skip(ids, 'test'); continue }
        const h = list[0].leod_checkin_hosts
        const to = String(h.email).toLowerCase()
        if ((eventSent.get(eventId) ?? 0) >= EVENT_DAY_CAP || await countSent(eventId, day, to) >= HOST_DAY_CAP) {
          await skip(ids, 'cap'); continue
        }
        const m = hostEmail({
          hostName: h.name, eventName: ev.name, timeZone: ev.timezone, whiteLabel: !!ev.white_label,
          stopUrl: STOP_URL + h.stop_token,
          arrivals: list.map((r: Row) => ({
            name: [r.leod_checkin_attendees.first_name, r.leod_checkin_attendees.last_name].filter(Boolean).join(' ') || 'A guest',
            company: r.leod_checkin_attendees.company || null, at: r.checked_in_at,
          })),
        })
        const res = await sendEmail({
          to: h.email, subject: m.subject, html: m.html, text: m.text,
          fromName: fromDisplayName(ev.name),
          idempotencyKey: 'host-notice-' + hostId + '-' + [...ids].sort((a, b) => a - b).join('.'),
        })
        if (res.error || !res.id) {
          // A 4xx other than 429 will fail the same way next minute.
          if (res.status && res.status >= 400 && res.status < 500 && res.status !== 429) await skip(ids, 'failed')
          else await release(ids)   // retried next minute, until 'late'
          problems.push('Resend: ' + (res.status ?? '') + ' ' + (res.error || 'no id'))
          await sleep(550)
          continue
        }
        const { error: uErr } = await sb.from('leod_checkin_host_notices').update({ sent_at: new Date().toISOString(), resend_id: res.id }).in('id', ids)
        if (uErr) problems.push('mark sent: ' + uErr.message)
        const { error: lErr } = await sb.from('leod_checkin_host_emails').insert({ event_id: eventId, email: to, resend_id: res.id, guests: ids.length })
        if (lErr) problems.push('log email: ' + lErr.message)
        eventSent.set(eventId, (eventSent.get(eventId) ?? 0) + 1)
        sent++
        await sleep(550)   // Resend allows 2 a second
      } catch (e) {
        problems.push((e as Error).message)
        await release(ids)
      }
    }
    await release(leftOver)
  } catch (e) { problems.push((e as Error).message) }

  // A Resend refusal is retried next minute, but a run where every send
  // failed is a failed run: otherwise a dead sender reads as a quiet one.
  const failed = problems.some(p => !p.startsWith('Resend')) || (sent === 0 && problems.length > 0)
  const detail = `sent ${sent}, skipped ${skipped}` + (problems.length ? '; ' + problems.slice(0, 5).join(' | ') : '')
  const { error: finErr } = await sb.from('leod_checkin_job_runs').update({ status: failed ? 'failed' : 'ok', detail: detail.slice(0, 2000), finished_at: new Date().toISOString() }).eq('id', run.id)
  if (finErr) console.error('checkin-host-notices: run not closed', finErr.code)
  return json({ status: failed ? 'failed' : 'ok', detail }, failed ? 500 : 200)
})
