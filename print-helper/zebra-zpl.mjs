// zebra-zpl.mjs: the same CueDeck badge image, as a Zebra ZPL job.
// Desks draw badges at 300 dpi; a Zebra prints at its own resolution
// (203 or 300 dpi on a ZD421/ZD621), so the image is scaled to it, turned
// a quarter if it is wider than the print head, and centred. No
// dependencies. ^GFA (hex) is plain and every ZPL printer reads it.

const isBlack = (g) => 255 - g >= 76;   // same threshold as brother-raster.mjs

// img: { w, h, gray } from decodePng; dpi: the printer's; widthDots: its print width.
export function zplLabel(img, { dpi = 300, widthDots = 1248 } = {}) {
  const k = dpi / 300;
  let w = Math.max(1, Math.round(img.w * k)), h = Math.max(1, Math.round(img.h * k));
  const turn = w > widthDots && h <= widthDots;
  if (turn) [w, h] = [h, w];
  if (w > widthDots) throw new Error(`the badge is ${Math.round(w / dpi * 25.4)} mm wide; this printer prints ${Math.round(widthDots / dpi * 25.4)} mm`);
  const rowBytes = Math.ceil(w / 8);
  const bytes = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // Destination (x, y) back to the source pixel, before the quarter turn.
    const ux = turn ? y : x, uy = turn ? w - 1 - x : y;
    const sx = Math.min(img.w - 1, Math.floor(ux / k)), sy = Math.min(img.h - 1, Math.floor(uy / k));
    if (isBlack(img.gray[sy * img.w + sx])) bytes[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const x0 = Math.floor((widthDots - w) / 2);
  return `^XA^PW${widthDots}^LL${h}^LH0,0^FO${x0},0^GFA,${bytes.length},${bytes.length},${rowBytes},${bytes.toString('hex').toUpperCase()}^FS^PQ1^XZ`;
}

// Text-only label: the pairing code a print station prints for itself.
export function zplText(lines, { dpi = 300, widthDots = 1248 } = {}) {
  let y = Math.round(dpi * 0.12), out = `^XA^CI28^PW${widthDots}`;
  for (const { text, size } of lines) {
    const h = Math.round(dpi * size);
    out += `^FO0,${y}^FB${widthDots},1,0,C^A0N,${h},${h}^FD${String(text).replace(/[\^~\\]/g, ' ')}^FS`;
    y += Math.round(h * 1.35);
  }
  return out + `^LL${y + Math.round(dpi * 0.1)}^XZ`;
}

// SGD over port 9100: the printer answers each getvar with a quoted value.
export const ZEBRA_QUERY = '! U1 getvar "head.resolution.in_dpi"\r\n! U1 getvar "ezpl.print_width"\r\n! U1 getvar "device.product_name"\r\n';
export function parseZebraInfo(text) {
  const v = [...String(text).matchAll(/"([^"]*)"/g)].map(m => m[1]);
  const dpi = Number(v[0]), widthDots = Number(v[1]);
  if (!(dpi > 100 && dpi < 1000) || !(widthDots > 100 && widthDots < 5000)) return null;
  return { dpi, widthDots, name: v[2] || 'Zebra' };
}
