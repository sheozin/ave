// tests/console-ai-event-id.spec.ts
// Event teams (spec 2026-10-08 §6): AI on an event runs on that event
// owner's plan, so every ai-proxy call from the console's agents names the
// event; ai-proxy refuses a caller who is not on it (tests/deno/plan-owner.test.ts).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const AGENTS = ['cuedeck-agent-1-incident-advisor.js', 'cuedeck-agent-2-cue-engine.js', 'cuedeck-agent-3-report-generator.js'];

describe('AI calls name their event', () => {
  for (const f of AGENTS) {
    it(`${f} sends event_id with every ai-proxy call`, () => {
      const src = readFileSync(resolve(__dirname, '..', f), 'utf8');
      const callsites = src.split("functions.invoke('ai-proxy'").slice(1);
      expect(callsites.length).toBeGreaterThan(0);
      for (const c of callsites) expect(c.slice(0, 400)).toMatch(/event_id:\s*_(opts\.)?getEventId/);
    });
  }
  it('the console gives the cue engine the current event, at both init sites', () => {
    const src = readFileSync(resolve(__dirname, '../cuedeck-console.html'), 'utf8');
    const inits = src.split('CueDeckCueEngine.init(').slice(1);
    expect(inits.length).toBe(2);
    for (const c of inits) expect(c.slice(0, 300)).toMatch(/getEventId:/);
  });
});
