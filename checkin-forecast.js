// checkin-forecast.js: the staffing plan (Reports tab) and the plan line on
// the dashboard. Pure shaping. Inputs are the organizer's own numbers, or
// what really happened at their own past events (checkin_arrival_history,
// migration 153). Nothing here supplies a number of its own: with no
// history and no input, there is no plan. Tested in tests/checkin-forecast.spec.ts.

export const SLOT_MIN = 15;
export const SLOT_MS = SLOT_MIN * 60000;
export const HISTORY_MIN_CHECKINS = 30;   // a past event this small says little
export const SATURATED_MIN = 10;          // a desk's busiest slot below this was waiting for people, not busy
export const MAX_DESKS = 30;
export const MAX_WAIT_MIN = 5;
const SHAPE_SLOTS = 32;                   // eight hours either side of the start

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// From past events: when people arrived (share of each event's arrivals per
// slot from the start, averaged over events), how many came, and how long a
// guest took at a busy desk. Each part is null when the history cannot say.
export function historyProfile(rows) {
  const used = (rows || []).filter(r => r.checked_in >= HISTORY_MIN_CHECKINS && r.registered > 0);
  if (!used.length) return null;
  const share = new Map();
  for (const r of used) {
    for (const b of r.buckets || []) {
      if (b.o < -SHAPE_SLOTS || b.o > SHAPE_SLOTS) continue;
      share.set(b.o, (share.get(b.o) || 0) + b.n / r.checked_in / used.length);
    }
  }
  const turnout = Math.round(100 * used.reduce((a, r) => a + r.checked_in, 0) / used.reduce((a, r) => a + r.registered, 0));
  const busy = used.flatMap(r => (r.desk_busiest || []).filter(n => n >= SATURATED_MIN));
  return {
    events: used.map(r => ({ name: r.name, date: r.date })),
    turnoutPct: Math.min(100, Math.max(1, turnout)),
    secondsPerGuest: busy.length ? Math.round(median(busy.map(n => (SLOT_MIN * 60) / n))) : null,
    shape: share.size ? [...share.entries()].sort((a, b) => a[0] - b[0]).map(([o, s]) => [o, Math.round(s * 10000) / 10000]) : null,
  };
}

// Expected arrivals per slot. With a shape, the slots it covers; without,
// spread evenly over the window the organizer gave.
export function expectedSlots({ registered, turnoutPct, beforeMin, afterMin, shape, startMs }) {
  const total = (registered * turnoutPct) / 100;
  if (!(total > 0) || !Number.isFinite(startMs)) return [];
  if (shape && shape.length) {
    const by = new Map(shape.map(([o, s]) => [o, s]));
    const lo = Math.min(...by.keys()), hi = Math.max(...by.keys());
    const out = [];
    for (let o = lo; o <= hi; o++) out.push({ t: startMs + o * SLOT_MS, expected: total * (by.get(o) || 0) });
    return out;
  }
  const from = -Math.ceil(beforeMin / SLOT_MIN), to = Math.ceil(afterMin / SLOT_MIN);
  const n = to - from;
  if (n <= 0) return [];
  return Array.from({ length: n }, (_, i) => ({ t: startMs + (from + i) * SLOT_MS, expected: total / n }));
}

// Fewest desks per slot that keep the wait under maxWait minutes, carrying
// any line left at the end of a slot into the next. A slot nobody is
// expected in, with no line, needs no desk. A desk once opened stays open
// for at least two slots: staffing a desk for 15 minutes is not a plan.
export function staffSlots(slots, secondsPerGuest, maxWait = MAX_WAIT_MIN) {
  const perDeskMin = 60 / secondsPerGuest;
  const leftWith = (line, s, d) => Math.max(0, line + s.expected - d * perDeskMin * SLOT_MIN);
  let line = 0, prevNeed = 0;
  return slots.map(s => {
    let need = 0, over = false;
    if (line + s.expected > 0.5) {
      for (need = 1; leftWith(line, s, need) / (need * perDeskMin) > maxWait; need++) {
        if (need === MAX_DESKS) { over = true; break; }
      }
    }
    const desks = need ? Math.max(need, prevNeed) : 0;
    const left = desks ? leftWith(line, s, desks) : 0;
    prevNeed = need; line = left;
    return { ...s, desks, waitMin: desks ? left / (desks * perDeskMin) : 0, over };
  });
}

function clock(ms, timeZone) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(new Date(ms));
}
const deskWord = (n) => n + (n === 1 ? ' desk' : ' desks');

