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

// Real stock, grouped the way people buy it. `hint` says what it fits.
export const BADGE_SIZES = [
  { id: '100x70', w: 100, h: 70, group: 'label', label: '100 × 70 mm (default)', hint: 'Fits most label printers.' },
  { id: '102x76', w: 102, h: 76, group: 'label', label: '4 × 3 in (102 × 76 mm)', hint: 'The most common event badge. Zebra fanfold stock and standard 4 × 3 holders.' },
  { id: '76x102', w: 76, h: 102, group: 'label', label: '3 × 4 in portrait (76 × 102 mm)', hint: '4 × 3 stock worn upright.' },
  { id: '102x127', w: 102, h: 127, group: 'label', label: '4 × 5 in (102 × 127 mm)', hint: 'Zebra stock with room for a logo and QR code.' },
  { id: '102x152', w: 102, h: 152, group: 'label', label: '4 × 6 in portrait (102 × 152 mm)', hint: 'Large passes with room for sponsors.' },
  { id: '100x62', w: 100, h: 62, group: 'label', label: 'Brother DK-1202 (100 × 62 mm)', hint: 'Peel-and-stick labels for Brother QL printers. No holder needed.' },
  { id: '102x57', w: 102, h: 57, group: 'label', label: 'Dymo 30857 (102 × 57 mm)', hint: 'Peel-and-stick labels for Dymo LabelWriter.' },
  { id: '148x105', w: 148, h: 105, group: 'insert', label: 'A6 landscape (148 × 105 mm)', hint: 'European delegate pass in an A6 holder.' },
  { id: '105x148', w: 105, h: 148, group: 'insert', label: 'A6 portrait (105 × 148 mm)', hint: 'European delegate pass in an A6 holder.' },
  { id: '105x74', w: 105, h: 74, group: 'insert', label: 'A7 landscape (105 × 74 mm)', hint: 'Compact pass in an A7 holder.' },
  { id: '74x105', w: 74, h: 105, group: 'insert', label: 'A7 portrait (74 × 105 mm)', hint: 'Compact pass in an A7 holder.' },
  { id: '90x55', w: 90, h: 55, group: 'insert', label: '90 × 55 mm (business card)', hint: 'Business card pockets and Avery L4727 style inserts.' },
  { id: '86x54', w: 86, h: 54, group: 'insert', label: 'ID card, CR80 (86 × 54 mm)', hint: 'PVC card printers and card holders.' },
];
export const BADGE_GROUPS = { label: 'Label and badge printers', insert: 'Holder inserts and cards' };

// Fixed client templates. A template draws the whole badge itself and
// ignores the design options below; one is picked per event.
export const BADGE_TEMPLATES = [
  { id: 'visa-next-full', w: 76, h: 62, label: 'Full badge zone 62x76 (name + company)',
    hint: 'Brother QL-820NWB on a DK-22205 62 mm roll, cut at 76 mm. Black on white, no QR code. In the printer settings pick 62 mm x 76 mm paper.' },
];

// Where the lanyard goes. Text stays out of this band at the top.
export const SLOT_MM = 10;

