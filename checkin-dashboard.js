// checkin-dashboard.js: pure shaping for /checkin/dashboard.
// Input is the JSON from checkin_event_stats (migration 072). ops.desks,
// ops.speeds and ops.gaps carry an opaque per-response key k (no desk id). Nothing here
// invents a number: when there is not enough measured data the functions
// return null or a "not yet" message. tests/checkin-dashboard.spec.ts.
// Design: docs/superpowers/specs/2026-10-04-checkin-roles-design.md (dashboard)
//         docs/superpowers/specs/2026-10-04-checkin-event-day-intelligence-design.md (features 1-3)
import { checkinWindow } from './checkin-window.js';

export const BUCKET_S = 900;
export const MAX_BUCKETS = 96;              // one day of 15-minute bars
export const ONLINE_WITHIN_S = 90;
export const PACE_MIN_CHECKINS = 10;
export const PACE_MIN_ACTIVE_MINUTES = 5;
const PACE_WINDOW_MIN = 15;
const SUSTAIN_MIN = 10;
const CLOSE_SHARE = 0.9;

export function fmtClock(ms, timeZone) {
  const opts = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  try { return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(new Date(ms)); }
  catch { return new Intl.DateTimeFormat('en-GB', opts).format(new Date(ms)); }
}

export function pct(n, d) { return d > 0 ? Math.round((100 * n) / d) : null; }

export function peakBucket(arrivals) {
  let best = null;
  for (const b of arrivals || []) if (!best || b.n > best.n) best = b;
  return best && best.n > 0 ? { t: best.t, n: best.n } : null;
}

export function tiles(s, windowClosed) {
  return {
    registered: s.registered,
    checkedIn: s.checked_in,
    turnout: pct(s.checked_in, s.registered),
    expectedLabel: windowClosed ? 'No-shows' : 'Still expected',
    expected: Math.max(0, s.registered - s.checked_in),
    walkIns: s.walk_ins,
    peak: peakBucket(s.arrivals),
  };
}

// Bars per 15 minutes with every empty bucket filled in, plus a running
// total. A test event can collect check-ins over days, so only the latest
// MAX_BUCKETS are drawn; arrivals before them still count in the total.
export function arrivalSeries(arrivals, timeZone) {
  const list = arrivals || [];
  if (!list.length) return { labels: [], bars: [], cumulative: [] };
  const byT = new Map(list.map(b => [b.t, b.n]));
  const last = list[list.length - 1].t;
  const start = Math.max(list[0].t, last - (MAX_BUCKETS - 1) * BUCKET_S);
  let run = list.filter(b => b.t < start).reduce((a, b) => a + b.n, 0);
  const labels = [], bars = [], cumulative = [];
  for (let t = start; t <= last; t += BUCKET_S) {
    const n = byT.get(t) || 0;
    run += n;
    labels.push(fmtClock(t * 1000, timeZone));
    bars.push(n);
    cumulative.push(run);
  }
  return { labels, bars, cumulative };
}

export function statusDoughnut(s, windowClosed) {
  return { labels: ['Checked in', windowClosed ? 'No-show' : 'Still expected'],
           data: [s.checked_in, Math.max(0, s.registered - s.checked_in)] };
}

export function ticketBars(s) {
  const rows = s.by_ticket || [];
  return {
    labels: rows.map(r => r.ticket_type + ' · ' + (pct(r.checked_in, r.registered) ?? 0) + '%'),
    registered: rows.map(r => r.registered),
    checkedIn: rows.map(r => r.checked_in),
  };
}

export function sourceBars(s) {
  const b = s.by_source || {};
  return { labels: ['Imported', 'Kiosk', 'Walk-in'], data: [b.import || 0, b.kiosk || 0, b.walk_in || 0] };
}

export function qrBars(s) {
  const q = s.qr || {};
  return { labels: ['Sent', 'Not sent', 'No email address'], data: [q.sent || 0, q.not_sent || 0, q.no_email || 0] };
}

// Check-ins per minute over the 15 minutes ending `minutesAgo` minutes
// before the current minute. last25 is oldest first, current minute last.
export function rateAt(last25, minutesAgo) {
  if (!Array.isArray(last25)) return null;
  const end = last25.length - minutesAgo;
  const begin = end - PACE_WINDOW_MIN;
  if (begin < 0 || end > last25.length) return null;
  return last25.slice(begin, end).reduce((a, b) => a + b, 0) / PACE_WINDOW_MIN;
}
export function arrivalRate(last25) { return rateAt(last25, 0); }

export function fmtRate(r) {
  return String(r >= 10 ? Math.round(r) : Math.round(r * 10) / 10);
}

// The client view (feature 3): numbers only.
export function clientView(s) {
  return {
    registered: s.registered,
    checkedIn: s.checked_in,
    turnout: pct(s.checked_in, s.registered),
    peak: peakBucket(s.arrivals),
    rate: s.checked_in >= PACE_MIN_CHECKINS ? arrivalRate(s.last_25_min) : null,
  };
}

export function deskState(desk, timeZone) {
  const since = desk && typeof desk.seconds_since_seen === 'number' ? desk.seconds_since_seen : null;
  if (since !== null && since <= ONLINE_WITHIN_S) {
    const n = desk.pending_count || 0;
    return n > 0 ? { kind: 'syncing', text: 'Syncing, ' + n + ' waiting' } : { kind: 'online', text: 'Online' };
  }
  if (desk && desk.last_seen_at) return { kind: 'offline', text: 'Offline since ' + fmtClock(Date.parse(desk.last_seen_at), timeZone) };
  return { kind: 'offline', text: 'Not connected yet' };
}

