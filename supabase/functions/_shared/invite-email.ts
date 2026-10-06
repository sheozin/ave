// invite-email.ts: the invitation email for console operators
// (invite-operator) and check-in staff (checkin-invite-staff).
//
// Both used to fall back on Supabase Auth's built-in "Invite user" email for
// new accounts, a generic template that cannot name the event. The link is
// now made with auth.admin.generateLink (no email sent by Supabase) and this
// template sends it, so the subject and the body say which event the person
// is joining, who invited them and as what.
//
// Event name, inviter name and role are organizer-typed: escaped in the
// HTML, and stripped of line breaks and header-like characters for the
// subject and sender name.
import { sendEmail } from './resend.ts'

export interface InviteEmail {
  to: string
  eventName: string | null        // null: no event named (team invite without one)
  eventDate?: string | null       // ISO date
  inviterName?: string | null
  roleText: string                // "the Stage role", "the check-in desk"
  actionUrl: string
  actionLabel: string             // "Accept the invitation", "Open CueDeck Check-in"
  product: 'console' | 'checkin'
  existingAccount?: boolean       // already has a login: no password step
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
// For the subject (a header): no line breaks or header-like characters.
const line = (s: string | null | undefined, n = 80) => (s ?? '').replace(/[\r\n]+/g, ' ').replace(/[<>"]/g, '').trim().slice(0, n)
// For the HTML body: the real text, one line, escaped where it is used.
const flat = (s: string | null | undefined, n = 80) => (s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n)

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00Z')
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

export function renderInviteEmail(m: InviteEmail): { subject: string; html: string; text: string } {
  const event = line(m.eventName)
  const eventBody = flat(m.eventName)
  const inviter = flat(m.inviterName, 60)
  const date = fmtDate(m.eventDate)
  const area = m.product === 'checkin' ? 'check-in' : 'CueDeck'
  const subject = event
    ? (m.product === 'checkin' ? `You're invited to ${event} check-in` : `You're invited to ${event} on CueDeck`)
    : `You're invited to join a team on CueDeck`
  const who = inviter ? `${inviter} has invited you` : 'You have been invited'
  const lead = eventBody
    ? `${who} to work on ${eventBody} with ${m.roleText}.`
    : `${who} to join their CueDeck team with ${m.roleText}.`
  const next = m.existingAccount
    ? 'Sign in with your existing CueDeck login.'
    : 'Accept the invitation to set your password. The link works once; if it has expired, ask for a new invitation.'

  const text = [lead, ...(date ? [`Event date: ${date}.`] : []), '', `${m.actionLabel}: ${m.actionUrl}`, '', next].join('\n')
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="width:100%;background-color:#f4f4f5;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
      <div style="padding:28px 24px;border-bottom:1px solid #eee;">
        <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#2563eb;">Invitation · ${esc(area)}</div>
        <div style="font-size:22px;font-weight:700;color:#1a1a2e;margin-top:6px;">${esc(eventBody || 'Join your team on CueDeck')}</div>
        ${date ? `<div style="color:#6b7280;font-size:13px;margin-top:4px;">${esc(date)}</div>` : ''}
      </div>
      <div style="padding:24px;color:#374151;">
        <p style="margin:0 0 20px;font-size:15px;line-height:1.55;">${esc(lead)}</p>
        <p style="text-align:center;margin:0 0 20px;"><a href="${esc(m.actionUrl)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">${esc(m.actionLabel)}</a></p>
        <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">${esc(next)}</p>
      </div>
      <div style="background:#fafafa;padding:12px 24px;text-align:center;border-top:1px solid #f0f0f0;">
        <span style="font-size:11px;color:#8a8a95;font-weight:600;">CueDeck</span>
      </div>
    </div>
  </div>
</body></html>`
  return { subject, html, text }
}

export async function sendInviteEmail(m: InviteEmail): Promise<{ error?: string }> {
  const { subject, html, text } = renderInviteEmail(m)
  const fromName = m.product === 'checkin' ? 'CueDeck Check-in' : 'CueDeck'
  const { error } = await sendEmail({ to: m.to, subject, html, text, fromName, tags: [{ name: 'type', value: 'invite_' + m.product }] })
  return error ? { error } : {}
}
