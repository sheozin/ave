// supabase/functions/_shared/net-guard.ts
// Addresses CueDeck must never call on someone else's behalf (the webhook
// sender, 126/127): anything that is not the public internet.
//
// IPv4: this network (0/8), private (10/8, 172.16/12, 192.168/16), carrier
// grade NAT (100.64/10), loopback (127/8), link-local and cloud metadata
// (169.254/16), IETF and documentation ranges (192.0.0/24, 192.0.2/24,
// 198.51.100/24, 203.0.113/24), benchmarking (198.18/15), multicast and
// reserved (224/3), 6to4 relay anycast (192.88.99/24).
// IPv6 is expanded to its eight groups first, so no spelling hides a range.
// IPv4-mapped (::ffff:a.b.c.d, in either form) and well-known NAT64
// (64:ff9b::/96) are judged by the IPv4 address they carry. Everything else
// must be global unicast (2000::/3): an allow-list, so a special range nobody
// listed is refused rather than called. Inside 2000::/3, 6to4 (2002::/16) is
// judged by its IPv4 address, and the IETF protocol block (2001::/23, which
// holds Teredo, benchmarking and ORCHID), documentation (2001:db8::/32,
// 3fff::/20) are refused.

function v4Private(p: number[]): boolean {
  const [a, b, c] = p
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
    || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)
    || a >= 224
}

function parseV4(s: string): number[] | null {
  const p = s.split('.')
  if (p.length !== 4) return null
  const n = p.map(x => (/^\d{1,3}$/.test(x) ? Number(x) : NaN))
  return n.every(x => Number.isInteger(x) && x >= 0 && x <= 255) ? n : null
}

// "2001:db8::1" -> eight 16-bit numbers; an embedded dotted IPv4 tail counts
// as the last two groups. Null for anything malformed.
function expandV6(s: string): number[] | null {
  let v = s.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0]
  let tail: number[] = []
  const dot = v.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/)
  if (dot) {
    const q = parseV4(dot[2]); if (!q) return null
    tail = [(q[0] << 8) | q[1], (q[2] << 8) | q[3]]
    v = dot[1].endsWith('::') ? dot[1] : dot[1].slice(0, -1)
  }
  const halves = v.split('::')
  if (halves.length > 2) return null
  const parse = (x: string) => (x === '' ? [] : x.split(':').map(h => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)))
  const head = parse(halves[0]), back = halves.length === 2 ? parse(halves[1]) : []
  const fixed = head.length + back.length + tail.length
  if ([...head, ...back].some(Number.isNaN) || fixed > 8 || (halves.length === 1 && fixed !== 8)) return null
  return [...head, ...Array(8 - fixed).fill(0), ...back, ...tail]
}

export function isPrivateIp(ip: string): boolean {
  const v4 = parseV4(ip)
  if (v4) return v4Private(v4)
  const g = expandV6(ip)
  if (!g) return true                                     // unparseable: never call it
  const fromLast32 = () => v4Private([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255])
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return fromLast32()  // ::ffff:a.b.c.d
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return fromLast32()  // NAT64
  if ((g[0] & 0xe000) !== 0x2000) return true             // not global unicast
  if (g[0] === 0x2002) return v4Private([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255])          // 6to4
  if (g[0] === 0x2001 && g[1] < 0x200) return true        // IETF protocol block, Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true     // documentation
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return true  // documentation 3fff::/20
  return false
}
