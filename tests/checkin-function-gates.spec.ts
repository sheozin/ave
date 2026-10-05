// tests/checkin-function-gates.spec.ts
// Every check-in Edge Function decides who may call it through
// supabase/functions/_shared/checkin-roles.ts, so the permission table
// tested in tests/checkin-roles.spec.ts is the one the server enforces.
// This pins each function to its permission and forbids the old
// hand-written operator-role comparisons from coming back.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = (fn: string) => readFileSync(`supabase/functions/${fn}/index.ts`, 'utf8');

const GATES: [string, string][] = [
  ['checkin-create-checkout',  "can(role, 'go_live')"],
  ['checkin-enable-event',     "can(role, 'test_setup')"],
  ['checkin-enable-event',     "can(role, 'go_live')"],
  ['checkin-import-attendees', "can(role, 'manage_guests')"],
  ['checkin-send-qr-emails',   "can(role, 'manage_guests')"],
  ['checkin-kiosk-pair',       "can(role, 'kiosk')"],
  ['checkin-record-scans',     "can(role, 'desk')"],
];
const FUNCTIONS = [...new Set(GATES.map(g => g[0]))];

describe('Edge Function role gates', () => {
  it.each(GATES)('%s gates on %s', (fn, gate) => {
    expect(src(fn)).toContain(gate);
  });
  it.each(FUNCTIONS)('%s imports the shared role module', (fn) => {
    expect(src(fn)).toContain("from '../_shared/checkin-roles.ts'");
    expect(src(fn)).toContain('loadCallerRole(sb, event_id, user.id)');
  });
  it.each(FUNCTIONS)('%s no longer compares an operator row by hand', (fn) => {
    expect(src(fn)).not.toMatch(/\b(opRow|op|me)\?\.role\b/);
  });
  it('record-scans passes the desk id to checkin_apply_scan', () => {
    expect(src('checkin-record-scans')).toContain('p_desk_id: desk_id');
  });
});
