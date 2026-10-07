// supabase/functions/_shared/net-guard.ts
// Addresses CueDeck must never call on someone else's behalf (the webhook
// sender, 126/127): anything that is not the public internet.
//
// IPv4: this network (0/8), private (10/8, 172.16/12, 192.168/16), carrier
// grade NAT (100.64/10), loopback (127/8), link-local and cloud metadata
// (169.254/16), IETF and documentation ranges (192.0.0/24, 192.0.2/24,
// 198.51.100/24, 203.0.113/24), benchmarking (198.18/15), multicast and
// reserved (224/3).
// IPv6 is expanded to its eight groups first, so no spelling hides a range:
// unspecified and loopback, IPv4-mapped (::ffff:a.b.c.d, in either form),
// IPv4-compatible (::a.b.c.d), NAT64 (64:ff9b::/96), 6to4 (2002::/16) and
// Teredo (2001::/32) are judged by the IPv4 address they carry or refused,
// plus unique local (fc00::/7), link-local (fe80::/10), site-local
// (fec0::/10), multicast (ff00::/8) and documentation (2001:db8::/32).

function v4Private(p: number[]): boolean {
  const [a, b, c] = p
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
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
  if (g.every(x => x === 0)) return true                  // ::
  if (g.slice(0, 7).every(x => x === 0) && g[7] === 1) return true            // ::1
  if (g.slice(0, 5).every(x => x === 0) && g[5] === 0xffff) return fromLast32()  // ::ffff:a.b.c.d
  if (g.slice(0, 6).every(x => x === 0)) return true      // ::a.b.c.d (deprecated)
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return fromLast32()  // NAT64
  if (g[0] === 0x2002) return v4Private([g[1] >> 8, g[1] & 255, g[2] >> 8, g[2] & 255])          // 6to4
  if (g[0] === 0x2001 && g[1] === 0) return true          // Teredo
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true     // documentation
  if ((g[0] & 0xfe00) === 0xfc00) return true             // unique local
  if ((g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0) return true  // link-local, site-local
  if ((g[0] & 0xff00) === 0xff00) return true             // multicast
  return false
}
