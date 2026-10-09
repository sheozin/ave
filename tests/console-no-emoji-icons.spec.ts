// tests/console-no-emoji-icons.spec.ts
// Spec section 3 (Icons): no emoji used as icons in the console. Scans
// cuedeck-console.html with comments removed, after decoding HTML entities
// (&#x1F4CB; &#9776;) and JS escapes (▶) so an icon cannot hide in either.
//
// Two nets:
// 1. \p{Extended_Pictographic}: every emoji. Node's Unicode data decides, the
//    same on macOS and Linux CI, so the result does not depend on the OS fonts.
// 2. ICON_GLYPHS: symbols that are not Extended_Pictographic in every Unicode
//    version but were used here as icons (carets, dots, stars, the ☰ menu, the
//    ✎ pencil, the fullwidth ＋, the emoji presentation selector U+FE0F).
//    ✎ (U+270E) and ☰ (U+2630) are listed because Linux Chromium has drawn
//    them as emoji before, whatever Node says about them.
//
// Allowed, because they are text, not icons (none is Extended_Pictographic):
//   → ← ↑ ↓   arrows as words in log lines ("ready → calling") and key names
//   ↵         the Enter key in the command palette footer
//   ⌘         the Cmd key name in shortcut hints
//   ✓         a plain check mark in running text
//   ×         the multiplication sign and close glyph in text
//   · … – −   punctuation and the minus sign in "−1 min"
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const cp = (n: number) => { try { return String.fromCodePoint(n); } catch { return ''; } };
const strip = (raw: string) => raw
  // Comments go, their line breaks stay, so a hit reports its real line number.
  .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ''))
  .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ''))
  .split('\n').map(l => l.replace(/(^|[\s;{}(,])\/\/.*$/, '$1')).join('\n')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => cp(parseInt(h, 16)))
  .replace(/&#([0-9]+);/g, (_, d) => cp(parseInt(d, 10)))
  .replace(/\\{1,2}u\{([0-9a-f]+)\}/gi, (_, h) => cp(parseInt(h, 16)))
  .replace(/\\{1,2}u([0-9a-f]{4})/gi, (_, h) => cp(parseInt(h, 16)));
const SRC = strip(readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8'));

const ICON_GLYPHS = '✕✖✎✏▲▼▶◀▸▾▴◂◉◈●○▯▭☰⟳★☆⬆⬇⏻⊡⊞＋❚\uFE0F';
const GLYPHS = new RegExp(`\\p{Extended_Pictographic}|[${ICON_GLYPHS}]`, 'gu');

describe('no emoji icons in the console', () => {
  it('the guard sees emoji, icon glyphs and their escaped forms', () => {
    for (const s of ['📋', '⚠', '☕', '▶', '✎', '☰', '★', '＋', '\uFE0F']) expect(s.match(GLYPHS), s).not.toBeNull();
    for (const s of ['→', '↵', '⌘', '✓', '×', '·', '…', '−']) expect(s.match(GLYPHS), s).toBeNull();
  });

  it('finds none', () => {
    const hits: string[] = [];
    SRC.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(GLYPHS)) hits.push(`${i + 1}: ${m[0]} U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}  ${line.trim().slice(0, 80)}`);
    });
    expect(hits).toEqual([]);
  });
});

// The signage display (owner screenshots 9 Oct): 🗓 and 📜 headings drew as grey squares on
// screens without an emoji font, as did 📍 ⏱ ☕ 📶. Every emoji goes; the display's own text
// glyphs (● LIVE, ◈ READY, ⟳ reconnecting) are not Extended_Pictographic and stay.
const DISPLAY = strip(readFileSync(resolve(__dirname, '../cuedeck-display.html'), 'utf8'));
describe('no emoji icons on the display', () => {
  it('finds none', () => {
    const hits: string[] = [];
    DISPLAY.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/\p{Extended_Pictographic}|\uFE0F/gu)) hits.push(`${i + 1}: ${m[0]} U+${m[0].codePointAt(0)!.toString(16).toUpperCase()}  ${line.trim().slice(0, 80)}`);
    });
    expect(hits).toEqual([]);
  });
});