// Check-ins per minute in the desk's busiest 15 minutes. A desk that has
// only worked a few minutes is divided by the minutes it has worked (at
// least 5), not by 15, or its speed would read three times too slow.
export function deskSpeed(sp) {
  if (!sp || !(sp.busiest_15 > 0)) return 0;
  const span = (Date.parse(sp.last_at) - Date.parse(sp.first_at)) / 60000;
  const minutes = Math.min(PACE_WINDOW_MIN, Math.max(PACE_MIN_ACTIVE_MINUTES, Number.isFinite(span) ? span : 0));
  return sp.busiest_15 / minutes;
}

export function deskRows(ops, timeZone) {
  if (!ops) return [];
  return [
    ...(ops.desks || []).map(x => ({ label: x.label, who: x.operator || '', state: deskState(x, timeZone) })),
    ...(ops.kiosks || []).map(k => ({ label: k.label, who: 'Kiosk', state: deskState({ ...k, pending_count: 0 }, timeZone) })),
  ];
}

// "0 lost" is claimed only when that desk's latest heartbeat reported an
// empty queue (event-day spec, feature 1).
export function gapLines(ops, timeZone) {
  if (!ops) return [];
  // k is an opaque per-response key: labels can repeat, so pair by k only.
  const desks = new Map((ops.desks || []).map(x => [x.k, x]));
  return (ops.gaps || []).map(g => {
    const desk = desks.get(g.k);
    const n = g.synced_ok || 0;
    const tail = !desk ? 'no report from that desk yet.'
      : desk.pending_count === 0 ? '0 lost.'
      : typeof desk.pending_count === 'number' ? desk.pending_count + ' still on the device.'
      : 'that desk has not reported its queue yet.';
    return (g.label || (desk && desk.label) || 'A desk') + ' offline ' + fmtClock(Date.parse(g.start_at), timeZone)
      + ' to ' + fmtClock(Date.parse(g.end_at), timeZone) + ', ' + n + (n === 1 ? ' check-in' : ' check-ins')
      + ' synced late, ' + tail;
  });
}

// Staffing advice (feature 2) from measured inputs only.
// "Now" is the server's generated_at, never the device clock; nowMs is only
// a fallback for a response without it.
export function paceMessages({ stats, nowMs, eventStartMs }) {
  const gen = stats && stats.generated_at ? Date.parse(stats.generated_at) : NaN;
  if (Number.isFinite(gen)) nowMs = gen;
  const ops = stats && stats.ops;
  if (!ops) return [];
  if ((stats.checked_in || 0) < PACE_MIN_CHECKINS) {
    return [{ tone: 'info', text: 'Pace appears after the first 10 check-ins.' }];
  }
  const measured = (ops.speeds || []).filter(sp => (sp.active_minutes || 0) >= PACE_MIN_ACTIVE_MINUTES);
  if (!measured.length) {
    return [{ tone: 'info', text: 'Desk speed appears once a desk has checked people in for 5 minutes.' }];
  }
  const online = new Set((ops.desks || []).filter(x => deskState(x).kind !== 'offline').map(x => x.k));
  const live = measured.filter(sp => online.has(sp.k));
  const capacity = live.reduce((sum, sp) => sum + deskSpeed(sp), 0);
  const out = [];
  if (capacity <= 0) return out;

  let sustained = true;
  for (let k = 0; k < SUSTAIN_MIN; k++) {
    const r = rateAt(stats.last_25_min, k);
    if (r === null || r <= CLOSE_SHARE * capacity) { sustained = false; break; }
  }
  if (sustained) {
    const who = live.length === 1 ? 'your desk clears' : 'your ' + live.length + ' desks clear';
    out.push({ tone: 'warn', text: 'Arrivals (' + fmtRate(arrivalRate(stats.last_25_min)) + '/min) are close to what '
      + who + ' (' + fmtRate(capacity) + '/min). Consider opening another desk.' });
  }

  const expected = Math.max(0, (stats.registered || 0) - (stats.checked_in || 0));
  if (eventStartMs != null && nowMs < eventStartMs && expected > 0) {
    const mins = Math.max(1, Math.ceil(expected / capacity));
    out.push({ tone: 'info', text: expected + " still expected. At your desks' measured speed that is about "
      + mins + (mins === 1 ? ' minute' : ' minutes') + ' of check-in.' });
  }
  return out;
}

function addDays(ymd, n) {
  const [y, m, dd] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd + n)).toISOString().slice(0, 10);
}

// The event's start as a UTC instant. checkinWindow(d, tz).opensAt is local
// midnight of d minus 7 days, so asking for d plus 7 gives midnight of d,
// with the same DST handling the check-in window already has.
export function eventStartUtc(eventDate, startTime, timeZone) {
  const m = /^(\d{2}):(\d{2})/.exec(String(startTime || ''));
  if (!m || typeof eventDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) return null;
  if (addDays(eventDate, 0) !== eventDate) return null;
  const w = checkinWindow(addDays(eventDate, 7), timeZone);
  if (!w) return null;
  return new Date(w.opensAt.getTime() + (Number(m[1]) * 60 + Number(m[2])) * 60000);
}