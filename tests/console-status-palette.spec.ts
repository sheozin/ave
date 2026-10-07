// tests/console-status-palette.spec.ts
// Spec section 1: one colour per status, distinguishable under normal,
// protan and deutan vision (worst pair dE >= 20 over the six active states),
// text on solid fills >= 4.5:1, and JS reads status colours from CSS.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const SRC = readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8');
const ROOT = SRC.slice(SRC.indexOf(':root {'), SRC.indexOf('}', SRC.indexOf(':root {')));
const tok = (name: string) => {
  const m = ROOT.match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
  if (!m) throw new Error(`${name} missing`);
  return m[1];
};
const hex = (x: string) => [0, 2, 4].map(i => parseInt(x.slice(1 + i, 3 + i), 16));
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (rgb: number[]) => { const [r, g, b] = rgb.map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a: number[], b: number[]) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
// Machado et al. severity 1.0, the matrices the audit used (viz/cvd.py).
const PROT = [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]];
const DEUT = [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]];
const delin = (v: number) => { v = Math.min(Math.max(v, 0), 1); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
const sim = (rgb: number[], M: number[][]) => { const l = rgb.map(lin); return M.map(r => Math.round(delin(r[0] * l[0] + r[1] * l[1] + r[2] * l[2]))); };
const lab = (rgb: number[]) => {
  const [r, g, b] = rgb.map(lin);
  const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (v: number) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
};
const dE = (a: number[], b: number[]) => { const A = lab(a), B = lab(b); return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]); };

const ACTIVE = ['planned', 'ready', 'calling', 'live', 'overrun', 'hold'];

describe('status palette', () => {
  it('has the spec solids', () => {
    expect([...ACTIVE, 'ended', 'cancelled'].map(s => tok(`--st-${s}`).toUpperCase())).toEqual(
      ['#94A3B8', '#34D399', '#FACC15', '#EF4444', '#E879F9', '#FB923C', '#64748B', '#4B5563']);
    expect(tok('--on-solid').toUpperCase()).toBe('#0A0E14');
  });

  it('worst pair over the six active states is at least dE 20 under normal, protan and deutan vision', () => {
    let worst = Infinity;
    for (const M of [null, PROT, DEUT]) {
      for (let i = 0; i < ACTIVE.length; i++) for (let j = i + 1; j < ACTIVE.length; j++) {
        let a = hex(tok(`--st-${ACTIVE[i]}`)), b = hex(tok(`--st-${ACTIVE[j]}`));
        if (M) { a = sim(a, M); b = sim(b, M); }
        worst = Math.min(worst, dE(a, b));
      }
    }
    expect(worst).toBeGreaterThanOrEqual(20);
  });

  it('dark text on every active solid is at least 5:1', () => {
    for (const s of ACTIVE) expect(ratio(hex(tok('--on-solid')), hex(tok(`--st-${s}`)))).toBeGreaterThanOrEqual(5);
  });

  it('JS reads status colours from CSS, not from its own map', () => {
    expect(SRC).not.toMatch(/STATUS_COLOR\s*=\s*\{/);
    expect(SRC).toMatch(/function statusColor\(status\)/);
  });
});
