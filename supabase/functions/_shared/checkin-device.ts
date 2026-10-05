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

export async function authDevice(sb: Client, eventId: string, deviceKey: string, kind: 'scanner' | 'kiosk'): Promise<DeviceAuth> {
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
