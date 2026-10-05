// checkin-report-email.ts: the post-event report email (event-day spec,
// feature 6). Headline numbers and a link only. Outbound mail states
// account facts, never customer content: no event name, venue, attendee
// names, companies or desk labels, so a forwarded or spoofed copy shows
// nothing about the event's guests. Plain imports only, so vitest can
// load it (tests/checkin-report-email.spec.ts).

export interface ReportData {
  registered: number
  checked_in: number
  walk_ins: number
  event: { date: string }
  peak: { t: number; n: number } | null
  desks: unknown[]
}

export interface Headline {
  registered: number
  checkedIn: number
  turnout: number | null
  noShows: number
  walkIns: number
  peak: number
  desks: number
}

export function headline(r: ReportData): Headline {
  return {
    registered: r.registered,
    checkedIn: r.checked_in,
    turnout: r.registered > 0 ? Math.round((100 * r.checked_in) / r.registered) : null,
    noShows: r.registered - r.checked_in,
    walkIns: r.walk_ins,
    peak: r.peak ? r.peak.n : 0,
    desks: (r.desks || []).length,
  }
}

function fmtDate(ymd: string): string {
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

const plural = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many)

export function reportEmail(r: ReportData, reportUrl: string): { subject: string; html: string; text: string } {
  // The link is built by the sender from an event id; anything else is a bug.
  if (!/^https:\/\/app\.cuedeck\.io\/checkin\/report\?event=[0-9a-zA-Z-]+$/.test(reportUrl)) {
    throw new Error('refusing a report link outside app.cuedeck.io')
  }
  const h = headline(r)
  const date = fmtDate(r.event.date)
  const lines = [
    h.checkedIn + ' of ' + h.registered + ' checked in' + (h.turnout === null ? '' : ' (' + h.turnout + '%)'),
    h.noShows + ' did not arrive',
    plural(h.walkIns, 'walk-in', 'walk-ins'),
    h.peak + ' in the busiest 15 minutes',
    plural(h.desks, 'desk', 'desks') + ' checked people in',
  ]
  const subject = 'Your check-in report for ' + date
  const text = [
    'Check-in for your event on ' + date + ' has closed. Here are the headline numbers.',
    '',
    ...lines.map(l => '- ' + l),
    '',
    'The full report, with arrivals by ticket type and desk speeds, is here:',
    reportUrl,
    '',
    'CueDeck',
  ].join('\n')
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<div style="background:#ffffff;border-radius:16px;padding:32px 28px">
<p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#6e6e73;letter-spacing:.04em;text-transform:uppercase">CueDeck Check-in</p>
<h1 style="margin:0 0 16px;font-size:22px;line-height:1.3">Your check-in report for ${date}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#424245">Check-in for your event on ${date} has closed. Here are the headline numbers.</p>
<ul style="margin:0 0 24px;padding:0;list-style:none">
${lines.map(l => `<li style="padding:10px 14px;margin:0 0 8px;background:#f5f5f7;border-radius:10px;font-size:15px">${l}</li>`).join('\n')}
</ul>
<a href="${reportUrl}" style="display:inline-block;background:#0071e3;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 22px;border-radius:10px">Open the full report</a>
<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#6e6e73">The full report has arrivals by ticket type, desk speeds and offline periods. You need to be signed in to see it.</p>
</div>
<p style="margin:16px 0 0;font-size:12px;color:#86868b;text-align:center">You receive this once per event because you own it in CueDeck Check-in.</p>
</div></body></html>`
  return { subject, html, text }
}
