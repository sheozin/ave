// supabase/functions/_shared/qr-email.ts
// Shared "generate QR + render email + send + record result" logic for
// check-in QR delivery, used by both checkin-import-attendees's
// auto-send path and checkin-send-qr-emails's manual/resend path.
//
// A QR code is a check-in TOKEN, not a badge — the attendee still
// gets verified and their badge printed on-site. Copy is deliberately
// phrased as a verification step, not a skip-the-line pass.

import qrcode from 'https://esm.sh/qrcode-generator@1.4.4'
import { sendEmail } from './resend.ts'

export interface QrEmailAttendee {
  id: string
  first_name: string
  email: string | null
  qr_token: string
}

export interface QrEmailEvent {
  name: string
  date: string        // ISO date, e.g. '2026-09-15'
  venue: string | null
  // The event's brand (Event admin, Branding). Optional: without it the
  // email is the plain CueDeck layout.
  brand_color?: string | null
  logo_url?: string | null
  host_name?: string | null
}

// The event's brand for guest emails, from the Branding tab (migration
// 104/106). Best effort: a failed read sends the plain layout, never fails
// the send. The logo is only ever a URL in our own checkin-public bucket.
export async function withBrand(
  sb: ReturnType<typeof import('./client.ts').adminClient>, eventId: string, event: QrEmailEvent,
): Promise<QrEmailEvent> {
  const { data, error } = await sb.from('leod_checkin_entitlements')
    .select('registration_brand_color, registration_logo_path, registration_host_name').eq('event_id', eventId).maybeSingle()
  if (error || !data) return event
  const color = /^#[0-9A-Fa-f]{6}$/.test(data.registration_brand_color ?? '') ? data.registration_brand_color : null
  const logo = data.registration_logo_path ? Deno.env.get('SUPABASE_URL') + '/storage/v1/object/public/checkin-public/' + data.registration_logo_path : null
  return { ...event, brand_color: color, logo_url: logo, host_name: data.registration_host_name ?? null }
}

export interface QrEmailResult {
  attendee_id: string
  status: 'sent' | 'skipped_no_email' | 'error'
  error?: string
}

