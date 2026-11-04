// client-report-email.ts: the check-in report the organizer's client gets at
// 08:00 the morning after (migration 157). Unlike the owner's report email
// it names the event: the organizer chose who receives it, and a client
// cannot tell one event from another by date alone. It carries numbers
// only; guests' names go only in the CSV, and only when the organizer
// ticked it. Plain imports only, so vitest can load it
// (tests/checkin-client-report.spec.ts).

import { headline, type ReportData } from './checkin-report-email.ts'

export interface ClientReportData extends ReportData {
  event: { date: string; name?: string | null; venue?: string | null; timezone?: string | null }
  by_ticket?: { ticket_type: string; registered: number; checked_in: number; no_shows: number }[]
}
export interface Guest {
  first_name: string | null; last_name: string | null; company: string | null
  ticket_type: string | null; checked_in_at: string | null
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
// Organizer-typed text in a subject or heading: one line, no bidi tricks.
const line = (s: string | null | undefined, max = 120) =>
  (s ?? '').replace(/[\u0000-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
const plural = (n: number, one: string, many: string) => n + ' ' + (n === 1 ? one : many)

function fmtDate(ymd: string): string {
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

// pageUrl (migration 158): the same numbers as a page to save as a PDF.
export function clientReportEmail(r: ClientReportData, host: string | null, pageUrl?: string | null): { subject: string; html: string; text: string } {
  const h = headline(r)
  const event = line(r.event.name) || 'your event'
  const by = line(host) || 'The organizer'
  const date = fmtDate(r.event.date)
  const lines = [
    h.checkedIn + ' of ' + h.registered + ' checked in' + (h.turnout === null ? '' : ' (' + h.turnout + '%)'),
    h.noShows + ' did not arrive',
    plural(h.walkIns, 'walk-in', 'walk-ins'),
    h.peak + ' arrived in the busiest 15 minutes',
  ]
  const tickets = (r.by_ticket ?? []).slice(0, 20)
  const subject = 'Check-in report: ' + event + ', ' + date
  const intro = by + ' shares the check-in numbers for ' + event + ' on ' + date + '.'
  const text = [
    intro, '',
    ...lines.map(l => '- ' + l),
    ...(tickets.length ? ['', 'By ticket type:', ...tickets.map(t => '- ' + line(t.ticket_type, 60) + ': ' + t.checked_in + ' of ' + t.registered)] : []),
    ...(pageUrl ? ['', 'Save it as a PDF: ' + pageUrl] : []),
    '', 'Reply to this email to reach ' + by + '.', '', 'Sent by CueDeck Check-in',
  ].join('\n')
  const cell = 'padding:8px 12px;border-bottom:1px solid #e5e5ea;font-size:14px'
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1d1d1f">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<div style="background:#ffffff;border-radius:16px;padding:32px 28px">
<h1 style="margin:0 0 8px;font-size:22px;line-height:1.3">${esc(event)}</h1>
<p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#424245">${esc(intro)}</p>
<ul style="margin:0 0 24px;padding:0;list-style:none">
${lines.map(l => `<li style="padding:10px 14px;margin:0 0 8px;background:#f5f5f7;border-radius:10px;font-size:15px">${esc(l)}</li>`).join('\n')}
</ul>
${tickets.length ? `<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 8px">
<tr><th style="${cell};text-align:left;color:#6e6e73;font-weight:600">Ticket type</th><th style="${cell};text-align:right;color:#6e6e73;font-weight:600">Checked in</th></tr>
${tickets.map(t => `<tr><td style="${cell}">${esc(line(t.ticket_type, 60))}</td><td style="${cell};text-align:right">${t.checked_in} of ${t.registered}</td></tr>`).join('\n')}
</table>` : ''}
${pageUrl ? `<p style="margin:20px 0 0"><a href="${esc(pageUrl)}" style="display:inline-block;background:#1d1d1f;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:10px">Open as a page to save as PDF</a></p>` : ''}
<p style="margin:20px 0 0;font-size:13px;line-height:1.6;color:#6e6e73">Reply to this email to reach ${esc(by)}.</p>
</div>
<p style="margin:16px 0 0;font-size:12px;color:#86868b;text-align:center">Sent by CueDeck Check-in because ${esc(by)} added your address to this event's report.</p>
</div></body></html>`
  return { subject, html, text }
}

// The guest list, semicolon separated with a byte order mark so Excel
// opens Polish and Arabic names correctly. Same cell rules as the Reports
// export (checkin-csv.js toCsv): control and bidi characters dropped, and a
// leading = + - @ made inert so a spreadsheet never runs a guest's name.
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F؜‎‏‪-‮⁦-⁩]/g
function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v).replace(CONTROL_RE, '')
  if (/^[\s　]*[=+\-@＝＋－＠\t\r]/.test(s)) s = "'" + s
  return s.includes('"') || s.includes(';') || /[\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}
function localParts(iso: string, tz: string): { date: string; time: string } {
  let f: Intl.DateTimeFormat
  try { f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
  catch { f = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map(x => [x.type, x.value]))
  return { date: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute }
}
export function guestCsv(guests: Guest[], tz: string): string {
  const rows: unknown[][] = [['First name', 'Last name', 'Company', 'Ticket type', 'Checked in', 'Date', 'Time']]
  for (const g of guests) {
    const t = g.checked_in_at ? localParts(g.checked_in_at, tz) : { date: '', time: '' }
    rows.push([g.first_name, g.last_name, g.company, g.ticket_type, g.checked_in_at ? 'Yes' : 'No', t.date, t.time])
  }
  return '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n')
}

// Resend wants attachments base64 encoded; btoa only takes Latin-1.
export function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}
