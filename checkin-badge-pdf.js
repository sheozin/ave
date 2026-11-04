// checkin-badge-pdf.js: badges as a PDF whose pages are exactly the label.
//
// Why: an iPad prints a web page on the paper the printer offers, and on a
// Brother 62 mm continuous roll that is a long strip, not a badge. A PDF
// page carries its own size, and the Brother accepts any length on the roll
// and cuts at the end of each page, so a 62 x 76 mm page prints a 62 x 76 mm
// badge. The desk builds this from the same 300 dpi image the print
// station gets (checkin-badge.js badgePng) and hands it to the iPad's share
// sheet, which has Print.
//
// Pure: no DOM. The desk turns each badge image into JPEG bytes and passes
// them here (tests/checkin-badge-pdf.spec.ts).

const MM_PT = 72 / 25.4;
const enc = new TextEncoder();

// pages: [{ jpeg: Uint8Array, px: [w, h], mm: [w, h] }]
export function badgePdf(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('no badges to put in the PDF');
  const parts = [];
  let size = 0;
  const offsets = [];
  const put = (x) => { const b = typeof x === 'string' ? enc.encode(x) : x; parts.push(b); size += b.length; };
  const obj = (n, body) => { offsets[n] = size; put(n + ' 0 obj\n'); for (const b of [].concat(body)) put(b); put('\nendobj\n'); };

  const n = pages.length;
  const pageNo = (i) => 3 + i * 3;   // page i: page, its contents, its image
  put('%PDF-1.4\n');
  put(new Uint8Array([0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A]));   // binary marker line
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Count ' + n + ' /Kids [' + pages.map((_, i) => pageNo(i) + ' 0 R').join(' ') + '] >>');
  pages.forEach((p, i) => {
    const [wPx, hPx] = p.px, [wMm, hMm] = p.mm;
    if (!(p.jpeg instanceof Uint8Array) || !p.jpeg.length) throw new Error('badge ' + (i + 1) + ' has no image');
    if (!(wPx > 0 && hPx > 0 && wMm > 0 && hMm > 0)) throw new Error('badge ' + (i + 1) + ' has no size');
    const w = (wMm * MM_PT).toFixed(2), h = (hMm * MM_PT).toFixed(2);
    const no = pageNo(i);
    obj(no, '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + w + ' ' + h + '] /Resources << /XObject << /Im0 ' + (no + 2) + ' 0 R >> >> /Contents ' + (no + 1) + ' 0 R >>');
    const draw = 'q ' + w + ' 0 0 ' + h + ' 0 0 cm /Im0 Do Q';
    obj(no + 1, ['<< /Length ' + draw.length + ' >>\nstream\n', draw, '\nendstream']);
    obj(no + 2, ['<< /Type /XObject /Subtype /Image /Width ' + wPx + ' /Height ' + hPx +
      ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.jpeg.length + ' >>\nstream\n', p.jpeg, '\nendstream']);
  });
  const xref = size, count = 3 + n * 3;
  let table = 'xref\n0 ' + count + '\n0000000000 65535 f \n';
  for (let k = 1; k < count; k++) table += String(offsets[k]).padStart(10, '0') + ' 00000 n \n';
  put(table + 'trailer\n<< /Size ' + count + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n');

  const out = new Uint8Array(size);
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}

// The page for one badge image as it feeds off the roll: the roll width
// across, the badge length down. A landscape image (wider than tall) is
// turned a quarter so the page stands the way the label comes out.
export function rollPage(imgW, imgH, cutMm, rollMm = 62) {
  const turn = imgW > imgH;
  const px = turn ? [imgH, imgW] : [imgW, imgH];
  return { turn, px, mm: [rollMm, Math.round(cutMm * 10) / 10] };
}

// iPad and iPhone, including an iPad that reports itself as a Mac.
export function isIOS(nav) {
  if (!nav) return false;
  return /iPad|iPhone|iPod/.test(nav.userAgent || '') || (nav.platform === 'MacIntel' && (nav.maxTouchPoints || 0) > 1);
}
