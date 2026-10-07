// supabase/functions/_shared/reminder-email.ts
// The two automatic guest emails (migration 110): the reminder before the
// event, with the guest's QR code, and the thank-you after it. Same layout
// and brand as the QR email (qr-email.ts). Everything the organizer or a
// guest typed is escaped; the organizer's link is https only (checked in
// checkin_set_reminders and again here).

import { escapeHtml, generateQrDataUrl, type QrEmailEvent } from './qr-email.ts'
import { et, emailDate, zoneName, dirOf, sepOf, alignOf, type Lang } from './email-i18n.ts'

export type ReminderEvent = QrEmailEvent & {
  start: string | null        // 'HH:MM', local to the event
  timezone: string | null
  address: string | null
  reminder_message: string | null
  thankyou_message: string | null
  thankyou_link: string | null
}
export type ReminderGuest = { first_name: string; qr_token: string }

const accentOf = (e: QrEmailEvent) => /^#[0-9A-Fa-f]{6}$/.test(e.brand_color ?? '') ? e.brand_color! : '#1a1a2e'
const note = (s: string | null) => s ? escapeHtml(s).replace(/\r?\n/g, '<br>') : ''
// "Europe/Warsaw" -> "Warsaw time", as the registration page says it.
const tzLabel = (tz: string | null) => tz && tz.includes('/') ? tz.split('/').pop()!.replace(/_/g, ' ') + ' time' : ''
export const safeLink = (u: string | null) => u && /^https:\/\/[^\s<>"]+$/.test(u) ? u : null

export function longDate(iso: string): string {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })
}

function frame(e: QrEmailEvent, title: string, body: string, lang: Lang = 'en', footer = 'Check-in powered by'): string {
  const accent = accentOf(e)
  const brand = e.logo_url || e.host_name
    ? `<div style="padding:16px 24px;border-bottom:1px solid #eee;">${e.logo_url ? `<img src="${escapeHtml(e.logo_url)}" alt="" width="36" height="36" style="display:inline-block;width:36px;height:36px;border-radius:8px;object-fit:contain;vertical-align:middle;">` : ''}${e.host_name ? `<span dir="auto" style="font-size:14px;font-weight:600;color:#374151;vertical-align:middle;margin-left:${e.logo_url ? '10px' : '0'};">${escapeHtml(e.host_name)}</span>` : ''}</div>`
    : ''
  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dirOf(lang)}"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="width:100%;background-color:#f4f4f5;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);border-top:4px solid ${accent};">
      ${brand}
      ${body}
      <div style="background:#fafafa;padding:12px 24px;text-align:center;border-top:1px solid #f0f0f0;">
        <span style="font-size:10px;color:#b0b0b8;">${escapeHtml(et(lang, footer))}</span>
        <span style="font-size:11px;color:#8a8a95;font-weight:600;margin-left:4px;">CueDeck</span>
      </div>
    </div>
  </div>
