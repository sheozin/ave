// checkin-export.js: the guest attendance and activity exports on the
// Reports tab. Pure shaping; the page fetches and builds the DOM.
// Activity rows come from checkin_activity_export (migration 152).
// Tested in tests/checkin-export.spec.ts.

const SOURCE = { import: 'Imported', kiosk: 'Kiosk', walk_in: 'Walk-in', web: 'Registration page', plus_one: 'Plus-one' };

export const WHAT = {
  ok: 'Checked in',
  undo: 'Check-in undone',
  duplicate: 'Scanned again, already checked in',
  new_badge: 'New badge printed, old code blocked',
  revoked: 'Old badge scanned, blocked',
  unknown_token: 'Code not on the guest list',
  wrong_event: 'Code for another event',
  forbidden: 'Undo refused',
  test_cap: 'Refused: test check-ins used up',
  outside_window: 'Refused: check-in closed',
};
const GROUP = { checkins: ['ok', 'undo'], badges: ['new_badge'] };
const isProblem = (k) => !GROUP.checkins.includes(k) && !GROUP.badges.includes(k);

const fmtCache = new Map();
export function localParts(iso, timeZone) {
  if (!iso) return { date: '', time: '' };
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    fmtCache.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map(x => [x.type, x.value]));
  return { date: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute + ':' + p.second };
}

// Where it happened: a desk by its name, a door or session with the phone.
export function placeOf(r) {
  if (r.desk) return r.desk;
  if (r.place) return r.device ? r.place + ' (' + r.device + ')' : r.place;
  return r.device || '';
}

// HH:MM bounds, inclusive to the minute.
function inWindow(time, o) {
  const hm = time.slice(0, 5);
  return (!o.from || hm >= o.from) && (!o.to || hm <= o.to);
}

export function attendanceTable(attendees, activity, timeZone, o) {
  const lastIn = new Map(), replaced = new Map();
  for (const r of activity) {
    if (r.kind === 'ok') lastIn.set(r.attendee_id, r);
    if (r.kind === 'new_badge') replaced.set(r.attendee_id, (replaced.get(r.attendee_id) || 0) + 1);
  }
  const head = ['First name', 'Last name', 'Email', 'Company', 'Ticket', 'Source', 'Checked in (date)', 'Checked in (time)',
    'Desk or door', 'Checked in by', 'Badge printed at', 'Badges replaced'];
  const rows = [];
  for (const a of attendees) {
    if (o.ticket && a.ticket_type !== o.ticket) continue;
    const arrived = !!a.checked_in_at;
    if (o.status === 'in' && !arrived) continue;
    if (o.status === 'out' && arrived) continue;
    const at = localParts(a.checked_in_at, timeZone);
    const how = arrived ? lastIn.get(a.id) : null;
    const place = how ? placeOf(how) : '';
    if (arrived) {
      if (o.day && at.date !== o.day) continue;
      if (!inWindow(at.time, o)) continue;
      if (o.place && place !== o.place) continue;
    } else if (o.day || o.place) continue;
    const pr = localParts(a.badge_printed_at, timeZone);
    rows.push([a.first_name, a.last_name, a.email || '', a.company || '', a.ticket_type, SOURCE[a.source] || a.source || '',
      at.date, at.time, place, (how && how.staff) || '', pr.date ? pr.date + ' ' + pr.time : '', replaced.get(a.id) || 0]);
  }
  return { head, rows };
}

export function activityTable(activity, timeZone, o) {
  const head = ['Date', 'Time', 'First name', 'Last name', 'Email', 'Company', 'Ticket', 'What happened', 'Desk or door', 'Staff'];
  const rows = [];
  const sorted = [...activity].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  for (const r of sorted) {
    if (o.what && (o.what === 'problems' ? !isProblem(r.kind) : !(GROUP[o.what] || []).includes(r.kind))) continue;
    if (o.ticket && r.ticket_type !== o.ticket) continue;
    const at = localParts(r.at, timeZone);
    if (o.day && at.date !== o.day) continue;
    if (!inWindow(at.time, o)) continue;
    const place = placeOf(r);
    if (o.place && place !== o.place) continue;
    rows.push([at.date, at.time, r.first_name || '', r.last_name || '', r.email || '', r.company || '', r.ticket_type || '',
      WHAT[r.kind] || r.kind, place, r.staff || '']);
  }
  return { head, rows };
}

export function exportOptions(attendees, activity, timeZone) {
  const days = new Set(), tickets = new Set(), places = new Set();
  for (const a of attendees) {
    if (a.ticket_type) tickets.add(a.ticket_type);
    if (a.checked_in_at) days.add(localParts(a.checked_in_at, timeZone).date);
  }
  for (const r of activity) {
    days.add(localParts(r.at, timeZone).date);
    const p = placeOf(r);
    if (p) places.add(p);
  }
  const by = (x, y) => x.localeCompare(y);
  return { days: [...days].sort(), tickets: [...tickets].sort(by), places: [...places].sort(by) };
}
