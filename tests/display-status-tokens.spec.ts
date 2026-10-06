// tests/display-status-tokens.spec.ts
// Spec non-goals: the signage display keeps its layout but adopts the shared
// status colours (LIVE red, READY green, HOLD amber, OVERRUN magenta).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../cuedeck-display.html'), 'utf8');

describe('display page status colours', () => {
  it('declares the shared status tokens', () => {
    for (const [k, v] of [['--st-live', '#EF4444'], ['--st-ready', '#34D399'], ['--st-calling', '#FACC15'], ['--st-hold', '#FB923C'], ['--st-overrun', '#E879F9']]) {
      expect(SRC).toContain(`${k}: ${v}`);
    }
  });
  it('status labels use the tokens', () => {
    expect(SRC).toContain('.d-header-status.live{color:var(--st-live)}');
    expect(SRC).toContain('.d-header-status.ready{color:var(--st-ready)}');
    expect(SRC).toContain('.sc-tag.live{color:var(--st-live)}');
    expect(SRC).toContain('.st-status.hold{color:var(--st-hold)}');
    expect(SRC).toContain('.st-status.overrun{color:var(--st-overrun)}');
  });
  it('the stage timer uses the overrun and hold status colours; the presenter timer keeps its own', () => {
    expect(SRC).toContain("const col2 = ov2 ? '#E879F9'");
    expect(SRC).toContain("const color   = ov ? '#E879F9'");
    expect(SRC.match(/isHold2? +\? '#FB923C'/g)).toHaveLength(2);
    expect(SRC).not.toMatch(/isHold2? +\? '#f97316'/);
    // presenter timer (remaining-time colours, not statuses): unchanged
    expect(SRC).toContain("const tc = ov ? '#ef4444'");
    expect(SRC).toContain("pb.style.background = ov ? '#ef4444'");
  });
});
