// checkin-badge.js: one badge, drawn from an event's badge design
// (migration 111). Used by the check-in desk and kiosk to print, and by
// Event admin, Badges, for the live preview, so what the organizer sees is
// what comes out of the printer.
//
// Everything is sized in mm and pt, never px, so the same element is right
// on screen and on the label stock. Text is set with textContent only:
// attendee text comes from CSV imports and the public registration page.
// The QR code needs the global `qrcode` from /vendor/qrcode-generator-1.4.4.js
// (loaded as a classic script, so badges still print with the desk offline).

export const BADGE_SIZES = [
  { id: '100x70', w: 100, h: 70, label: '100 × 70 mm (label printers, default)' },
  { id: '102x76', w: 102, h: 76, label: '4 × 3 in (102 × 76 mm)' },
  { id: '90x55', w: 90, h: 55, label: '90 × 55 mm (business card)' },
  { id: '148x105', w: 148, h: 105, label: 'A6 (148 × 105 mm)' },
  { id: '102x152', w: 102, h: 152, label: '4 × 6 in portrait (102 × 152 mm)' },
];

export const BADGE_DEFAULT = Object.freeze({
  w: 100, h: 70, band: false, logo: false, name: 'full', company: true, ticket: true, qr: false, align: 'center', colors: {},
});

const HEX = /^#[0-9A-Fa-f]{6}$/;
const int = (v, lo, hi, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : d; };

// Whatever is stored (or nothing), as a design that is safe to draw.
export function normalizeDesign(d) {
  const x = d && typeof d === 'object' ? d : {};
  const colors = {};
  if (x.colors && typeof x.colors === 'object') {
    for (const [k, v] of Object.entries(x.colors).slice(0, 12)) {
      if (typeof k === 'string' && k.trim() && k.length <= 60 && HEX.test(String(v))) colors[k.trim()] = String(v).toUpperCase();
    }
  }
  return {
    w: int(x.w, 50, 200, BADGE_DEFAULT.w), h: int(x.h, 40, 200, BADGE_DEFAULT.h),
    band: x.band === true, logo: x.logo === true, name: x.name === 'split' ? 'split' : 'full',
    company: x.company !== false, ticket: x.ticket !== false, qr: x.qr === true,
    align: x.align === 'left' ? 'left' : 'center', colors,
  };
}

// The longest name that fits at full size grows with the stock width; past
// it the size scales down, to a floor below which the name wraps instead
// (a clipped surname on a badge worn all day is worse than smaller type).
export function namePt(text, d) {
  const usable = d.w - 12 - (d.qr && d.align === 'left' ? 22 : 0);
  const base = Math.max(22, Math.min(44, Math.round(30 * d.w / 100)));
  const fits = Math.max(8, Math.round(18 * usable / 88 * 30 / base));
  const n = String(text || '').trim().length;
  return n <= fits ? base : Math.max(14, Math.round(base * fits / n));
}

export function pageCss(d) {
  return `@page { size: ${d.w}mm ${d.h}mm; margin: 0; }`;
}

function qrSvg(doc, token, mm) {
  if (typeof globalThis.qrcode !== 'function' || !token) return null;
  const q = globalThis.qrcode(0, 'M'); q.addData(String(token)); q.make();
  const n = q.getModuleCount();
  const NS = 'http://www.w3.org/2000/svg';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('width', mm + 'mm'); svg.setAttribute('height', mm + 'mm');
  svg.setAttribute('shape-rendering', 'crispEdges');
  let p = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) p += `M${c} ${r}h1v1h-1z`;
  const path = doc.createElementNS(NS, 'path'); path.setAttribute('d', p); path.setAttribute('fill', '#000');
  svg.append(path);
  return svg;
}

const el = (doc, tag, css, text) => { const e = doc.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };

// One badge. attendee: { first_name, last_name, company, ticket_type, qr_token }.
// ctx: { design (normalized), brand (hex or null), logoUrl, test, doc }.
export function badgeElement(attendee, ctx) {
  const doc = ctx.doc || document;
  const d = ctx.design;
  const ticket = String(attendee.ticket_type || '').trim();
  const bandColor = d.colors[ticket] || (d.band ? (HEX.test(ctx.brand || '') ? ctx.brand : '#111111') : null);
  const left = d.align === 'left';
  // padding, align-items and justify-content are set here because the
  // desk's print stylesheet still styles .badge for the old fixed badge.
  const badge = el(doc, 'div', `width:${d.w}mm;height:${d.h}mm;box-sizing:border-box;position:relative;overflow:hidden;background:#fff;color:#111;`
    + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column;`
    + `padding:0;align-items:stretch;justify-content:flex-start;text-align:${d.align === 'left' ? 'left' : 'center'};`);
  badge.className = 'badge';
  if (bandColor) badge.append(el(doc, 'div', `height:${Math.max(4, Math.round(d.h * 0.08))}mm;background:${bandColor};flex:none;-webkit-print-color-adjust:exact;print-color-adjust:exact`));

  const body = el(doc, 'div', `flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;padding:3mm 6mm;`
    + `align-items:${left ? 'flex-start' : 'center'};text-align:${left ? 'left' : 'center'};${d.qr && left ? 'padding-right:26mm;' : ''}`);
  if (d.logo && ctx.logoUrl) {
    const img = el(doc, 'img', `max-height:${Math.round(d.h * 0.13)}mm;max-width:40mm;object-fit:contain;margin-bottom:2.5mm`);
    img.src = ctx.logoUrl; img.alt = '';
    body.append(img);
  }
  const first = String(attendee.first_name || '').trim(), last = String(attendee.last_name || '').trim();
  const nameCss = 'font-weight:700;letter-spacing:-0.5pt;line-height:1.05;overflow-wrap:anywhere;max-width:100%;';
  if (d.name === 'split') {
    body.append(el(doc, 'div', nameCss + `font-size:${namePt(first, d)}pt`, first));
    if (last) body.append(el(doc, 'div', `font-weight:600;line-height:1.1;overflow-wrap:anywhere;max-width:100%;margin-top:1mm;font-size:${Math.max(12, Math.round(namePt(first, d) * 0.55))}pt`, last));
  } else {
    const full = [first, last].filter(Boolean).join(' ');
    body.append(el(doc, 'div', nameCss + `font-size:${namePt(full, d)}pt`, full));
  }
  if (d.company && attendee.company) body.append(el(doc, 'div', 'font-size:13pt;margin-top:2.5mm;overflow-wrap:anywhere;max-width:100%;color:#333', attendee.company));
  if (d.ticket && ticket) body.append(el(doc, 'div', `font-size:10pt;font-weight:600;text-transform:uppercase;letter-spacing:1pt;margin-top:2mm;overflow-wrap:anywhere;max-width:100%;color:${d.colors[ticket] || '#555'}`, ticket));
  if (d.qr && !left) {
    const q = qrSvg(doc, attendee.qr_token, Math.min(18, Math.round(d.h * 0.24)));
    if (q) { q.style.marginTop = '2.5mm'; body.append(q); }
  }
  badge.append(body);
  if (d.qr && left) {
    const q = qrSvg(doc, attendee.qr_token, 20);
    if (q) { q.style.cssText = 'position:absolute;right:4mm;bottom:4mm'; badge.append(q); }
  }
  if (ctx.test) {
    badge.append(el(doc, 'div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:64pt;font-weight:900;'
      + 'letter-spacing:6pt;color:rgba(179,38,30,.28);transform:rotate(-18deg);pointer-events:none', 'TEST'));
  }
  return badge;
}
