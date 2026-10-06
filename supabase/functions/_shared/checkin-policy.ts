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

// A wall-clock time ('HH:MM' or 'HH:MM:SS') on `ymd` in `timeZone`, as a
// UTC instant, by the same two-read method as zonedMidnightUtc. Null for
// an invalid date, time or zone. Used for the registration page's
// calendar entries.
export function zonedTimeUtc(ymd: string, hhmm: string, timeZone: string): Date | null {
  if (!isValidEventDate(ymd) || !isValidTimeZone(timeZone) || !/^\d{2}:\d{2}(:\d{2})?$/.test(hhmm)) return null
  const [y, m, d] = ymd.split('-').map(Number)
  const [hh, mm] = hhmm.split(':').map(Number)
  if (hh > 23 || mm > 59) return null
  const guess = Date.UTC(y, m - 1, d, hh, mm)
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

// Going live is pointless once the window has closed (or cannot be
// computed): nothing could be checked in. Mirrored in checkin-window.js.
export function isWindowClosed(eventDate: string, timeZone: string, now: Date = new Date()): boolean {
  const w = checkinWindow(eventDate, timeZone)
  return !w || now.getTime() >= w.closesAt.getTime()
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

// A routed check-in session is only marked paid when it was charged the
// configured price, once, in its currency. amount_subtotal is before tax
// and discounts, so automatic tax does not break the match.
export function checkinAmountMatches(
  session: { amount_subtotal?: unknown; currency?: unknown; total_details?: { amount_discount?: unknown } | null },
  price: { unit_amount?: unknown; currency?: unknown },
): boolean {
  if (typeof price.unit_amount !== 'number' || typeof price.currency !== 'string') return false
  // amount_subtotal is before discounts, so a discounted session would pass
  // the subtotal check while paying less. No discount is ever offered here.
  const discount = session.total_details?.amount_discount
  if (discount !== undefined && discount !== null && discount !== 0) return false
  return session.amount_subtotal === price.unit_amount * 1 && session.currency === price.currency
}

// Result of looking a payment intent up in leod_checkin_purchases. 'error'
// must fail the webhook delivery (Stripe retries); it is never "not ours".
export type PurchaseLookup =
  | { kind: 'checkin'; buyer_id: string | null; event_id: string | null }
  | { kind: 'not_checkin' }
  | { kind: 'error'; message: string }

export function classifyPurchaseLookup(
  res: { data: { buyer_id?: string | null; event_id?: string | null } | null; error: { message: string } | null },
): PurchaseLookup {
  if (res.error) return { kind: 'error', message: res.error.message }
  if (!res.data) return { kind: 'not_checkin' }
  return { kind: 'checkin', buyer_id: res.data.buyer_id ?? null, event_id: res.data.event_id ?? null }
}

function escapeHtml(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

// Plain HTML body for a billing alert email. Every value is escaped: details
// carry Stripe and metadata strings that a buyer can influence.
export function billingAlertEmailHtml(
  kind: string, userId: string | null, stripeObjectId: string | null, details: Record<string, unknown>,
): string {
  const rows: [string, unknown][] = [
    ['kind', kind], ['user_id', userId ?? '-'], ['stripe_object_id', stripeObjectId ?? '-'],
    ...Object.entries(details),
  ]
  const body = rows.map(([k, v]) =>
    `<tr><td style="padding:2px 12px 2px 0"><b>${escapeHtml(k)}</b></td><td>${escapeHtml(v ?? '-')}</td></tr>`).join('')
  return `<p>CueDeck billing alert: <b>${escapeHtml(kind)}</b></p><table>${body}</table>` +
    `<p>Recorded in leod_billing_alerts. Set resolved_at when handled.</p>`
}

// The subscription an invoice belongs to, across Stripe API versions. From
// 2025-03-31.basil (what the live CueDeck endpoint delivers) it sits at
// invoice.parent.subscription_details.subscription; older versions used
// invoice.subscription. Either may be an id or an expanded object.
// null means a one-off invoice (or malformed input); never throws.
export function invoiceSubscriptionId(invoice: unknown): string | null {
  const idOf = (v: unknown): string | null => {
    if (typeof v === 'string') return v.length > 0 ? v : null
    if (v && typeof v === 'object') {
      const id = (v as Record<string, unknown>).id
      return typeof id === 'string' && id.length > 0 ? id : null
    }
    return null
  }
  if (!invoice || typeof invoice !== 'object') return null
  const inv = invoice as Record<string, unknown>
  const parent = inv.parent
  if (parent && typeof parent === 'object') {
    const details = (parent as Record<string, unknown>).subscription_details
    if (details && typeof details === 'object') {
      const id = idOf((details as Record<string, unknown>).subscription)
      if (id) return id
    }
  }
  return idOf(inv.subscription)
}

// Unix seconds -> ISO string, or null when not a finite, representable time.
function unixToIso(v: unknown): string | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const d = new Date(v * 1000)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

// A subscription's current period, across Stripe API versions. From
// 2025-03-31.basil the top-level current_period_start/end are gone and live on
// items.data[i]; older versions have them top-level. Never throws.
export function subscriptionPeriod(sub: unknown): { start: string | null; end: string | null } {
  if (!sub || typeof sub !== 'object') return { start: null, end: null }
  const s = sub as Record<string, unknown>
  const items = s.items && typeof s.items === 'object' ? (s.items as Record<string, unknown>).data : undefined
  const first = Array.isArray(items) && items[0] && typeof items[0] === 'object'
    ? items[0] as Record<string, unknown>
    : {}
  return {
    start: unixToIso(s.current_period_start) ?? unixToIso(first.current_period_start),
    end: unixToIso(s.current_period_end) ?? unixToIso(first.current_period_end),
  }
}

// An invoice's tax in minor units, across Stripe API versions. basil replaced
// invoice.tax with total_taxes[] ({ amount, ... }). Never throws.
export function invoiceTaxAmount(inv: unknown): number {
  if (!inv || typeof inv !== 'object') return 0
  const i = inv as Record<string, unknown>
  if (Array.isArray(i.total_taxes)) {
    return i.total_taxes.reduce((sum: number, t: unknown) => {
      const a = t && typeof t === 'object' ? (t as Record<string, unknown>).amount : undefined
      return typeof a === 'number' && Number.isFinite(a) ? sum + a : sum
    }, 0)
  }
  return typeof i.tax === 'number' && Number.isFinite(i.tax) ? i.tax : 0
}
