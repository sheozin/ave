// checkin-scanner.js: browser side of the door/session scanner (scanner
// Build A). The cooldown and token rules are a copy of
// supabase/functions/_shared/checkin-scanner.ts, kept equal by
// tests/checkin-scanner-policy.spec.ts; the verdict wording lives only here.
// Tested in tests/checkin-scanner-page.spec.ts.

export const COOLDOWN_MS = 4000;

export function shouldAccept(seen, token, now) {
  for (const [k, t] of seen) if (now - t >= COOLDOWN_MS) seen.delete(k);   // a Map, not a database write
  const last = seen.get(token);
  if (last !== undefined && now - last < COOLDOWN_MS) return false;
  seen.set(token, now);
  return true;
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
