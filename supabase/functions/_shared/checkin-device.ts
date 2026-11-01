// checkin-device.ts: authenticate a paired device by its key. Used by the
// scanner paths (checkin-record-scans, checkin-scanner). The hashing
// scheme and its reasoning are in checkin-self-register (unsalted SHA-256
// of a 256-bit random key, looked up through 048's UNIQUE index); this is
// the same scheme, with the lookup error read rather than treated as a bad
// key, so a database fault is a 500 and not a silent 401.

// deno-lint-ignore no-explicit-any
type Client = any

export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export interface PairedDevice { id: string; scan_point_id: string | null }

export type DeviceAuth =
  | { ok: true; device: PairedDevice }
  | { ok: false; status: number; error: string }

export async function authDevice(sb: Client, eventId: string, deviceKey: string, kind: 'scanner' | 'kiosk' | 'printer'): Promise<DeviceAuth> {
  if (!deviceKey || deviceKey.length < 32 || deviceKey.length > 200) return { ok: false, status: 401, error: 'Unauthorized device' }
  const { data: device, error } = await sb.from('leod_checkin_devices')
    .select('id, event_id, kind, scan_point_id, revoked_at')
    .eq('api_key_hash', await sha256Hex(deviceKey))
    .maybeSingle()
  if (error) return { ok: false, status: 500, error: 'Device lookup failed' }
  // A revoked key never comes back (057's one-way trigger): pair again.
  if (!device || device.event_id !== eventId || device.kind !== kind || device.revoked_at) {
    return { ok: false, status: 401, error: 'Unauthorized device' }
  }
  // Best effort: the dashboard shows when a device was last heard from;
  // a failed stamp must not cost the scan.
  const { error: seenErr } = await sb.from('leod_checkin_devices')
    .update({ last_seen_at: new Date().toISOString() }).eq('id', device.id)
  if (seenErr) console.warn('checkin-device: last_seen_at not updated', seenErr.message)
  return { ok: true, device: { id: device.id, scan_point_id: device.scan_point_id } }
}

// What a print station says it drives. Only known keys, short strings, so a
// station cannot put anything else into a row desks read.
// lan: where desks on the venue network reach a paired station when the
// internet is down (print-helper/station-core.mjs listenLan). Only from the
// paired station itself (checkin-print-station), never from a pairing
// request, and only a private IPv4, so a desk is never sent elsewhere.
const PRIVATE_V4 = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}$/
export function printerInfo(v: unknown, { lan = false } = {}): Record<string, unknown> | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const l = o.lan as Record<string, unknown> | undefined
  if (lan && l && typeof l === 'object' && typeof l.host === 'string' && PRIVATE_V4.test(l.host) &&
      Number.isInteger(l.port) && (l.port as number) >= 1024 && (l.port as number) <= 65535 &&
      typeof l.token === 'string' && /^[0-9a-f]{32}$/.test(l.token)) {
    out.lan = { host: l.host, port: l.port, token: l.token }
  }
  if (o.model === 'brother-ql' || o.model === 'zebra') out.model = o.model
  if (typeof o.name === 'string') out.name = o.name.slice(0, 80)
  if (typeof o.host === 'string' && /^[0-9a-zA-Z.:-]{1,64}$/.test(o.host)) out.host = o.host
  for (const k of ['dpi', 'width_mm']) { const n = Number(o[k]); if (Number.isFinite(n) && n > 0 && n < 1000) out[k] = Math.round(n) }
  return Object.keys(out).length ? out : null
}
