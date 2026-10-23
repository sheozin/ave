import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// Session expiry in cuedeck-auth.js (2026-10-23): sign-ins end after 12 h
// unused or 7 days; the sign-in screen says why, a person's own sign-out is
// not called an expiry, and a day before the hard limit the page warns.
type Cd = {
  signOut: (sb: unknown, o?: unknown) => Promise<unknown>;
  watch: (sb: unknown, onExpired: () => void) => void;
  expiredNotice: () => string;
  warningFor: (at: number | null, now: number) => string;
  signedInAt: (s: { access_token: string }) => number | null;
};
function memStore() { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } }; }
function load(): Cd {
  (globalThis as any).sessionStorage = memStore();
  (globalThis as any).localStorage = memStore();
  (globalThis as any).document = { getElementById: () => null, createElement: () => ({ style: {}, dataset: {}, setAttribute() {}, appendChild() {}, querySelector: () => ({}) }), body: { appendChild() {} } };
  const win: Record<string, unknown> = {};
  new Function('window', readFileSync(new URL('../cuedeck-auth.js', import.meta.url), 'utf8'))(win);
  return win.cdAuth as Cd;
}
function fakeSb() {
  const subs: ((e: string, s?: unknown) => void)[] = [];
  return {
    fire: (e: string) => subs.forEach(f => f(e)),
    auth: {
      onAuthStateChange: (f: (e: string) => void) => { subs.push(f); },
      getSession: () => Promise.resolve({ data: { session: null } }),
      signOut: vi.fn(() => Promise.resolve({ error: null })),
    },
  };
}
const H = 3600e3;
let cd: Cd;
beforeEach(() => { vi.useFakeTimers(); cd = load(); });

describe('session expiry', () => {
  it('an expiry calls onExpired and the sign-in screen gets the reason once', () => {
    const sb = fakeSb(); const onExpired = vi.fn();
    cd.watch(sb, onExpired);
    sb.fire('SIGNED_OUT');
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(cd.expiredNotice()).toMatch(/signed out: sign-ins end after 12 hours without use, and 7 days after you signed in/);
    expect(cd.expiredNotice()).toBe('');
  });
  it('the person\'s own sign-out is not an expiry, in this tab or another', async () => {
    const sb = fakeSb(); const onExpired = vi.fn();
    cd.watch(sb, onExpired);
    await cd.signOut(sb);
    sb.fire('SIGNED_OUT');
    expect(sb.auth.signOut).toHaveBeenCalledTimes(1);
    expect(onExpired).not.toHaveBeenCalled();
    expect(cd.expiredNotice()).toBe('');
    vi.advanceTimersByTime(61e3);   // a minute later the same event is an expiry again
    sb.fire('SIGNED_OUT');
    expect(onExpired).toHaveBeenCalledTimes(1);
  });
  it('warns only in the last 24 hours of the 7-day sign-in', () => {
    const now = Date.parse('2026-10-23T09:00:00Z');
    expect(cd.warningFor(now - 100 * H, now)).toBe('');           // 68 h left
    expect(cd.warningFor(now - 150 * H, now)).toMatch(/^Your sign-in ends (today|tomorrow) at /);  // 18 h left
    expect(cd.warningFor(now - 170 * H, now)).toBe('');           // already ended
    expect(cd.warningFor(null, now)).toBe('');
  });
  it('reads the sign-in time from the access token, and survives a bad token', () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const tok = b64({ alg: 'HS256' }) + '.' + b64({ amr: [{ method: 'password', timestamp: 1792700000 }] }) + '.sig';
    expect(cd.signedInAt({ access_token: tok })).toBe(1792700000 * 1000);
    expect(cd.signedInAt({ access_token: 'not-a-jwt' })).toBeNull();
    expect(cd.signedInAt({ access_token: b64({}) + '.' + b64({ amr: [] }) + '.x' })).toBeNull();
  });
});
