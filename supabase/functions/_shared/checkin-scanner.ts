// checkin-scanner.ts: rules for the roaming door/session scanner
// (spec docs/superpowers/specs/2026-08-18-checkin-scanner-device-design.md).
// Used by checkin-record-scans, checkin-scanner and checkin-kiosk-pair, and
// imported by the scanner page through /checkin-scanner.js (a copy kept
// equal by tests/checkin-scanner-policy.spec.ts). Plain TypeScript with no
// imports so vitest and the browser copy can load it.

export type ScanPointKind = 'entrance' | 'interior'

export interface ScanSettings {
  multi_point_scanning: boolean   // commercial: what the plan permits (admin-set)
  entrance_scanning: boolean      // operational: the organizer's choice for this event
  session_scanning: boolean
}

// Both gates must pass. An entrance scan is core check-in; scanning into
// sessions is the paid feature multi_point_scanning was created for. The
// refusal names the setting and says what to do: someone at a door needs
// to know whether to fetch the organizer or walk to the desk.
export function scanPointRefusal(kind: ScanPointKind, s: ScanSettings): string | null {
  if (kind === 'entrance') {
    return s.entrance_scanning ? null
      : 'Door scanning is switched off for this event. Ask the organizer to turn it on in Setup, or check people in at the desk.'
  }
  if (kind === 'interior') {
    if (!s.multi_point_scanning) return 'Session scanning is not included for this event. Check people in at the desk.'
    return s.session_scanning ? null
      : 'Session scanning is switched off for this event. Ask the organizer to turn it on in Setup.'
  }
  return 'This scan point has an unknown kind.'
}

// A continuous decoder reports the same code many times a second while it
// is in frame; without this one guest becomes dozens of scans.
export const COOLDOWN_MS = 4000

export function shouldAccept(seen: Map<string, number>, token: string, now: number): boolean {
  // Entries older than the cooldown can never block again: drop them so the
  // map stays small over a long day.
  for (const [k, t] of seen) if (now - t >= COOLDOWN_MS) seen.delete(k)   // a Map, not a database write
  const last = seen.get(token)
  if (last !== undefined && now - last < COOLDOWN_MS) return false
  seen.set(token, now)
  return true
}

// QR codes carry the bare token: URL-safe characters, 32 long today. A
// decoded string that is not shaped like one (a URL, a Wi-Fi code, a
// product barcode) is not sent anywhere.
export function normalizeToken(raw: string): string | null {
  const t = String(raw ?? '').trim()
  return /^[A-Za-z0-9_-]{8,200}$/.test(t) ? t : null
}
