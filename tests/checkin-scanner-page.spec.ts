// tests/checkin-scanner-page.spec.ts
// The scanner page's pure logic (checkin-scanner.js), and parity of its
// cooldown and token rules with the server copy in _shared/checkin-scanner.ts.
import { describe, it, expect } from 'vitest';
import * as page from '../checkin-scanner.js';
import * as server from '../supabase/functions/_shared/checkin-scanner.ts';

describe('parity with the server copy', () => {
  it('same re-arm gap', () => {
    expect(page.REARM_MS).toBe(server.REARM_MS);
  });
  it('same token decisions', () => {
    for (const raw of ['  abc12345\n', 'abc', 'a b c d e f g h', 'x'.repeat(200), 'x'.repeat(201), 'https://e.x/?q=1', 'tok0123456789abcdef0123456789abcd', '']) {
      expect(page.normalizeToken(raw)).toBe(server.normalizeToken(raw));
    }
  });
  it('same cooldown decisions over a sequence', () => {
    const a = new Map<string, number>(), b = new Map<string, number>();
    const seq: [string, number][] = [['A', 0], ['A', 180], ['B', 200], ['A', 4000], ['A', 9000], ['B', 9100], ['A', 9200]];
    expect(seq.map(([t, n]) => page.shouldAccept(a, t, n))).toEqual(seq.map(([t, n]) => server.shouldAccept(b, t, n)));
  });
});

describe('verdictFor', () => {
  it('names the guest when the server sent one', () => {
    expect(page.verdictFor('ok', { first_name: 'Ewa', ticket_type: 'VIP' })).toEqual({ tone: 'ok', title: 'Checked in', text: 'Ewa · VIP' });
    expect(page.verdictFor('duplicate', { first_name: 'Ewa', ticket_type: null }).text).toBe('Ewa. Let them through if it is the same person.');
  });
  it('without a name, still a clear instruction', () => {
    expect(page.verdictFor('ok', undefined).text).toBe('Welcome in.');
    expect(page.verdictFor('unknown_token', undefined)).toEqual({ tone: 'stop', title: 'Not on the list', text: 'Send them to the desk.' });
    expect(page.verdictFor('queued', undefined).tone).toBe('wait');
  });
  it('an old badge replaced by a reprint is a stop that says why', () => {
    expect(page.verdictFor('revoked', undefined)).toEqual({ tone: 'stop', title: 'Old badge', text: 'A newer badge was printed for this guest, so this one no longer works. Send them to the desk.' });
  });
  it('anything unexpected is a stop, never a green', () => {
    expect(page.verdictFor('error', undefined).tone).toBe('stop');
    expect(page.verdictFor('something new', undefined).tone).toBe('stop');
  });
});

describe('settle', () => {
  const box = [{ client_id: 'a' }, { client_id: 'b' }, { client_id: 'c' }];
  it('drops what the server answered, keeps errors and unanswered', () => {
    expect(page.settle(box, { a: 'ok', b: 'error' }).map(x => x.client_id)).toEqual(['b', 'c']);
  });
  it('no results keeps everything', () => {
    expect(page.settle(box, null)).toHaveLength(3);
  });
});

describe('pickCode', () => {
  const box = (w: number, h: number) => ({ width: w, height: h });
  it('reads only the largest code in view: the guest in front, not the one behind', () => {
    expect(page.pickCode([{ rawValue: 'far', boundingBox: box(40, 40) }, { rawValue: 'near', boundingBox: box(200, 190) }])).toBe('near');
  });
  it('one code, or none', () => {
    expect(page.pickCode([{ rawValue: 'only', boundingBox: box(10, 10) }])).toBe('only');
    expect(page.pickCode([])).toBeNull();
    expect(page.pickCode(null)).toBeNull();
  });
  it('a code without a box still counts', () => {
    expect(page.pickCode([{ rawValue: 'nobox' }])).toBe('nobox');
  });
});

describe('feedback', () => {
  it('each tone has its own sound', () => {
    const ok = page.toneFor('ok'), warn = page.toneFor('warn'), stop = page.toneFor('stop');
    expect(ok.length).toBe(2);
    expect(ok[1].hz).toBeGreaterThan(ok[0].hz);   // rising: good news
    expect(warn.length).toBe(1);
    expect(stop[0].hz).toBeLessThan(warn[0].hz); // low: stop
    expect(page.toneFor('wait')).toEqual([]);     // queued offline: quiet
  });
});


describe('exit points (migration 159)', () => {
  it('records leaving, never stops anyone, and words offline right', () => {
    expect(page.verdictFor('out', { first_name: 'Ola', ticket_type: null }, 'exit')).toEqual({ tone: 'ok', title: 'Left', text: 'Their exit is recorded.' });
    expect(page.verdictFor('not_in', null, 'exit').tone).toBe('warn');
    expect(page.verdictFor('not_in', null, 'exit').text).toContain('Let them out');
    for (const r of ['unknown_token', 'not_listed', 'revoked', 'wrong_event']) expect(page.verdictFor(r, null, 'exit').tone).toBe('warn');
    expect(page.verdictFor('queued', null, 'exit').title).toBe('Saved');
    // A door still checks in.
    expect(page.verdictFor('ok', null, 'entrance').title).toBe('Checked in');
  });
  it('an exit follows the door switch on the server', () => {
    const on = { multi_point_scanning: false, entrance_scanning: true, session_scanning: false };
    expect(server.scanPointRefusal('exit', on)).toBeNull();
    expect(server.scanPointRefusal('exit', { ...on, entrance_scanning: false })).toMatch(/Door scanning is switched off/);
  });
});
