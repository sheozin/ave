// host-email.ts: the email a host gets when their guests check in
// (migration 154, checkin-host-notices). It names each guest with their
// company and arrival time, and nothing else about them: no email, no
// phone, no ticket price. The organizer chose to tell this host, so the
// guest's name is the point; the rest of the guest record stays out.
// Every line carries the stop link. Plain imports only, so vitest can load
// it (tests/checkin-host-email.spec.ts).

export interface HostArrival { name: string; company: string | null; at: string }
export interface HostEmailInput {
  hostName: string
  eventName: string
  timeZone: string | null
  arrivals: HostArrival[]
  stopUrl: string
  whiteLabel?: boolean
}

export function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// One line of header text: no line breaks, no angle brackets.
export function headerSafe(s: string, max = 120): string {
  return String(s).replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').trim().slice(0, max)
}

// The display name in From: drop the characters that end or split a name
// in an address header, control and direction-override characters, then
// quote it.
export function fromDisplayName(eventName: string): string {
  const clean = String(eventName).replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069"@,;:\\<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 64).trim()
  return '"' + (clean || 'CueDeck') + ' Check-in"'
}

export function hostTime(iso: string, timeZone: string | null): string {
  const opts: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timeZone || 'UTC' }).format(new Date(iso)) }
  catch { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'UTC' }).format(new Date(iso)) + ' UTC' }
}

export function hostEmail(m: HostEmailInput): { subject: string; html: string; text: string } {
  const list = [...m.arrivals].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  const first = list[0]
  const subject = headerSafe(list.length === 1
    ? first.name + ' has arrived at ' + m.eventName
    : list.length + ' of your guests have arrived at ' + m.eventName, 160)
  const who = (a: HostArrival) => a.name + (a.company ? ' (' + a.company + ')' : '')
  const rows = list.map(a => `
        <tr><td style="padding:10px 12px;border-bottom:1px solid #eef0f3;"><div dir="auto" style="font-weight:600;color:#111827;">${esc(a.name)}</div>${a.company ? `<div dir="auto" style="font-size:13px;color:#6b7280;">${esc(a.company)}</div>` : ''}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #eef0f3;text-align:right;font-variant-numeric:tabular-nums;color:#374151;white-space:nowrap;">${esc(hostTime(a.at, m.timeZone))}</td></tr>`).join('')
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <div style="width:100%;background-color:#f4f4f5;padding:40px 20px;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 4px 6px rgba(0,0,0,0.05);border-top:4px solid #0071E3;">
      <div style="padding:28px 24px 8px;">
        <div dir="auto" style="font-size:20px;font-weight:700;color:#111827;line-height:1.3;">${esc(list.length === 1 ? 'Your guest has arrived' : list.length + ' of your guests have arrived')}</div>
        <p style="margin:8px 0 0;color:#374151;font-size:15px;line-height:1.5;">Hi ${esc(m.hostName)}, ${list.length === 1 ? 'this guest' : 'these guests'} just checked in at <span dir="auto">${esc(m.eventName)}</span>.</p>
      </div>
      <div style="padding:8px 24px 20px;">
        <table role="presentation" style="width:100%;border-collapse:collapse;background:#f9fafb;border-radius:8px;">${rows}
        </table>
      </div>
      <div style="padding:0 24px 24px;color:#6b7280;font-size:12px;line-height:1.5;">
        You get these emails because the organizer of <span dir="auto">${esc(m.eventName)}</span> added you as a host.
        <a href="${esc(m.stopUrl)}" style="color:#0071E3;font-weight:600;text-decoration:none;">Stop these emails</a>
      </div>
      ${m.whiteLabel ? '' : `<div style="background:#fafafa;padding:12px 24px;text-align:center;border-top:1px solid #f0f0f0;">
        <span style="font-size:10px;color:#b0b0b8;">Check-in powered by</span>
        <span style="font-size:11px;color:#8a8a95;font-weight:600;margin-left:4px;">CueDeck</span>
      </div>`}
    </div>
  </div>
</body></html>`
  const text = [
    'Hi ' + m.hostName + ',',
    '',
    (list.length === 1 ? 'Your guest has arrived at ' : list.length + ' of your guests have arrived at ') + m.eventName + ':',
    ...list.map(a => '  ' + hostTime(a.at, m.timeZone) + '  ' + who(a)),
    '',
    'You get these emails because the organizer added you as a host. Stop them: ' + m.stopUrl,
  ].join('\n')
  return { subject, html, text }
}
