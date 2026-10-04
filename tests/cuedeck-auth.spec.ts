import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

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

describe('mount', () => {
  it('has a real Turnstile site key: an empty one silently sends no token', () => {
    const src = readFileSync(new URL('../cuedeck-auth.js', import.meta.url), 'utf8');
    expect(src.match(/var TURNSTILE_SITE_KEY = '([^']*)';/)?.[1]).toMatch(/^0x4[A-Za-z0-9_-]{18,}$/);
  });
});

// The static app and the marketing CMS deploy separately but sign in to the
// same Supabase project. If CAPTCHA is switched on while one of them still
// has no site key, that login stops working. Both copies must match.
// cuedeck-marketing is its own git repo (ignored here), so CI and fresh
// worktrees do not have it: the comparison runs only where both exist, and
// says so when skipped instead of failing for a missing file.
const CMS_LOGIN = new URL('../cuedeck-marketing/app/(cms-auth)/login/page.tsx', import.meta.url);
const HAS_CMS = existsSync(CMS_LOGIN);
describe('Turnstile site key', () => {
  it.skipIf(!HAS_CMS)('is the same in cuedeck-auth.js and the CMS login (skipped: cuedeck-marketing checkout not present)', () => {
    const key = (path: string, re: RegExp) => {
      const m = readFileSync(new URL(path, import.meta.url), 'utf8').match(re);
      if (!m) throw new Error('site key constant not found in ' + path);
      return m[1];
    };
    const app = key('../cuedeck-auth.js', /var TURNSTILE_SITE_KEY = '([^']*)';/);
    const cms = key('../cuedeck-marketing/app/(cms-auth)/login/page.tsx', /const TURNSTILE_SITE_KEY = '([^']*)';/);
    expect(cms).toBe(app);
  });
});
