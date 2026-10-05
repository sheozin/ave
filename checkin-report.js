// checkin-report.js: pure shaping for /checkin/report (event-day spec,
// feature 6). Every number the page shows comes through here; the page
// only builds DOM. Tested in tests/checkin-report.spec.ts.
import { fmtClock, pct, BUCKET_S } from './checkin-dashboard.js';

export function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'under a minute';
  const h = Math.floor(mins / 60), m = mins % 60;
  return h ? h + ' h ' + m + ' min' : m + ' min';
}

export function reportTiles(r, timeZone) {
  const first = Date.parse(r.first_arrival_at), last = Date.parse(r.last_arrival_at);
  const both = Number.isFinite(first) && Number.isFinite(last);
  return {
    checkedIn: r.checked_in,
    registered: r.registered,
    turnout: pct(r.checked_in, r.registered),
    noShows: r.registered - r.checked_in,
    walkIns: r.walk_ins,
    peakN: r.peak ? r.peak.n : 0,
    peakRange: r.peak ? fmtClock(r.peak.t * 1000, timeZone) + ' to ' + fmtClock((r.peak.t + BUCKET_S) * 1000, timeZone) : '',
    span: both ? fmtDuration(last - first) : '',
    firstLast: both ? fmtClock(first, timeZone) + ' to ' + fmtClock(last, timeZone) : '',
  };
}

const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

export function offlineLine(r) {
  const o = r.offline;
  if (!o || !o.late_checkins) return 'Every check-in reached the server within a minute.';
  return plural(o.late_checkins, 'check-in was', 'check-ins were') + ' made offline on ' + plural(o.desks, 'desk', 'desks')
    + ' and synced later. The longest delay was ' + fmtDuration(o.longest_delay_s * 1000) + '.';
}

// Desks without a label (a viewer's report, or a desk row since removed)
// are numbered by their place in the list.
export function deskRows(r) {
  return (r.desks || []).map((d, i) => ({ label: d.label || 'Desk ' + (i + 1), checkins: d.checkins, busiest: d.busiest_15 }));
}

export function ticketRows(r) {
  return (r.by_ticket || []).map(t => ({
    ticketType: t.ticket_type, registered: t.registered, checkedIn: t.checked_in,
    noShows: t.no_shows, turnout: pct(t.checked_in, t.registered),
  }));
}