// The plan in a few lines: open, each change in desks, and when arrivals end.
export function planAdvice(staffed, timeZone) {
  const out = [];
  let prev = 0;
  for (let i = 0; i < staffed.length; i++) {
    const s = staffed[i];
    if (s.desks === prev) continue;
    let j = i; while (j + 1 < staffed.length && staffed[j + 1].desks === s.desks) j++;
    const run = staffed.slice(i, j + 1);
    const peak = run.reduce((a, b) => (b.expected > a.expected ? b : a));
    const even = run.every(x => Math.abs(x.expected - peak.expected) < 0.5);
    const busiest = even && run.length > 1 ? 'About ' + Math.round(peak.expected) + ' guests every 15 minutes.'
      : 'Busiest 15 minutes from ' + clock(peak.t, timeZone) + ': about ' + Math.round(peak.expected) + ' guests.';
    if (prev === 0 && s.desks > 0) {
      out.push({ t: s.t, tone: 'ok', title: 'Open with ' + deskWord(s.desks), detail: busiest });
    } else if (s.desks > prev) {
      out.push({ t: s.t, tone: 'warn', title: 'Open ' + (s.desks - prev) + ' more, ' + deskWord(s.desks) + ' in all', detail: busiest });
    } else if (s.desks > 0) {
      out.push({ t: s.t, tone: 'ok', title: 'Down to ' + deskWord(s.desks), detail: busiest });
    } else {
      const next = staffed.slice(i).find(x => x.desks > 0);
      out.push(next
        ? { t: s.t, tone: 'ok', title: 'Close the desks for now', detail: 'The line should be clear. The next guests are expected from ' + clock(next.t, timeZone) + '.' }
        : { t: s.t, tone: 'ok', title: 'Arrivals end', detail: 'The plan expects everyone by ' + clock(s.t, timeZone) + '.' });
    }
    prev = s.desks;
  }
  if (staffed.length && prev > 0) {
    const end = staffed[staffed.length - 1].t + SLOT_MS;
    out.push({ t: end, tone: 'ok', title: 'Arrivals end', detail: 'The plan expects everyone by ' + clock(end, timeZone) + '.' });
  }
  if (staffed.some(s => s.over)) {
    out.unshift({ t: staffed.find(s => s.over).t, tone: 'warn', title: 'More than ' + MAX_DESKS + ' desks needed', detail: 'Even ' + MAX_DESKS + ' desks leave a line over ' + MAX_WAIT_MIN + ' minutes. Spread arrivals, add kiosks, or check the numbers.' });
  }
  return out;
}

// The whole plan from saved inputs (or the form).
export function buildPlan(plan, registered, startMs, timeZone) {
  if (!plan || !(registered > 0)) return null;
  const slots = expectedSlots({ registered, turnoutPct: plan.turnout_pct, beforeMin: plan.before_min, afterMin: plan.after_min, shape: plan.shape, startMs });
  if (!slots.length) return null;
  const staffed = staffSlots(slots, plan.seconds_per_guest);
  return {
    staffed,
    expectedTotal: Math.round((registered * plan.turnout_pct) / 100),
    peakDesks: Math.max(...staffed.map(s => s.desks)),
    advice: planAdvice(staffed, timeZone),
  };
}

// Dashboard: the plan per 15-minute bar next to real arrivals. Arrival
// buckets are epoch seconds on the 15-minute grid (checkin_event_stats), so
// plan slots are snapped to the same grid. Also the plan against reality
// over the slots that have ended (a slot in progress would read as behind).
export function planVsActual(staffed, arrivals, nowMs, timeZone) {
  const real = new Map((arrivals || []).map(b => [b.t * 1000, b.n]));
  const planned = new Map();
  for (const s of staffed) {
    const k = Math.floor(s.t / SLOT_MS) * SLOT_MS;
    planned.set(k, (planned.get(k) || 0) + s.expected);
  }
  const keys = [...new Set([...planned.keys(), ...real.keys()])].sort((a, b) => a - b);
  if (!keys.length) return null;
  const lo = keys[0], hi = keys[keys.length - 1];
  const labels = [], plan = [], actual = [];
  let expectedByNow = 0, arrivedByNow = 0;
  for (let k = lo; k <= hi; k += SLOT_MS) {
    labels.push(clock(k, timeZone));
    plan.push(Math.round((planned.get(k) || 0) * 10) / 10);
    actual.push(k <= nowMs ? (real.get(k) || 0) : null);
    if (k + SLOT_MS <= nowMs) expectedByNow += planned.get(k) || 0;
    if (k + SLOT_MS <= nowMs) arrivedByNow += real.get(k) || 0;
  }
  return { labels, plan, actual, expectedByNow: Math.round(expectedByNow), arrivedByNow };
}
