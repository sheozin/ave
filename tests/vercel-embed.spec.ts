// tests/vercel-embed.spec.ts
// The registration form may be framed only at /e/<code> (organizers'
// websites, any https origin). The full page /r/<code> and everything else
// keep refusing to be framed.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const cfg = JSON.parse(readFileSync('vercel.json', 'utf8'));
const hdr = (source: string, key: string) =>
  (cfg.headers.find((h: { source: string }) => h.source === source)?.headers ?? []).find((x: { key: string }) => x.key === key)?.value;

describe('framing', () => {
  it('/r/ is never framed', () => { expect(hdr('/r/(.*)', 'Content-Security-Policy')).toContain("frame-ancestors 'none'"); });
  it('/e/ may be framed by https sites only', () => {
    const csp = hdr('/e/(.*)', 'Content-Security-Policy');
    expect(csp).toContain('frame-ancestors https:');
    expect(csp).not.toMatch(/frame-ancestors[^;]*\*/);
    // Everything else in its policy is the same as /r/.
    expect(csp.replace('frame-ancestors https:', "frame-ancestors 'none'")).toBe(hdr('/r/(.*)', 'Content-Security-Policy'));
  });
  it('/e/ keeps the other safety headers', () => {
    expect(hdr('/e/(.*)', 'X-Content-Type-Options')).toBe('nosniff');
    expect(hdr('/e/(.*)', 'Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
  it('every other path still sends X-Frame-Options, and only /e/ is left out', () => {
    expect(hdr('/((?!e/).*)', 'X-Frame-Options')).toBe('SAMEORIGIN');
    const re = new RegExp('^/((?!e/).*)$');
    for (const p of ['/', '/r/ABC', '/checkin/setup', '/admin', '/embed.js']) expect(re.test(p)).toBe(true);
    expect(re.test('/e/ABCDEFGH23')).toBe(false);
  });
  it('/e/ serves the registration page, and embed.js is deployed', () => {
    expect(cfg.rewrites).toContainEqual({ source: '/e/:code', destination: '/cuedeck-register.html' });
    expect(readFileSync('.vercelignore', 'utf8')).toMatch(/^!\/embed\.js$/m);
  });
});
