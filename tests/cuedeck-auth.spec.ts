import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';

// cuedeck-auth.js is a classic browser script that sets window.cdAuth.
type CdAuth = {
  mount: (el: unknown) => { token: () => Promise<string | undefined>; reset: () => void };
  message: (e: unknown) => string;
  passwordScore: (pw: string) => { score: number; label: string };
  PASSWORD_MIN: number;
};
let cdAuth: CdAuth;
beforeAll(() => {
  const win: Record<string, unknown> = {};
  new Function('window', readFileSync(new URL('../cuedeck-auth.js', import.meta.url), 'utf8'))(win);
  cdAuth = win.cdAuth as CdAuth;
});

describe('passwordScore', () => {
  it('rejects anything under the minimum, saying how many characters are missing', () => {
    expect(cdAuth.PASSWORD_MIN).toBe(10);
    expect(cdAuth.passwordScore('abc')).toEqual({ score: 1, label: 'Too short: 7 more characters' });
    expect(cdAuth.passwordScore('abcdefghi').label).toBe('Too short: 1 more character');
  });
  it('rates length first, variety second', () => {
    expect(cdAuth.passwordScore('abcdefghij').score).toBe(2);
    expect(cdAuth.passwordScore('Abcdefgh12').score).toBe(3);
    expect(cdAuth.passwordScore('correct horse battery').score).toBe(4);
  });
  it('does not call a repeated character strong', () => {
    expect(cdAuth.passwordScore('aaaaaaaaaaaaaaaaaaaa')).toEqual({ score: 1, label: 'Too predictable' });
  });
  it('is empty for an empty field', () => {
    expect(cdAuth.passwordScore('')).toEqual({ score: 0, label: '' });
  });
});

describe('message', () => {
  it('maps Supabase error codes to plain words', () => {
    expect(cdAuth.message({ code: 'invalid_credentials', message: 'Invalid login credentials' }))
      .toMatch(/do not match/);
    expect(cdAuth.message({ code: 'captcha_failed', message: 'captcha protection: request disallowed' }))
      .toMatch(/security check failed/);
  });
  it('treats any 429 as a rate limit', () => {
    expect(cdAuth.message({ status: 429, message: 'x' })).toMatch(/Too many attempts/);
  });
  it('falls back to the original text for unknown errors', () => {
    expect(cdAuth.message({ code: 'something_new', message: 'Original text' })).toBe('Original text');
    expect(cdAuth.message(null)).toBe('');
  });
});

describe('mount without a site key', () => {
  it('yields no token, so requests pass while CAPTCHA is off on the server', async () => {
    const h = cdAuth.mount({});
    await expect(h.token()).resolves.toBeUndefined();
    expect(() => h.reset()).not.toThrow();
  });
});
