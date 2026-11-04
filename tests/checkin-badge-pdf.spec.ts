// tests/checkin-badge-pdf.spec.ts: the iPad badge PDF (checkin-badge-pdf.js).
import { describe, it, expect } from 'vitest';
import { badgePdf, rollPage, isIOS } from '../checkin-badge-pdf.js';

const JPEG = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3, 0xFF, 0xD9]);
const text = (b: Uint8Array) => new TextDecoder('latin1').decode(b);

describe('badgePdf', () => {
  it('one page per badge, each exactly the label size in points', () => {
    const pdf = text(badgePdf([
      { jpeg: JPEG, px: [732, 898], mm: [62, 76] },
      { jpeg: JPEG, px: [732, 898], mm: [62, 76] },
    ]));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Count 2');
    // 62 mm = 175.75 pt, 76 mm = 215.43 pt
    expect(pdf.match(/\/MediaBox \[0 0 175\.75 215\.43\]/g)).toHaveLength(2);
    expect(pdf).toContain('/Width 732 /Height 898');
    expect(pdf).toContain('/Filter /DCTDecode /Length 9');
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
  });
  it('the cross-reference table points at every object', () => {
    const bytes = badgePdf([{ jpeg: JPEG, px: [10, 20], mm: [62, 76] }]);
    const pdf = text(bytes);
    const start = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(start, start + 4)).toBe('xref');
    const rows = pdf.slice(start).split('\n').slice(3, 3 + 5);
    rows.forEach((r, i) => {
      const at = Number(r.slice(0, 10));
      expect(pdf.slice(at, at + String(i + 1).length + 6)).toBe((i + 1) + ' 0 obj');
    });
  });
  it('the image bytes go in untouched', () => {
    const bytes = badgePdf([{ jpeg: JPEG, px: [10, 20], mm: [62, 76] }]);
    const s = text(bytes);
    const at = s.indexOf('stream\n', s.indexOf('/DCTDecode')) + 7;
    expect([...bytes.slice(at, at + JPEG.length)]).toEqual([...JPEG]);
  });
  it('refuses an empty list or a badge with no image', () => {
    expect(() => badgePdf([])).toThrow('no badges');
    expect(() => badgePdf([{ jpeg: new Uint8Array(), px: [1, 1], mm: [62, 76] }])).toThrow('no image');
  });
});

describe('rollPage', () => {
  it('turns a landscape badge to stand the way it leaves the roll', () => {
    expect(rollPage(898, 732, 76)).toEqual({ turn: true, px: [732, 898], mm: [62, 76] });
  });
  it('leaves a portrait badge as it is', () => {
    expect(rollPage(732, 1181, 100)).toEqual({ turn: false, px: [732, 1181], mm: [62, 100] });
  });
});

describe('isIOS', () => {
  it('knows an iPad, including one that says it is a Mac', () => {
    expect(isIOS({ userAgent: 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)', platform: 'iPad', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', platform: 'MacIntel', maxTouchPoints: 0 })).toBe(false);
    expect(isIOS(null)).toBe(false);
  });
});
