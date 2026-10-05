// checkin-clock.js: the desk's clock correction. Every check-in and undo
// carries scanned_at from the desk, and the server refuses a live check-in
// stamped more than 5 minutes ahead of its own clock, so a desk whose clock
// runs fast would be refused all day. The desk reads the server's now()
// (checkin_server_now, migration 093) a few times and keeps the offset of
// the fastest round trip, as the console's syncClock does.
// Tested in tests/checkin-clock.spec.ts.

const MAX_TRUSTED_RTT_MS = 10000;

// samples: [{ sentAt, receivedAt, serverMs }], device times in ms. The
// server read its clock somewhere inside the round trip; the midpoint is
// the best guess, so the error is at most half the round trip.
export function bestOffset(samples) {
  let best = null;
  for (const s of samples || []) {
    const rtt = s.receivedAt - s.sentAt;
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > MAX_TRUSTED_RTT_MS || !Number.isFinite(s.serverMs)) continue;
    if (!best || rtt < best.rttMs) best = { offsetMs: s.serverMs - (s.sentAt + rtt / 2), rttMs: rtt };
  }
  return best;
}

// Canonical UTC ISO (the outbox compares these as strings). No offset yet
// means the device clock, which is what the desk did before this module.
export function correctedIso(deviceMs, offsetMs) {
  return new Date(deviceMs + (Number.isFinite(offsetMs) ? offsetMs : 0)).toISOString();
}

const unit = (n, one) => n + ' ' + one + (n === 1 ? '' : 's');

// offsetMs = server minus device: positive means the device is slow.
export function skewNotice(offsetMs) {
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) < 60000) return '';
  const mins = Math.round(Math.abs(offsetMs) / 60000);
  const h = Math.floor(mins / 60), m = mins % 60;
  const size = h ? unit(h, 'hour') + (m ? ' ' + unit(m, 'minute') : '') : unit(m, 'minute');
  return "This device's clock is " + size + (offsetMs > 0 ? ' slow' : ' fast') + ". Check-in times use the server's clock instead.";
}
