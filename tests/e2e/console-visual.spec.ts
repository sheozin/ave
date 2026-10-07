// tests/e2e/console-visual.spec.ts
// Screenshot baselines for the console, per role, state and width. The
// baselines change only on purpose: run with --update-snapshots in the task
// that changes the look, review every PNG, commit them with that task.
import { test } from '@playwright/test';
import { openConsole, snap, evalPage, overrunSessions, noLiveSessions, fourRoomSessions, PANEL_ID, type Scenario } from './console-boot-mock';

interface Case { name: string; sc?: Scenario; prep?: string }
const CASES: Case[] = [
  { name: 'director-1440' },
  { name: 'director-1280', sc: { viewport: { width: 1280, height: 720 } } },
  { name: 'director-390', sc: { viewport: { width: 390, height: 844 }, touch: true } },
  { name: 'stage-1440', sc: { role: 'stage' } },
  { name: 'av-1440', sc: { role: 'av' } },
  { name: 'overrun-1440', sc: { sessions: overrunSessions() } },
  { name: 'no-live-1440', sc: { sessions: noLiveSessions(), broadcast: null } },
  { name: 'empty-1440', sc: { sessions: [], broadcast: null } },
  { name: 'timeline-1440', prep: `setViewMode('timeline')` },
  { name: 'timeline-overrun-1440', sc: { sessions: overrunSessions() }, prep: `setViewMode('timeline')` },
  { name: 'armed-end-1440', prep: `document.querySelector('[onclick*="confirmEnd(\\'${PANEL_ID}\\'"]').click()` },
  { name: 'signage-1440', prep: `setRole('signage')` },
  { name: 'browser-cairo-1440', sc: { timezoneId: 'Africa/Cairo' } },
  { name: 'band-overrun-1280', sc: { sessions: overrunSessions(), viewport: { width: 1280, height: 720 } } },
  { name: 'band-four-rooms-1440', sc: { sessions: fourRoomSessions() } },
];

for (const c of CASES) {
  test(c.name, async ({ browser }) => {
    const { ctx, page } = await openConsole(browser, c.sc);
    try {
      if (c.prep) await evalPage(page, c.prep);
      await snap(page, c.name);
    } finally {
      await ctx.close();
    }
  });
}
