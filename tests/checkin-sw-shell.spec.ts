// tests/checkin-sw-shell.spec.ts
// The desk opens with no internet only for files checkin-sw.js saves at
// install (SHELL). A file the page loads that is missing from SHELL works
// online and in every test that has a network, then hangs the desk on a
// venue router with no uplink: on 2026-11-04 the redesign added
// checkin-ui.css, checkin-theme.js and the Geist font, and a render-blocking
// stylesheet that never arrives leaves a blank page. This follows every
// local file the desk loads (scripts, stylesheets, preloads, ES imports,
// recursively) and fails for any SHELL does not name.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const sw = readFileSync('checkin-sw.js', 'utf8');
const shellSrc = sw.match(/const SHELL = \[([\s\S]*?)\];/)![1];
const shell = new Set([...shellSrc.matchAll(/'(\/[^']+)'/g)].map(m => m[1]));

function refs(file: string): string[] {
  const s = readFileSync(file, 'utf8');
  const out = new Set<string>();
  for (const re of [/<script[^>]*\bsrc="(\/[^"/][^"]*)"/g, /<link[^>]*\bhref="(\/[^"/][^"]*\.(?:css|js|woff2))"/g,
                    /\bimport\s[^'"]*?from\s*['"](\/[^'"]+)['"]/g, /\bimport\(\s*['"](\/[^'"]+)['"]\s*\)/g,
                    /url\('?(\/[^')]+\.woff2)'?\)/g]) {
    for (const m of s.matchAll(re)) out.add(m[1].split(/[?#]/)[0]);
  }
  return [...out];
}

describe('the desk service worker saves every file the desk loads', () => {
  const seen = new Set<string>();
  const walk = (file: string) => {
    for (const r of refs(file)) {
      if (seen.has(r)) continue;
      seen.add(r);
      if (/\.(js|css)$/.test(r)) walk(r.slice(1));
    }
  };
  walk('cuedeck-checkin.html');

  it('finds the files it is meant to check', () => {
    expect(seen.has('/checkin-ui.css')).toBe(true);
    expect(seen.has('/checkin-badge.js')).toBe(true);
  });
  for (const f of ['/checkin-ui.css', '/checkin-theme.js', '/fonts/geist-var.woff2']) {
    it(`${f} is loaded by the desk and saved`, () => {
      expect(seen.has(f)).toBe(true);
      expect(shell.has(f)).toBe(true);
    });
  }
  it('no local file the desk loads is left out of SHELL', () => {
    const missing = [...seen].filter(f => !f.startsWith('/checkin-sw') && !shell.has(f));
    expect(missing).toEqual([]);
  });
});
