// checkin-window.js: browser copy of the live check-in window rule.
// Server copy: supabase/functions/_shared/checkin-policy.ts. The server
// decides; the pages use this only to explain and to refuse early.
// tests/checkin-window.spec.ts runs both copies over the same cases.

export const TEST_CAP = 25;

function tzOffsetMs(at, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at);
  const get = (t) => Number(parts.find(p => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// Midnight at the start of `ymd` in `timeZone`, as a UTC instant. The
// second offset read handles a DST change between UTC midnight and
// local midnight.
function zonedMidnightUtc(ymd, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const off1 = tzOffsetMs(new Date(guess), timeZone);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), timeZone);
  if (off2 !== off1) t = guess - off2;
  return new Date(t);
}

export function isValidEventDate(s) {
  if (typeof s !== 'string') return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const roundTrip = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
  return roundTrip === s;
}

export function isValidTimeZone(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s });
    return true;
  } catch {
    return false;
  }
}

// From the start of (date - 7) to the start of (date + 3), local time.
// Returns null if inputs are invalid.
export function checkinWindow(eventDate, timeZone) {
  if (!isValidEventDate(eventDate) || !isValidTimeZone(timeZone)) return null;
  return {
    opensAt: zonedMidnightUtc(addDays(eventDate, -7), timeZone),
    closesAt: zonedMidnightUtc(addDays(eventDate, 3), timeZone),
  };
}

export function isWithinWindow(scannedAtIso, eventDate, timeZone) {
  if (typeof scannedAtIso !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(scannedAtIso)) return false;
  const t = Date.parse(scannedAtIso);
  if (Number.isNaN(t)) return false;
  const w = checkinWindow(eventDate, timeZone);
  if (!w) return false;
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime();
}
