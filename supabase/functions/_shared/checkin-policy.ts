// supabase/functions/_shared/checkin-policy.ts
// Pure rules for check-in as a product: test cap, live check-in window,
// and which Stripe Checkout sessions belong to whom. Tests import this
// module directly (tests/checkin-policy.spec.ts).

export const TEST_CAP = 25

function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const get = (t: string) => Number(parts.find(p => p.type === t)!.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

// Midnight at the start of `ymd` in `timeZone`, as a UTC instant. The
// second offset read handles a DST change between UTC midnight and
// local midnight.
function zonedMidnightUtc(ymd: string, timeZone: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const off1 = tzOffsetMs(new Date(guess), timeZone)
  let t = guess - off1
  const off2 = tzOffsetMs(new Date(t), timeZone)
  if (off2 !== off1) t = guess - off2
  return new Date(t)
}

export function isValidEventDate(s: unknown): s is string {
  if (typeof s !== 'string') return false
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  // Validate by round-trip: parse and re-serialize
  const [y, m, d] = s.split('-').map(Number)
  const roundTrip = new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10)
  return roundTrip === s
}

export function isValidTimeZone(s: unknown): s is string {
  if (typeof s !== 'string' || s.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s })
    return true
  } catch {
    return false
  }
}

// From the start of (date - 7) to the start of (date + 3), local time.
// Returns null if inputs are invalid.
export function checkinWindow(eventDate: string, timeZone: string): { opensAt: Date; closesAt: Date } | null {
  if (!isValidEventDate(eventDate) || !isValidTimeZone(timeZone)) return null
  return {
    opensAt: zonedMidnightUtc(addDays(eventDate, -7), timeZone),
    closesAt: zonedMidnightUtc(addDays(eventDate, 3), timeZone),
  }
}

export function isWithinWindow(scannedAtIso: string, eventDate: string, timeZone: string): boolean {
  // Validate ISO string format: must have timezone
  if (typeof scannedAtIso !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(scannedAtIso)) return false
  const t = Date.parse(scannedAtIso)
  if (Number.isNaN(t)) return false
  const w = checkinWindow(eventDate, timeZone)
  if (!w) return false
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime()
}

export function routeCheckoutSession(
  s: unknown,
  lineItemProductIds: unknown,
  checkinProductId: string,
  pereventProductId: string,
): { route: 'checkin' | 'perevent' | 'ignore'; reason?: string } {
  // Validate basic structure
  if (!s || typeof s !== 'object' || !Array.isArray(lineItemProductIds)) {
    return { route: 'ignore', reason: 'malformed session' }
  }
  const session = s as Record<string, unknown>
  const md = (session.metadata || {}) as Record<string, unknown>

  if (md.product === 'checkin') {
    // Stricter check-in validation
    if (typeof checkinProductId !== 'string' || checkinProductId.length === 0) {
      return { route: 'ignore', reason: 'malformed session' }
    }
    if (lineItemProductIds.length !== 1 || lineItemProductIds[0] !== checkinProductId) {
      return { route: 'ignore', reason: 'checkin metadata but line item is not the check-in product' }
    }
    const eventId = typeof md.event_id === 'string' ? md.event_id.trim() : ''
    const buyerId = typeof md.buyer_id === 'string' ? md.buyer_id.trim() : ''
    if (!eventId || !buyerId) {
      return { route: 'ignore', reason: 'checkin session missing event_id or buyer_id' }
    }
    if (session.payment_status !== 'paid') {
      return { route: 'ignore', reason: `payment_status ${session.payment_status}` }
    }
    return { route: 'checkin' }
  }

  if (md.plan === 'perevent') {
    // Stricter perevent validation
    if (session.payment_status !== 'paid') {
      return { route: 'ignore', reason: `payment_status ${session.payment_status}` }
    }
    if (typeof pereventProductId !== 'string' || pereventProductId.length === 0) {
      return { route: 'ignore', reason: 'malformed session' }
    }
    if (!lineItemProductIds.includes(pereventProductId)) {
      return { route: 'ignore', reason: 'perevent metadata but line item is not the pay-per-event product' }
    }
    return { route: 'perevent' }
  }

  return { route: 'ignore', reason: 'not a CueDeck check-in or Pay-per-Event session' }
}
