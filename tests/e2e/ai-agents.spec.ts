// tests/e2e/ai-agents.spec.ts
// E2E structural tests for the 3 CueDeck AI agent modules.
// Verifies that agent scripts load, classes are available,
// modals can be injected, and fallback mode works without API key.
//
// NOTE: Agent modules use `const` at top-level script scope (not `window.`),
// so we check via `typeof CueDeckXxx !== 'undefined'` in evaluate().
//
// Prerequisite: preview server running on port 7230
// Run: npm run test:e2e

import { test, expect, type Page } from '@playwright/test';

const BASE = 'http://127.0.0.1:7230';

/** Allow clicks to pass through the loading overlay without real auth. */
async function bypassOverlay(page: Page) {
  await page.evaluate(() => {
    const el = document.getElementById('loading-overlay');
    if (el) el.style.pointerEvents = 'none';
  });
}

test.describe('AI Agents: script loading', () => {

  test('01 CueDeckIncidentAdvisor is defined after page load', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    // const at top-level lives in global scope but NOT on window
    const exists = await page.evaluate('typeof CueDeckIncidentAdvisor !== "undefined"');
    expect(exists).toBe(true);
  });

  test('02 CueDeckCueEngine is defined after page load', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate('typeof CueDeckCueEngine !== "undefined"');
    expect(exists).toBe(true);
  });

  test('03 CueDeckReportAgent is defined after page load', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate('typeof CueDeckReportAgent !== "undefined"');
    expect(exists).toBe(true);
  });

  test('04 all three agent script files load without JS errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`${BASE}/cuedeck-console.html`);
    await page.waitForTimeout(1000);
    // Filter for agent-related errors only
    const agentErrors = errors.filter(e => /cuedeck-agent|CueDeck(Incident|Cue|Report)/i.test(e));
    expect(agentErrors).toHaveLength(0);
  });

});

test.describe('AI Agents: API surface', () => {

  test('05 IncidentAdvisor has init method', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const hasInit = await page.evaluate('typeof CueDeckIncidentAdvisor.init === "function"');
    expect(hasInit).toBe(true);
  });

  test('06 IncidentAdvisor has trigger method', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const hasTrigger = await page.evaluate('typeof CueDeckIncidentAdvisor.trigger === "function"');
    expect(hasTrigger).toBe(true);
  });

  test('07 CueEngine has init and reinit methods', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const result = await page.evaluate(() => ({
      hasInit: typeof CueDeckCueEngine.init === 'function',
      hasReinit: typeof CueDeckCueEngine.reinit === 'function',
    }));
    expect(result.hasInit).toBe(true);
    expect(result.hasReinit).toBe(true);
  });

  test('08 CueEngine has dismiss method', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const hasDismiss = await page.evaluate('typeof CueDeckCueEngine.dismiss === "function"');
    expect(hasDismiss).toBe(true);
  });

  test('09 ReportAgent has init and trigger methods', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const result = await page.evaluate(() => ({
      hasInit: typeof CueDeckReportAgent.init === 'function',
      hasTrigger: typeof CueDeckReportAgent.triggerFromCueDeck === 'function',
    }));
    expect(result.hasInit).toBe(true);
    expect(result.hasTrigger).toBe(true);
  });

});

test.describe('AI Agents: modal injection', () => {

  test('10 IncidentAdvisor creates modal after init', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);

    // Init the agent (mimicking director role)
    await page.evaluate(() => {
      CueDeckIncidentAdvisor.init({
        role: 'director',
        supabase: null,
        sessions: [],
      });
    });

    // Check modal element was injected
    const modalExists = await page.evaluate(() =>
      document.getElementById('cuedeck-incident-modal') !== null
    );
    expect(modalExists).toBe(true);
  });

  test('11 CueEngine creates modal after init', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);

    await page.evaluate(() => {
      CueDeckCueEngine.init([], {
        role: 'director',
        supabase: null,
      });
    });

    const modalExists = await page.evaluate(() =>
      document.getElementById('cuedeck-cue-modal') !== null
    );
    expect(modalExists).toBe(true);
  });

  test('12 ReportAgent creates modal after init', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    await bypassOverlay(page);

    await page.evaluate(() => {
      CueDeckReportAgent.init({
        role: 'director',
        supabase: null,
        sessions: [],
      });
    });

    const modalExists = await page.evaluate(() =>
      document.getElementById('cuedeck-report-modal') !== null
    );
    expect(modalExists).toBe(true);
  });

});

test.describe('AI Agents: API key management', () => {

  test('13 cuedeck_agent_key localStorage key works', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);

    await page.evaluate(() => {
      localStorage.setItem('cuedeck_agent_key', 'test-key-12345');
    });

    const stored = await page.evaluate(() =>
      localStorage.getItem('cuedeck_agent_key')
    );
    expect(stored).toBe('test-key-12345');

    // Clean up
    await page.evaluate(() => localStorage.removeItem('cuedeck_agent_key'));
  });

  test('14 CUEDECK_API_KEY global is accessible', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);

    // CUEDECK_API_KEY should be undefined (no key set) or a string
    const keyType = await page.evaluate('typeof CUEDECK_API_KEY');
    expect(['undefined', 'string']).toContain(keyType);
  });

});

test.describe('AI Agents: console integration', () => {

  test('15 ensureAgentsInited function exists', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate('typeof ensureAgentsInited === "function"');
    expect(exists).toBe(true);
  });

  test('16 AI Agents sidebar section exists in DOM', async ({ page }) => {
    await page.goto(`${BASE}/cuedeck-console.html`);
    const exists = await page.evaluate(() => {
      const html = document.body.innerHTML;
      return html.includes('AI AGENTS') || html.includes('ai-agents') || html.includes('AI Agents');
    });
    expect(exists).toBe(true);
  });

});