</body></html>`
}

export function reminderEmail(e: ReminderEvent, g: ReminderGuest, lang: Lang = 'en'): { subject: string; html: string } {
  const accent = accentOf(e)
  const day = lang === 'en' ? longDate(e.date) : emailDate(lang, e.date)
  const zone = lang === 'en' ? tzLabel(e.timezone) : zoneName(lang, e.timezone)
  const when = e.start ? et(lang, '{date}, doors open {time}', { date: day, time: e.start + (zone ? ' ' + zone : '') }) : day
  // The organizer's own text: their punctuation, whatever the guest's language.
  const where = [e.venue, e.address].filter(Boolean).join(', ')
  const maps = where ? 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(where) : ''
  const code = g.qr_token.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6).toUpperCase()
  const body = `
      <div style="padding:28px 24px 8px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${accent};">${escapeHtml(et(lang, 'See you soon'))}</div>
        <div dir="auto" style="text-align:${alignOf(lang)};font-size:24px;font-weight:700;color:#111827;margin-top:6px;line-height:1.2;">${escapeHtml(e.name)}</div>
      </div>
      <div style="padding:8px 24px 0;color:#374151;font-size:15px;line-height:1.55;">
        <p style="margin:0 0 14px;">${escapeHtml(et(lang, 'Hi {name}, this is a reminder that you are registered.', { name: g.first_name }))}</p>
        <table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
          <tr><td style="padding:10px 12px;background:#f9fafb;border-radius:8px 8px 0 0;border-bottom:1px solid #eef0f3;"><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;">${escapeHtml(et(lang, 'When'))}</div><div style="font-weight:600;color:#111827;">${escapeHtml(when)}</div></td></tr>
          ${where ? `<tr><td style="padding:10px 12px;background:#f9fafb;border-radius:0 0 8px 8px;"><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;">${escapeHtml(et(lang, 'Where'))}</div><div dir="auto" style="text-align:${alignOf(lang)};font-weight:600;color:#111827;">${escapeHtml(where)}</div><a href="${escapeHtml(maps)}" style="font-size:13px;font-weight:600;color:${accent};text-decoration:none;">${escapeHtml(et(lang, 'Open in Maps'))}</a></td></tr>` : ''}
        </table>
        ${e.reminder_message ? `<div style="border-left:3px solid ${accent};padding:4px 0 4px 12px;margin:0 0 18px;color:#374151;"><div style="font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#6b7280;margin-bottom:4px;">${escapeHtml(et(lang, 'From the organizer'))}</div><div dir="auto" style="text-align:${alignOf(lang)}">${note(e.reminder_message)}</div></div>` : ''}
      </div>
      <div style="padding:4px 24px 28px;text-align:center;">
        <img src="${generateQrDataUrl(g.qr_token)}" width="160" height="160" alt="${escapeHtml(et(lang, 'Your check-in QR code'))}" style="display:inline-block;border:1px solid #e5e7eb;border-radius:8px;padding:8px;">
        <div style="font-family:ui-monospace,Menlo,monospace;font-weight:600;font-size:16px;letter-spacing:.18em;color:#111827;margin-top:8px;">${code}</div>
        <p style="margin:8px 0 0;font-size:12px;color:#6b7280;">${escapeHtml(et(lang, 'Show this at the entrance. The code works if the QR will not scan.'))}</p>
      </div>`
  return { subject: et(lang, 'Reminder: {event}, {date}', { event: e.name, date: day }), html: frame(e, e.name, body, lang) }
}

export function thankyouEmail(e: ReminderEvent, g: Pick<ReminderGuest, 'first_name'>, lang: Lang = 'en'): { subject: string; html: string } {
  const accent = accentOf(e)
  const link = safeLink(e.thankyou_link)
  const body = `
      <div style="padding:28px 24px 8px;">
        <div style="font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:${accent};">${escapeHtml(et(lang, 'Thank you for coming'))}</div>
        <div dir="auto" style="text-align:${alignOf(lang)};font-size:24px;font-weight:700;color:#111827;margin-top:6px;line-height:1.2;">${escapeHtml(e.name)}</div>
      </div>
      <div style="padding:8px 24px 28px;color:#374151;font-size:15px;line-height:1.55;">
        <p style="margin:0 0 14px;">${escapeHtml(et(lang, 'Hi {name}, thank you for joining us on {date}.', { name: g.first_name, date: lang === 'en' ? longDate(e.date) : emailDate(lang, e.date) }))}</p>
        ${e.thankyou_message ? `<p dir="auto" style="text-align:${alignOf(lang)};margin:0 0 18px;">${note(e.thankyou_message)}</p>` : ''}
        ${link ? `<p style="margin:0;text-align:center;"><a href="${escapeHtml(link)}" style="display:inline-block;background:${accent};color:#ffffff;font-weight:700;font-size:15px;padding:12px 22px;border-radius:10px;text-decoration:none;">${escapeHtml(et(lang, 'Open the link'))}</a></p>
        <p style="margin:8px 0 0;font-size:12px;color:#9ca3af;text-align:center;word-break:break-all;">${escapeHtml(link)}</p>` : ''}
      </div>`
  return { subject: et(lang, 'Thank you for coming to {event}', { event: e.name }), html: frame(e, e.name, body, lang) }
}
