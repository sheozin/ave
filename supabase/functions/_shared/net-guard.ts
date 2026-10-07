// supabase/functions/_shared/net-guard.ts
// Addresses CueDeck must never call on someone else's behalf: private,
// loopback, link-local (cloud metadata lives at 169.254.169.254), carrier
// grade NAT, multicast and reserved. Used by the webhook sender (126).
export function isPrivateIp(ip: string): boolean {
  const v = ip.toLowerCase()
  if (v.includes(':')) {
    if (v === '::1' || v === '::' ) return true
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true          // unique local, link-local
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return mapped ? isPrivateIp(mapped[1]) : false
  }
  const p = v.split('.').map(Number)
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true
  const [a, b] = p
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
}
