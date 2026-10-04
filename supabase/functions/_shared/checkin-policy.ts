// supabase/functions/_shared/checkin-policy.ts
// Pure rules for check-in as a product: test cap, live check-in window,
// and which Stripe Checkout sessions belong to whom. Mirrored by
// tests/checkin-policy.spec.ts; keep the two in sync by hand.

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

// From the start of (date - 7) to the start of (date + 3), local time.
export function checkinWindow(eventDate: string, timeZone: string): { opensAt: Date; closesAt: Date } {
  return {
    opensAt: zonedMidnightUtc(addDays(eventDate, -7), timeZone),
    closesAt: zonedMidnightUtc(addDays(eventDate, 3), timeZone),
  }
}

export function isWithinWindow(scannedAtIso: string, eventDate: string, timeZone: string): boolean {
  const t = Date.parse(scannedAtIso)
  if (Number.isNaN(t)) return false
  const w = checkinWindow(eventDate, timeZone)
  return t >= w.opensAt.getTime() && t < w.closesAt.getTime()
}

export function routeCheckoutSession(
  s: { metadata?: Record<string, string> | null; payment_status?: string },
  lineItemProductIds: string[],
  checkinProductId: string,
): { route: 'checkin' | 'perevent' | 'ignore'; reason?: string } {
  const md = s.metadata || {}
  if (md.product === 'checkin') {
    if (!md.event_id || !md.buyer_id) return { route: 'ignore', reason: 'checkin session missing event_id or buyer_id' }
    if (!lineItemProductIds.includes(checkinProductId)) return { route: 'ignore', reason: 'checkin metadata but line item is not the check-in product' }
    if (s.payment_status !== 'paid') return { route: 'ignore', reason: `payment_status ${s.payment_status}` }
    return { route: 'checkin' }
  }
  if (md.plan === 'perevent') return { route: 'perevent' }
  return { route: 'ignore', reason: 'not a CueDeck check-in or Pay-per-Event session' }
}
