// registration-confirm-email.ts: the one email the public registration form
// can trigger (migration 101, double opt-in).
//
// FIXED TEXT. Nothing the submitter typed appears in it: not their name, not
// their company, not an answer. The address it goes to is the only thing
// they chose. The event name, date and venue are the organizer's, as in the
// QR email, and are escaped. Whoever receives it either confirms (and is the
// owner of the address) or ignores it, and the request is deleted after 48
// hours.
import { sendEmail } from './resend.ts'
import { et, emailDate, dirOf, sepOf, type Lang } from './email-i18n.ts'

export interface ConfirmEmailEvent {
  name: string
  date: string | null
  venue: string | null
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}


// The organizer's event name and venue are the only free text left, so they
// stay out of the subject and sender (fixed below) and are cut to 80
// characters in the body (security review of 101).
const cut = (s: string | null, n = 80) => (s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, n)

// (123) Still fixed text, in the guest's language: the language comes from
// the page they used, never from anything they typed.
export function renderConfirmEmail(raw: ConfirmEmailEvent, link: string, lang: Lang = 'en'): { subject: string; html: string; text: string } {
  const event = { name: cut(raw.name) || et(lang, 'the event'), date: raw.date, venue: cut(raw.venue) || null }
  const when = [emailDate(lang, event.date, true), event.venue].filter(Boolean).join(sepOf(lang))
  const subject = et(lang, 'Confirm your registration')
  const text = [
    et(lang, 'Someone asked to register this email address for {event}.', { event: event.name }) + (when ? ' (' + when + ')' : ''),
    '',
    et(lang, 'If it was you, confirm here to get your check-in QR code:'),
    link,
    '',
    et(lang, 'If it was not you, ignore this email. Nothing is registered unless the link is used, and the request is deleted after 48 hours.'),
  ].join('\n')
  const html = `<!DOCTYPE html>
<html lang="${lang}" dir="${dirOf(lang)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="width:100%;background-color:#f4f4f5;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);">
      <div style="padding:28px 24px;text-align:center;border-bottom:1px solid #eee;">
        <div dir="auto" style="font-size:22px;font-weight:700;color:#1a1a2e;">${esc(event.name)}</div>
        ${when ? `<div dir="auto" style="color:#6b7280;font-size:12px;margin-top:6px;">${esc(when)}</div>` : ''}
      </div>
      <div style="padding:28px 24px;color:#374151;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.5;">${esc(et(lang, 'Someone asked to register this email address for this event. If it was you, confirm to get your check-in QR code.'))}</p>
        <p style="text-align:center;margin:0 0 20px;"><a href="${esc(link)}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:10px;">${esc(et(lang, 'Confirm my registration'))}</a></p>
        <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.5;">${esc(et(lang, 'If it was not you, ignore this email. Nothing is registered unless the button is used, and the request is deleted after 48 hours.'))}</p>
      </div>
      <div style="background:#fafafa;padding:12px 24px;text-align:center;border-top:1px solid #f0f0f0;">
        <span style="font-size:10px;color:#b0b0b8;">${esc(et(lang, 'Registration by'))}</span>
        <span style="font-size:11px;color:#8a8a95;font-weight:600;margin-left:4px;">CueDeck</span>
      </div>
    </div>
  </div>
</body></html>`
  return { subject, html, text }
}

export async function sendConfirmEmail(to: string, event: ConfirmEmailEvent, link: string, lang: Lang = 'en'): Promise<boolean> {
  const { subject, html, text } = renderConfirmEmail(event, link, lang)
  const { error } = await sendEmail({ to, subject, html, text, fromName: 'CueDeck Registration', tags: [{ name: 'type', value: 'registration_confirm' }] })
  if (error) console.error('registration-confirm-email: send failed')
  return !error
}