// event.name/venue are organizer-controlled; attendee.first_name comes
// from CSV import, which can carry adversarial input from an external
// registration list. None of it is escaped by default in a template
// literal, so without this, a first_name like `<a href="...">click</a>`
// would inject arbitrary markup/links into a genuine check-in email.
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatEventDate(isoDate: string): string {
  const d = new Date(isoDate + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

function generateQrDataUrl(token: string): string {
  const qr = qrcode(0, 'M')
  qr.addData(token)
  qr.make()
  return qr.createDataURL()
}

function renderQrEmailHtml(event: QrEmailEvent, attendee: QrEmailAttendee, qrDataUrl: string): string {
  const safeName = escapeHtml(event.name)
  const safeFirstName = escapeHtml(attendee.first_name)
  const venueLine = event.venue ? ` &middot; ${escapeHtml(event.venue)}` : ''
  const accent = /^#[0-9A-Fa-f]{6}$/.test(event.brand_color ?? '') ? event.brand_color! : '#1a1a2e'
  const brandBar = event.logo_url || event.host_name
    ? `<div style="padding:16px 24px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:10px;">${event.logo_url ? `<img src="${escapeHtml(event.logo_url)}" alt="" width="36" height="36" style="display:inline-block;width:36px;height:36px;border-radius:8px;object-fit:contain;vertical-align:middle;">` : ''}${event.host_name ? `<span style="font-size:14px;font-weight:600;color:#374151;vertical-align:middle;margin-left:${event.logo_url ? '10px' : '0'};">${escapeHtml(event.host_name)}</span>` : ''}</div>`
    : ''
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeName}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="width:100%;background-color:#f4f4f5;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);border-top:4px solid ${accent};">
      ${brandBar}
      <div style="background:#fff;padding:28px 24px;text-align:center;border-bottom:1px solid #eee;">
        <div style="font-size:22px;font-weight:700;color:${accent};">${safeName}</div>
        <div style="color:#6b7280;font-size:12px;margin-top:6px;">${formatEventDate(event.date)}${venueLine}</div>
      </div>
      <div style="padding:28px 24px;color:#374151;">
        <p style="margin:0 0 8px;font-size:15px;">Hi ${safeFirstName},</p>
        <p style="margin:0 0 20px;font-size:15px;line-height:1.5;">Show this QR code at the entrance to check in — no need to print anything, your phone screen works fine.</p>
        <div style="text-align:center;margin:0 0 20px;">
          <img src="${qrDataUrl}" width="160" height="160" alt="Your check-in QR code" style="display:inline-block;border:1px solid #e5e7eb;border-radius:8px;padding:8px;">
        </div>
        <p style="margin:0;font-size:12px;color:#9ca3af;text-align:center;">Lost this email? Just show your name at the entrance instead.</p>
      </div>
      <div style="background:#fafafa;padding:12px 24px;text-align:center;border-top:1px solid #f0f0f0;">
        <span style="font-size:10px;color:#b0b0b8;">Check-in powered by</span>
        <span style="font-size:11px;color:#8a8a95;font-weight:600;margin-left:4px;">CueDeck</span>
      </div>
    </div>
  </div>
</body>
</html>`
}

// Sends (or skips, or records a failure for) each attendee in the
// list. Does NOT query the database for which attendees to target —
// callers decide that (see checkin-send-qr-emails and
// checkin-import-attendees's auto-send integration) and pass the
// already-fetched rows in.
export async function sendQrEmailsForAttendees(
  sb: ReturnType<typeof import('./client.ts').adminClient>,
  event: QrEmailEvent,
  attendees: QrEmailAttendee[],
  // overrideTo: deliver to this address instead (the organizer's own
  // "send a test to myself"). recordSent false: do not stamp
  // qr_email_sent_at, because the guest has not been emailed.
  opts: { overrideTo?: string; recordSent?: boolean } = {},
): Promise<QrEmailResult[]> {
  const results: QrEmailResult[] = []

  for (const attendee of attendees) {
    const to = opts.overrideTo ?? attendee.email
    if (!to) {
      results.push({ attendee_id: attendee.id, status: 'skipped_no_email' })
      continue
    }

    // qr_token is a server-generated random string, never user input,
    // so the QR encoder should never throw in practice — but if it
    // ever does (or the send itself throws), isolate the failure to
    // this one attendee rather than aborting the whole batch, which
    // would silently drop every remaining attendee's email.
    try {
      const safeFrom = event.name.replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, 64) || 'CueDeck'
      const qrDataUrl = generateQrDataUrl(attendee.qr_token)
      const html = renderQrEmailHtml(event, attendee, qrDataUrl)

      const { error } = await sendEmail({
        to,
        subject: `Your check-in QR code — ${event.name}`,
        html,
        fromName: `${safeFrom} Check-in`,
      })

      if (error) {
        results.push({ attendee_id: attendee.id, status: 'error', error })
        continue
      }

      if (opts.recordSent !== false) {
        const { error: updateErr } = await sb.from('leod_checkin_attendees')
          .update({ qr_email_sent_at: new Date().toISOString() })
          .eq('id', attendee.id)
        if (updateErr) {
          // Email genuinely sent — record it as sent even though the
          // sent_at bookkeeping failed, so callers don't double-send. Log
          // for visibility rather than silently losing the discrepancy.
          console.error('sendQrEmailsForAttendees: qr_email_sent_at update failed for', attendee.id, updateErr.message)
        }
      }
      results.push({ attendee_id: attendee.id, status: 'sent' })
    } catch (err) {
      console.error('sendQrEmailsForAttendees: unexpected failure for', attendee.id, err)
      results.push({
        attendee_id: attendee.id,
        status: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return results
}