export const BADGE_DEFAULT = Object.freeze({
  template: null, w: 100, h: 70, band: false, logo: false, name: 'full', company: true, title: false, ticket: true, qr: false, align: 'center', slot: 'none', colors: {}, tags: {},
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
  const tags = {};
  if (x.tags && typeof x.tags === 'object') {
    for (const [k, v] of Object.entries(x.tags).slice(0, 12)) {
      const t = typeof v === 'string' ? v.trim() : '';
      if (typeof k === 'string' && k.trim() && k.length <= 60 && t && t.length <= 24) tags[k.trim()] = t;
    }
  }
  const tpl = BADGE_TEMPLATES.find(t => t.id === x.template);
  return {
    template: tpl ? tpl.id : null,
    w: tpl ? tpl.w : int(x.w, 50, 200, BADGE_DEFAULT.w), h: tpl ? tpl.h : int(x.h, 40, 200, BADGE_DEFAULT.h),
    band: x.band === true, logo: x.logo === true, name: x.name === 'split' ? 'split' : 'full',
    company: x.company !== false, title: x.title === true, ticket: x.ticket !== false, qr: x.qr === true,
    align: x.align === 'left' ? 'left' : 'center', slot: x.slot === 'slot' || x.slot === 'holes' ? x.slot : 'none', colors, tags,
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

// Black or white, whichever reads better on the ribbon colour.
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#111111' : '#FFFFFF';
}

const el = (doc, tag, css, text) => { const e = doc.createElement(tag); if (css) e.style.cssText = css; if (text != null) e.textContent = text; return e; };

// One badge. attendee: { first_name, last_name, company, role_title, ticket_type, qr_token }.
// ctx: { design (normalized), brand (hex or null), logoUrl, test, doc, preview }.
// preview draws the lanyard slot as a guide; it is never printed.
export function badgeElement(attendee, ctx) {
  const doc = ctx.doc || document;
  const d = ctx.design;
  if (d.template === 'visa-next-full') return visaNextElement(attendee, ctx, doc);
  const ticket = String(attendee.ticket_type || '').trim();
  const bandColor = d.colors[ticket] || (d.band ? (HEX.test(ctx.brand || '') ? ctx.brand : '#111111') : null);
  const left = d.align === 'left';
  // padding, align-items and justify-content are set here because the
  // desk's print stylesheet still styles .badge for the old fixed badge.
  const badge = el(doc, 'div', `width:${d.w}mm;height:${d.h}mm;box-sizing:border-box;position:relative;overflow:hidden;background:#fff;color:#111;`
    + `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;display:flex;flex-direction:column;`
    + `padding:0;align-items:stretch;justify-content:flex-start;text-align:${d.align === 'left' ? 'left' : 'center'};`);
  badge.className = 'badge';
  const bandMm = bandColor ? Math.max(4, Math.round(d.h * 0.08)) : 0;
  if (bandColor) badge.append(el(doc, 'div', `height:${bandMm}mm;background:${bandColor};flex:none;-webkit-print-color-adjust:exact;print-color-adjust:exact`));
  // A delegate tag: a ribbon across the bottom in the ticket type's colour.
  const tag = d.tags[ticket] || '';
  const ribbonMm = tag ? Math.max(7, Math.round(d.h * 0.13)) : 0;
  const ribbonBg = d.colors[ticket] || '#111111';
  const topPad = d.slot === 'none' ? 3 : Math.max(3, SLOT_MM - bandMm);

  const body = el(doc, 'div', `flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center;padding:${topPad}mm 6mm 3mm;`
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
  const title = String(attendee.role_title || '').trim();
  if (d.title && title) body.append(el(doc, 'div', 'font-size:12pt;margin-top:1.5mm;overflow-wrap:anywhere;max-width:100%;color:#444', title));
  if (d.company && attendee.company) body.append(el(doc, 'div', 'font-size:13pt;margin-top:2.5mm;overflow-wrap:anywhere;max-width:100%;color:#333', attendee.company));
  if (d.ticket && ticket && !tag) body.append(el(doc, 'div', `font-size:10pt;font-weight:600;text-transform:uppercase;letter-spacing:1pt;margin-top:2mm;overflow-wrap:anywhere;max-width:100%;color:${d.colors[ticket] || '#555'}`, ticket));
  if (d.qr && !left) {
    const q = qrSvg(doc, attendee.qr_token, Math.min(18, Math.round(d.h * 0.24)));
    if (q) { q.style.marginTop = '2.5mm'; body.append(q); }
  }
  badge.append(body);
  if (tag) {
    badge.append(el(doc, 'div', `height:${ribbonMm}mm;flex:none;display:flex;align-items:center;justify-content:center;padding:0 4mm;`
      + `background:${ribbonBg};color:${inkOn(ribbonBg)};font-weight:800;text-transform:uppercase;letter-spacing:1.5pt;`
      + `font-size:${Math.min(16, Math.round(ribbonMm * 1.5))}pt;white-space:nowrap;overflow:hidden;-webkit-print-color-adjust:exact;print-color-adjust:exact`, tag));
  }
  if (d.qr && left) {
    const q = qrSvg(doc, attendee.qr_token, 20);
    if (q) { q.style.cssText = `position:absolute;right:4mm;bottom:${4 + ribbonMm}mm`; badge.append(q); }
  }
  if (ctx.preview && d.slot !== 'none') {
    const guide = 'position:absolute;top:3mm;border:0.3mm dashed #888;background:rgba(0,0,0,.06);pointer-events:none;';
    if (d.slot === 'slot') badge.append(el(doc, 'div', guide + 'left:50%;width:14mm;height:3.5mm;margin-left:-7mm;border-radius:2mm'));
    else for (const x of [35, 65]) badge.append(el(doc, 'div', guide + `left:${x}%;width:4.5mm;height:4.5mm;margin-left:-2.25mm;border-radius:50%`));
  }
  if (ctx.test) {
    badge.append(el(doc, 'div', 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:64pt;font-weight:900;'
      + 'letter-spacing:6pt;color:rgba(179,38,30,.28);transform:rotate(-18deg);pointer-events:none', 'TEST'));
  }
  return badge;
}

// ── visa-next-full ──────────────────────────────────────────────────────
// A 300 dpi bitmap of the printable 62 mm roll width (696 px = 58.9 mm)
// by the 76 mm cut length (898 px), drawn on a canvas and printed as an
// image at exactly that size, so the sample PNG and the print are the same
// pixels. Montserrat is bundled (/vendor/fonts), never fetched from a CDN,
// so Polish letters render and the desk prints with the venue Wi-Fi down.
export const VISA_NEXT_PX = { w: 898, h: 696 };
const FONT_URL = '/vendor/fonts/montserrat-latin-ext.woff2';
let fontsLoading = null;

// Call once before printing; the preview redraws when it resolves.
export function loadBadgeFonts(doc = document) {
  if (!fontsLoading) {
    const face = new FontFace('Montserrat', `url(${FONT_URL}) format('woff2')`, { weight: '100 900' });
    doc.fonts.add(face);
    fontsLoading = face.load().then(() => true, (e) => { fontsLoading = null; throw e; });
  }
  return fontsLoading;
}

const fontsReady = (doc) => doc.fonts && doc.fonts.check('800 40px Montserrat', 'Ł');

// Largest size from `start` down to `min` (step 2 px) at which `text` fits
// `maxW`; `fits` is false when even `min` is too wide.
function fitPx(ctx, text, weight, start, min, maxW) {
  let size = start;
  for (; size >= min; size -= 2) {
    ctx.font = `${weight} ${size}px Montserrat`;
    if (ctx.measureText(text).width <= maxW) return { size, fits: true };
  }
  return { size: min, fits: false };
}

// Two halves of a surname, split at the space or hyphen nearest the middle.
function splitSurname(text) {
  const cuts = [];
  for (let i = 1; i < text.length - 1; i++) if (text[i] === ' ' || text[i] === '-') cuts.push(i);
  if (!cuts.length) return null;
  const mid = text.length / 2;
  const i = cuts.reduce((a, b) => Math.abs(b - mid) < Math.abs(a - mid) ? b : a);
  return text[i] === '-' ? [text.slice(0, i + 1), text.slice(i + 1)] : [text.slice(0, i), text.slice(i + 1)];
}

export function visaNextCanvas(attendee, doc = document, { test = false } = {}) {
  const { w: W, h: H } = VISA_NEXT_PX;
  const c = doc.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
  g.fillStyle = '#000'; g.textAlign = 'center'; g.textBaseline = 'alphabetic';

  let first = String(attendee.first_name || '').trim().replace(/\s+/g, ' ').toUpperCase();
  let last = String(attendee.last_name || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if (!last) { last = first; first = ''; }
  const company = String(attendee.company || '').trim().replace(/\s+/g, ' ');

  const nameW = W - 60;
  const lines = [];   // { text, weight, size }
  if (first) lines.push({ text: first, weight: 300, size: fitPx(g, first, 300, 110, 40, nameW).size });
  const sur = fitPx(g, last, 800, 200, 40, nameW);
  const halves = sur.fits ? null : splitSurname(last);
  if (halves) {
    // Below 40 px on one line: two lines, at the size both halves fit.
    const a = fitPx(g, halves[0], 800, 200, 20, nameW), b = fitPx(g, halves[1], 800, 200, 20, nameW);
    const size = Math.min(a.size, b.size);
    lines.push({ text: halves[0], weight: 800, size }, { text: halves[1], weight: 800, size });
  } else {
    // One unbreakable word: shrink past 40 px rather than clip it.
    lines.push({ text: last, weight: 800, size: sur.fits ? sur.size : fitPx(g, last, 800, 40, 12, nameW).size });
  }
  for (const l of lines) {
    g.font = `${l.weight} ${l.size}px Montserrat`;
    const m = g.measureText(l.text);
    l.asc = m.actualBoundingBoxAscent; l.desc = m.actualBoundingBoxDescent;
  }
  const GAP = 20;
  const blockH = lines.reduce((t, l) => t + l.asc + l.desc, 0) + GAP * (lines.length - 1);
  const [zTop, zBot] = company ? [0, 355] : [0, H];
  let y = zTop + (zBot - zTop - blockH) / 2;
  for (const l of lines) {
    g.font = `${l.weight} ${l.size}px Montserrat`;
    g.fillText(l.text, W / 2, y + l.asc);
    y += l.asc + l.desc + GAP;
  }

  if (company) {
    const cs = fitPx(g, company, 600, 110, 12, W - 140).size;
    g.font = `600 ${cs}px Montserrat`;
    const m = g.measureText(company);
    g.fillText(company, W / 2, 480 + (210 - m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2 + m.actualBoundingBoxAscent);
  }

  // Direct thermal prints black or nothing: threshold every pixel, then
  // lay the divider down as a fine dot pattern (the "light grey" rule).
  const img = g.getImageData(0, 0, W, H), px = img.data;
  for (let i = 0; i < px.length; i += 4) {
    const v = (px[i] * 299 + px[i + 1] * 587 + px[i + 2] * 114) / 1000 < 128 ? 0 : 255;
    px[i] = px[i + 1] = px[i + 2] = v; px[i + 3] = 255;
  }
  if (company) {
    for (let yy = 419; yy < 422; yy++) for (let xx = 120; xx < W - 120; xx++) {
      if ((xx + yy) % 2 === 0) { const i = (yy * W + xx) * 4; px[i] = px[i + 1] = px[i + 2] = 0; }
    }
  }
  // Test mode: a diagonal TEST in a sparse dot pattern, so the name still reads.
  if (test) {
    const m = doc.createElement('canvas'); m.width = W; m.height = H;
    const mg = m.getContext('2d');
    mg.translate(W / 2, H / 2); mg.rotate(-0.32);
    mg.font = '900 300px Montserrat'; mg.textAlign = 'center'; mg.textBaseline = 'middle'; mg.fillStyle = '#000';
    mg.fillText('TEST', 0, 0);
    const mask = mg.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) {
      const x = i % W, yy = (i / W) | 0;
      if (mask[i * 4 + 3] > 128 && x % 3 === 0 && yy % 3 === 0) px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 0;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

function visaNextElement(attendee, ctx, doc) {
  const d = ctx.design;
  const badge = el(doc, 'div', `width:${d.w}mm;height:${d.h}mm;box-sizing:border-box;position:relative;overflow:hidden;background:#fff;`
    + 'display:flex;align-items:center;justify-content:center;padding:0');
  badge.className = 'badge';
  const img = el(doc, 'img', `width:${d.w}mm;height:${(VISA_NEXT_PX.h * 25.4 / 300).toFixed(2)}mm;display:block;image-rendering:pixelated`);
  img.alt = [attendee.first_name, attendee.last_name, attendee.company].filter(Boolean).join(' ');
  img.src = visaNextCanvas(attendee, doc, { test: !!ctx.test }).toDataURL('image/png');
  if (!fontsReady(doc)) img.dataset.fontPending = '1';
  badge.append(img);
  return badge;
}
