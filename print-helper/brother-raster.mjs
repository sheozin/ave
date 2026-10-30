// brother-raster.mjs: PNG in, Brother QL raster job out. No dependencies.
// The command sequence matches brother_ql (github.com/pklaus/brother_ql),
// the open-source driver known to work with the QL-800 series, and the
// test compares our bytes with its output for the same image.
import { inflateSync } from 'node:zlib';

// QL-800/810W/820NWB: a 720-dot head; a 62 mm roll prints 696 dots of it,
// 12 dots in from the right. 300 dpi.
export const QL = { headDots: 720, rightMargin: 12, rollDots: 696, dpi: 300 };

// ── PNG (8-bit, non-interlaced: what a browser canvas exports) ──
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, w = 0, h = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), kind = buf.toString('ascii', off + 4, off + 8), data = buf.subarray(off + 8, off + 8 + len);
    if (kind === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
    off += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !ch || interlace) throw new Error(`unsupported PNG (depth ${depth}, colour type ${type}, interlace ${interlace})`);
  const raw = inflateSync(Buffer.concat(idat)), stride = w * ch, px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[dst + x - ch] : 0, b = y ? px[dst - stride + x] : 0, c = x >= ch && y ? px[dst - stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  // Grey 0..255 over white.
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const p = i * ch;
    const g = ch <= 2 ? px[p] : (px[p] * 299 + px[p + 1] * 587 + px[p + 2] * 114) / 1000;
    const alpha = ch === 2 ? px[p + 1] : ch === 4 ? px[p + 3] : 255;
    gray[i] = Math.round(255 - (255 - g) * alpha / 255);
  }
  return { w, h, gray };
}

// Black where brother_ql's default threshold (70) makes it black.
const isBlack = (g) => 255 - g >= 76;

// The label as print lines: one line per dot along the feed, each `rollDots`
// across. A landscape image (wider than the roll) is turned a quarter turn
// counter-clockwise, as brother_ql's --rotate 90 does.
export function toLines(img) {
  const { w, h, gray } = img;
  const turn = w !== QL.rollDots;
  const across = turn ? h : w, n = turn ? w : h;
  if (across !== QL.rollDots) throw new Error(`the image must be ${QL.rollDots} px across the roll, not ${across}`);
  const lines = [];
  for (let l = 0; l < n; l++) {
    const row = new Uint8Array(across);
    // Rotating CCW: line l is column (w-1-l), read top to bottom.
    for (let i = 0; i < across; i++) row[i] = isBlack(turn ? gray[i * w + (w - 1 - l)] : gray[l * w + i]) ? 1 : 0;
    lines.push(row);
  }
  return lines;
}

// Fit the lines to a cut length. The printer feeds `marginDots` before and
// after the printed lines, so the printed part is the cut length minus both.
// Blank lines are trimmed evenly from the ends; ink is never cut off; if the
// ink itself is longer, the label is scaled down along the feed to fit.
export function fitLength(lines, cutMm, marginDots) {
  const want = Math.round(cutMm * QL.dpi / 25.4) - 2 * marginDots;
  if (want <= 0) throw new Error('cut length too short for the margins');
  if (lines.length === want) return lines;
  if (lines.length < want) {
    const blank = new Uint8Array(QL.rollDots), pad = want - lines.length, top = Math.floor(pad / 2);
    return [...Array(top).fill(blank), ...lines, ...Array(pad - top).fill(blank)];
  }
  const ink = (r) => r.some(Boolean);
  let first = lines.findIndex(ink), last = lines.length - 1 - [...lines].reverse().findIndex(ink);
  if (first < 0) return lines.slice(0, want);
  const span = last - first + 1;
  if (span <= want) {
    // Keep the label centred where possible, else slide to keep all ink.
    let start = Math.floor((lines.length - want) / 2);
    start = Math.min(Math.max(start, last - want + 1), first);
    return lines.slice(start, start + want);
  }
  const out = [];
  for (let i = 0; i < want; i++) out.push(lines[first + Math.floor(i * span / want)]);
  return out;
}

// The job: invalidate, initialise, raster mode, then per label the status
// request, media/quality, auto cut, cut every label, cut at end, margins and
// uncompressed lines; 0x0C between labels, 0x1A after the last.
export function rasterJob(labels, { marginDots = 35, cut = true } = {}) {
  const parts = [Buffer.from([0x1b, 0x69, 0x61, 0x01]), Buffer.alloc(200), Buffer.from([0x1b, 0x40]), Buffer.from([0x1b, 0x69, 0x61, 0x01])];
  labels.forEach((lines, page) => {
    const n = lines.length;
    parts.push(Buffer.from([0x1b, 0x69, 0x53]));
    // ESC i z: flags (recover, quality, width, length, type valid), continuous tape, 62 mm, length 0, lines, page
    parts.push(Buffer.from([0x1b, 0x69, 0x7a, 0x80 | 0x40 | 0x08 | 0x04 | 0x02, 0x0a, 62, 0, n & 255, (n >> 8) & 255, (n >> 16) & 255, n >>> 24, page ? 1 : 0, 0]));
    if (cut) parts.push(Buffer.from([0x1b, 0x69, 0x4d, 0x40]), Buffer.from([0x1b, 0x69, 0x41, 1]));
    parts.push(Buffer.from([0x1b, 0x69, 0x4b, cut ? 0x08 : 0]));
    parts.push(Buffer.from([0x1b, 0x69, 0x64, marginDots & 255, marginDots >> 8]));
    const bytes = QL.headDots / 8;
    for (const row of lines) {
      const out = Buffer.alloc(3 + bytes);
      out[0] = 0x67; out[1] = 0; out[2] = bytes;
      // Placed `rightMargin` dots in from the right, then mirrored for the head.
      const left = QL.headDots - QL.rollDots - QL.rightMargin;
      for (let i = 0; i < QL.rollDots; i++) if (row[i]) {
        const dot = QL.headDots - 1 - (left + i);
        out[3 + (dot >> 3)] |= 0x80 >> (dot & 7);
      }
      parts.push(out);
    }
    parts.push(Buffer.from([page === labels.length - 1 ? 0x1a : 0x0c]));
  });
  return Buffer.concat(parts);
}

// ── status (32 bytes, ESC i S reply) ──
const ERR1 = { 0x01: 'No media', 0x02: 'End of media', 0x04: 'Cutter jam', 0x10: 'Printer in use', 0x20: 'Printer turned off', 0x40: 'High-voltage adapter', 0x80: 'Fan not working' };
const ERR2 = { 0x01: 'Replace media', 0x02: 'Expansion buffer full', 0x04: 'Communication error', 0x08: 'Communication buffer full', 0x10: 'Cover open', 0x20: 'Cancel key', 0x40: 'Media cannot be fed', 0x80: 'System error' };
export function parseStatus(b) {
  if (!b || b.length < 32 || b[0] !== 0x80 || b[1] !== 0x20) throw new Error('not a QL status reply');
  const errors = [];
  for (const [bit, name] of Object.entries(ERR1)) if (b[8] & bit) errors.push(name);
  for (const [bit, name] of Object.entries(ERR2)) if (b[9] & bit) errors.push(name);
  return { errors, media: { width_mm: b[10], type: { 0x00: 'none', 0x0a: 'continuous', 0x0b: 'die-cut' }[b[11]] || 'unknown', length_mm: b[17] } };
}
export const STATUS_REQUEST = Buffer.concat([Buffer.alloc(200), Buffer.from([0x1b, 0x40, 0x1b, 0x69, 0x53])]);
