// checkin-scanner.js: browser side of the door/session scanner (scanner
// Build A). The cooldown and token rules are a copy of
// supabase/functions/_shared/checkin-scanner.ts, kept equal by
// tests/checkin-scanner-policy.spec.ts; the verdict wording lives only here.
// Tested in tests/checkin-scanner-page.spec.ts.

export const REARM_MS = 2500;

// Read once; not again until the code has been out of view for REARM_MS
// (every sighting refreshes it). See the server copy for why.
export function shouldAccept(seen, token, now) {
  for (const [k, t] of seen) if (now - t >= REARM_MS) seen.delete(k);
  const last = seen.get(token);
  seen.set(token, now);
  return last === undefined;
}

// Several codes in one frame (two guests, or a sheet of codes): read only
// the largest, the one held up to the camera. Field test 2026-10-06 checked
// two people in 170 ms apart from one frame.
export function pickCode(codes) {
  let best = null, bestArea = -1;
  for (const c of codes || []) {
    const b = c && c.boundingBox;
    const area = b ? (b.width || 0) * (b.height || 0) : 0;
    if (c && typeof c.rawValue === 'string' && area > bestArea) { best = c.rawValue; bestArea = area; }
  }
  return best;
}

// Sound per verdict tone: rising two notes for in, one middle note for
// already in, two low buzzes for stop; queued offline is quiet.
export function toneFor(tone) {
  switch (tone) {
    case 'ok':   return [{ hz: 880, ms: 110, wave: 'sine' }, { hz: 1320, ms: 170, wave: 'sine' }];
    case 'warn': return [{ hz: 660, ms: 220, wave: 'triangle' }];
    case 'stop': return [{ hz: 220, ms: 140, wave: 'square' }, { hz: 196, ms: 200, wave: 'square' }];
    default:     return [];
  }
}

export function normalizeToken(raw) {
  const t = String(raw ?? '').trim();
  return /^[A-Za-z0-9_-]{8,200}$/.test(t) ? t : null;
}

// What the phone shows. tone: ok (green), warn (amber), stop (red), wait
// (grey, offline). `who` is { first_name, ticket_type } when the server sent
// one (online, single scan); a scanner never holds names otherwise.
export function verdictFor(result, who) {
  const name = who && who.first_name ? who.first_name + (who.ticket_type ? ' · ' + who.ticket_type : '') : '';
  switch (result) {
    case 'ok':             return { tone: 'ok',   title: 'Checked in', text: name || 'Welcome in.' };
    case 'duplicate':      return { tone: 'warn', title: 'Already checked in', text: name ? name + '. Let them through if it is the same person.' : 'Let them through if it is the same person.' };
    case 'unknown_token':  return { tone: 'stop', title: 'Not on the list', text: 'Send them to the desk.' };
    case 'wrong_event':    return { tone: 'stop', title: 'Code for another event', text: 'Send them to the desk.' };
    case 'outside_window': return { tone: 'stop', title: 'Check-in is closed', text: 'Check-in is not open for this event right now. Ask the organizer.' };
    case 'test_cap':       return { tone: 'stop', title: 'Test check-ins used up', text: 'This event is in test mode. Ask the organizer to go live.' };
    case 'queued':         return { tone: 'wait', title: 'On the list', text: 'Offline: saved, and it will be sent when the connection is back.' };
    case 'not_listed':     return { tone: 'stop', title: 'Not on the list', text: 'This code is not on the guest list on this phone. Send them to the desk.' };
    default:               return { tone: 'stop', title: 'Could not check in', text: 'Try again, or send them to the desk.' };
  }
}

// The outbox holds what has not reached the server. A result other than
// 'error' is final (the server dedupes by client_id, so a resend is safe
// but never needed); 'error' items stay and are retried.
export function settle(outbox, results) {
  return (outbox || []).filter(it => !results || !(it.client_id in results) || results[it.client_id] === 'error');
}
