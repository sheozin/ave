// retention-email.ts: the email to an event owner 14 days before their
// guests' personal data is deleted (migration 160). Like the post-event
// report, it states account facts only: the event date and the deletion
// date, never the event name or anything about the guests. Plain imports
// only, so vitest can load it (tests/checkin-retention-email.spec.ts).

function fmtDay(d: Date, timeZone: string): string {
  const o: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long', year: 'numeric' }
  try { return d.toLocaleDateString('en-GB', { ...o, timeZone }) }
  catch { return d.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' }) }
}

export function retentionEmail(eventDate: string, purgeAt: Date, timeZone: string, setupUrl: string): { subject: string; html: string; text: string } {
  // The link is built by the sender from an event id; anything else is a bug.
  if (!/^https:\/\/app\.cuedeck\.io\/checkin\/setup\?event=[0-9a-f-]{36}&step=reports$/.test(setupUrl)) {
    throw new Error('refusing a setup link outside app.cuedeck.io')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || Number.isNaN(purgeAt.getTime())) throw new Error('bad dates')
  const ev = fmtDay(new Date(eventDate + 'T12:00:00Z'), 'UTC')
  const on = fmtDay(purgeAt, timeZone)
  const subject = 'Guest details from your ' + ev + ' event will be deleted on ' + on
  const p1 = 'On ' + on + ' we delete the personal details of the guests of your event on ' + ev + ': names, email addresses, companies, job titles and registration answers. We keep them for 90 days after an event, then delete them.'
  const p2 = 'The numbers stay: how many registered and checked in, by ticket type, by time and by door. Your reports keep working.'
  const p3 = 'If you need the guest list, download it before then from Reports in the event admin.'
  const text = [p1, '', p2, '', p3, setupUrl, '', 'CueDeck'].join('\n')
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<div style="background:#ffffff;border-radius:16px;padding:32px 28px">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#6e6e73">CueDeck Check-in</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">Guest details will be deleted on ${on}</h1>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#424245">${p1}</p>
<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#424245">${p2}</p>
<p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#424245">${p3}</p>
<a href="${setupUrl}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">Download the guest list</a>
</div>
<p style="margin:16px 0 0;font-size:12px;color:#86868b;text-align:center">You receive this once per event because you own it in CueDeck Check-in.</p>
</div></body></html>`
  return { subject, html, text }
}
