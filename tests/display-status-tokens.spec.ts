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
    expect(SRC).toContain("const col2 = ov2 ? 'var(--st-overrun)'");
    expect(SRC).toContain("const color   = ov ? 'var(--st-overrun)'");
    expect(SRC.match(/isHold2? +\? 'var\(--st-hold\)'/g)).toHaveLength(2);
    expect(SRC).not.toMatch(/isHold2? +\? '#f97316'/);
    // presenter timer (remaining-time colours, not statuses): unchanged
    expect(SRC).toContain("const tc = ov ? '#ef4444'");
    expect(SRC).toContain("pb.style.background = ov ? '#ef4444'");
  });
});

// Every rule keyed on a status class paints only with that status's colour:
// var(--st-<status>) or its rgb at any alpha. A green LIVE card or a blue
// READY row fails here. The big title on a live slide stays white text.
const STATUS_RGB: Record<string, string> = {
  live: '239,68,68', ready: '52,211,153', calling: '250,204,21', hold: '251,146,60', overrun: '232,121,249',
};
const NEUTRAL_OK: Record<string, string[]> = { '.d-big-title.live': ['#fff'] };
const COLOUR = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|var\(--[\w-]+\)/g;

export function statusRuleMismatches(src: string): string[] {
  const css = [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1]).join('\n');
  const bad: string[] = [];
  for (const [, selRaw, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const sel of selRaw.split(',').map(s => s.trim())) {
      const st = [...new Set([...sel.matchAll(/\.(live|ready|calling|hold|overrun)(?![\w-])/gi)].map(m => m[1].toLowerCase()))];
      if (st.length !== 1) continue;
      const s = st[0];
      for (const c of body.match(COLOUR) ?? []) {
        const rgb = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        const ok = c === `var(--st-${s})`
          || (rgb && `${rgb[1]},${rgb[2]},${rgb[3]}` === STATUS_RGB[s])
          || (NEUTRAL_OK[sel] ?? []).includes(c.toLowerCase());
        if (!ok) bad.push(`${sel} { ${c} }`);
      }
    }
  }
  return bad;
}

describe('display page status rules follow the status tokens', () => {
  it('flags a mismatched rule (self-check)', () => {
    expect(statusRuleMismatches('<style>.ag-card.live{background:rgba(34,197,94,.08)}.x.ready{color:var(--st-ready)}</style>'))
      .toEqual(['.ag-card.live { rgba(34,197,94,.08) }']);
  });
  it('every status-keyed rule uses its own status colour', () => {
    expect(statusRuleMismatches(SRC)).toEqual([]);
  });
});
