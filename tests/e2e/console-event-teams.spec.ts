// tests/e2e/console-event-teams.spec.ts
// Event teams in the console (spec docs/superpowers/specs/2026-10-08-event-teams-design.md
// §5, §6, §9): the role, the plan and the team follow the current event.
// Mocked Supabase (console-boot-mock.ts); the page clock is paused after
// boot, so anything that waits on the network steps the clock (switchTo).
import { test, expect, type Page } from '@playwright/test';
import { openConsole, evalPage, afterBootReread, EVENT_ID, USER_ID, OTHER_OWNER, defaultTeam, type MyEvent } from './console-boot-mock';

const EV_B = 'b0b0b0b0-0000-4000-8000-0000000000b2';
const EV_C = 'c0c0c0c0-0000-4000-8000-0000000000c3';
const toasts = (page: Page) => page.locator('#toast-container');

// switchEvent awaits realtime replies that ride on timers; step the paused
// clock until it has finished.
async function switchTo(page: Page, id: string) {
  await evalPage(page, `window.__swDone = false; switchEvent('${id}').then(() => { window.__swDone = true; }, e => { window.__swDone = 'error: ' + (e && e.message); }); 0`);
  for (let i = 0; i < 200; i++) {
    const done = await evalPage(page, 'window.__swDone');
    if (done === true) return;
    if (typeof done === 'string') throw new Error(done);
    await page.clock.runFor(50);
  }
  throw new Error('switchEvent did not finish');
}
const lastTrackRole = (page: Page, eventId: string) => evalPage(page,
  `((window.__rtSent || []).filter(m => m.topic === 'realtime:leod-ctrl-${eventId}' && m.event === 'presence' && m.payload && m.payload.event === 'track').map(m => m.payload.payload.role).pop()) || null`);

const twoEvents = (): MyEvent[] => [
  { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage',    isOwner: false, ownerId: OTHER_OWNER, organiser: 'Nilegate Events' },
  { id: EV_B,     name: 'Spring summit',         role: 'director', isOwner: false, ownerId: OTHER_OWNER, organiser: 'Nilegate Events' },
];

test('teams: the role follows the event, both ways', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await afterBootReread(page);
    await expect(page.locator('#role-lock')).toBeVisible();
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    await expect(page.locator('#viewas-btn')).toBeHidden();
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.userRole')).toBe('director');
    expect(await evalPage(page, 'S.role')).toBe('director');
    await expect(page.locator('#role-lock')).toBeHidden();
    await expect(page.locator('#viewas-btn')).toBeVisible();
    await switchTo(page, EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('stage');
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    await expect(page.locator('#viewas-btn')).toBeHidden();
    expect(await evalPage(page, 'F.status')).toBe('ACTIVE');   // the stage default filter came back
    // the director role from the other event does not leak: View as is refused
    await evalPage(page, `setRole('director'); 0`);
    expect(await evalPage(page, 'S.role')).toBe('stage');
  } finally { await ctx.close(); }
});

test('teams: presence tracks the role on the current event', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await afterBootReread(page);
    await switchTo(page, EV_B);
    await expect.poll(async () => { await page.clock.runFor(50); return lastTrackRole(page, EV_B); }).toBe('director');
    await switchTo(page, EVENT_ID);
    await expect.poll(async () => { await page.clock.runFor(50); return lastTrackRole(page, EVENT_ID); }).toBe('stage');
  } finally { await ctx.close(); }
});

test('teams: an event you were removed from is dropped on switch', async ({ browser }) => {
  const mine = twoEvents();
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: mine });
  try {
    await afterBootReread(page);
    mine.splice(1, 1);   // the organiser removes this person from Spring summit
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('stage');
    await expect(toasts(page)).toContainText('You are no longer on the team of this event.');
    expect(await evalPage(page, 'S.events.map(e => e.id)')).toEqual([EVENT_ID]);
    await expect(page.locator('#ev-pill-dd')).not.toContainText('Spring summit');
  } finally { await ctx.close(); }
});

test('teams: a check-in staff login that is on a console team opens the console', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {
    role: 'stage', accountRole: 'checkin_staff',
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER }],
  });
  try {
    await expect(page.locator('body')).not.toContainText('This login is for CueDeck Check-in');
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    expect(await evalPage(page, 'S.accountRole')).toBe('checkin_staff');
  } finally { await ctx.close(); }
});

test('teams: a members-only account gets no trial, no plan badge and no billing', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, {
    role: 'director', ownSub: null,
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' }],
  });
  try {
    expect(calls.filter(c => c.method === 'POST' && c.path.startsWith('/rest/v1/leod_subscriptions'))).toEqual([]);
    expect(await evalPage(page, 'S.subscription')).toBeNull();
    expect(await evalPage(page, 'S.planLimits.label')).toBe('Pro');   // the organiser's plan
    await expect(page.locator('#plan-badge')).toBeHidden();
    expect(await evalPage(page, `renderProfilePanel(); document.getElementById('pp-plan-section').style.display`)).toBe('none');
  } finally { await ctx.close(); }
});

test('teams: plan limits come from the event owner, per event', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage',    isOwner: false, ownerId: OTHER_OWNER, plan: 'starter' },
    { id: EV_B,     name: 'Spring summit',         role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' },
  ] });
  try {
    await afterBootReread(page);
    expect(await evalPage(page, 'S.planLimits.ai')).toBe(false);
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.planLimits.ai')).toBe(true);
    expect(await evalPage(page, 'S.planLimits.label')).toBe('Pro');
  } finally { await ctx.close(); }
});

test('teams: only your own events count toward your event limit', async ({ browser }) => {
  // Own plan: Starter (1 event). On someone else's Pro event only: may create one.
  const member = await openConsole(browser, {
    role: 'director', ownSub: { plan: 'starter', status: 'active', trial_ends_at: null },
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' }],
  });
  try {
    await evalPage(member.page, `openEvModal('create'); document.getElementById('evm-name').value = 'Own launch'; submitEvModal(); 0`);
    await expect.poll(() => member.calls.some(c => c.method === 'POST' && c.path.startsWith('/rest/v1/leod_events'))).toBe(true);
    await expect(member.page.locator('#evm-error')).not.toContainText('plan allows');
  } finally { await member.ctx.close(); }
  // The same plan with one own event already: refused, nothing sent.
  const owner = await openConsole(browser, {
    role: 'director', ownSub: { plan: 'starter', status: 'active', trial_ends_at: null },
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true, plan: 'starter' }],
  });
  try {
    await evalPage(owner.page, `openEvModal('create'); document.getElementById('evm-name').value = 'Second launch'; submitEvModal(); 0`);
    await expect(owner.page.locator('#evm-error')).toContainText('plan allows 1 active event');
    expect(owner.calls.some(c => c.method === 'POST' && c.path.startsWith('/rest/v1/leod_events'))).toBe(false);
  } finally { await owner.ctx.close(); }
});

test('teams: an organiser plan that ended is refused on switch, and members see no prices', async ({ browser }) => {
  const ended = new Date(Date.parse('2026-10-06T08:40:00Z') - 3600e3).toISOString();
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' },
    { id: EV_B, name: 'Spring summit', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'trial', trialEndsAt: ended },
  ] });
  try {
    await afterBootReread(page);
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    await expect(toasts(page)).toContainText('The plan for this event has ended. Ask the organiser to renew it.');
    // At boot this screen shows inside the loading overlay; after boot the
    // overlay is gone, so read what the screen would show.
    await evalPage(page, 'showPlanEndedScreen(true); 0');
    expect(await evalPage(page, `(() => { const s = document.getElementById('trial-expired-screen');
      return { member: s.classList.contains('te-member'), shown: s.style.display,
               title: document.getElementById('te-title').textContent,
               plans: getComputedStyle(document.getElementById('te-plans')).display,
               promo: getComputedStyle(s.querySelector('.te-promo')).display }; })()`))
      .toEqual({ member: true, shown: 'flex', title: 'This event plan has ended', plans: 'none', promo: 'none' });
  } finally { await ctx.close(); }
});

const groupsAndItems = (page: Page) => evalPage(page,
  `[...document.querySelectorAll('#ev-pill-dd > .ev-dd-group, #ev-pill-dd > button[role="menuitemradio"]')]
     .map(el => (el.classList.contains('ev-dd-group') ? '# ' : '') + el.textContent.trim())`);

test('teams: the switcher groups events by organiser', async ({ browser }) => {
  const NORTHWIND = '0e0e0e0e-0000-4000-8000-0000000000a1';
  const ATLAS = '0e0e0e0e-0000-4000-8000-0000000000a2';
  const EV_D = 'd0d0d0d0-0000-4000-8000-0000000000d4';
  const { ctx, page } = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true },
    { id: EV_B, name: 'Spring summit',   role: 'stage',    isOwner: false, ownerId: NORTHWIND, organiser: 'Northwind Events' },
    { id: EV_C, name: 'Atlas awards',    role: 'av',       isOwner: false, ownerId: ATLAS,     organiser: 'Atlas Live' },
    { id: EV_D, name: 'Northwind forum', role: 'director', isOwner: false, ownerId: NORTHWIND, organiser: 'Northwind Events' },
  ] });
  try {
    expect(await groupsAndItems(page)).toEqual([
      '# Your events', 'GTR North Africa 2026',
      '# Atlas Live', 'Atlas awards',
      '# Northwind Events', 'Spring summit', 'Northwind forum',
    ]);
  } finally { await ctx.close(); }
});

test('teams: an organiser with only their own events sees no group headings', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {});
  try {
    expect(await groupsAndItems(page)).toEqual(['GTR North Africa 2026']);
  } finally { await ctx.close(); }
});

test('teams: an invited director edits the event but cannot deactivate it; the creator can', async ({ browser }) => {
  const invited = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER },
  ] });
  try {
    await evalPage(invited.page, `openEvModal('edit', '${EVENT_ID}'); 0`);
    await expect(invited.page.locator('#evm-deact')).toBeHidden();
    await evalPage(invited.page, `document.getElementById('evm-name').value = 'GTR North Africa 2026 (day 2)'; submitEvModal(); 0`);
    await expect.poll(() => invited.calls.some(c => c.method === 'PATCH' && c.path.startsWith('/rest/v1/leod_events'))).toBe(true);
    await expect(invited.page.locator('#ev-modal')).toBeHidden();
    await expect(invited.page.locator('#ev-pill-dd')).toContainText('Edit event');
  } finally { await invited.ctx.close(); }
  const creator = await openConsole(browser, {});
  try {
    await evalPage(creator.page, `openEvModal('edit', '${EVENT_ID}'); 0`);
    await expect(creator.page.locator('#evm-deact')).toBeVisible();
  } finally { await creator.ctx.close(); }
});

test('teams: a refused event edit says so instead of looking saved; crew see New event, not Edit', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER },
  ] });
  try {
    await expect(page.locator('#ev-pill-dd')).toContainText('New event');
    await expect(page.locator('#ev-pill-dd')).not.toContainText('Edit event');
    // Row security refuses an update by changing no row and returning no error.
    await page.route(/\/rest\/v1\/leod_events\?/, r => r.request().method() === 'PATCH'
      ? r.fulfill({ status: 200, contentType: 'application/json', body: '[]', headers: { 'access-control-allow-origin': '*' } })
      : r.fallback());
    await evalPage(page, `openEvModal('edit', '${EVENT_ID}'); submitEvModal(); 0`);
    await expect(page.locator('#evm-error')).toHaveText('Only the directors of this event can edit it.');
    await expect(page.locator('#ev-modal')).toBeVisible();
  } finally { await ctx.close(); }
});

const openTeam = async (page: Page) => {
  await evalPage(page, 'openUsersModal(); 0');
  await expect(page.locator('#team-seats')).not.toBeEmpty();
};
const member = (k: number, o: Record<string, unknown> = {}) => ({ user_id: `op-${k}`, name: `Crew ${k}`, email: `crew${k}@example.com`,
  role: 'av', active: true, last_sign_in_at: null, added_at: `2026-09-0${k}T09:00:00Z`, ...o });
const inviteReply = (fn: string, body: any) => fn === 'invite-operator'
  ? { status: 200, body: { ok: true, role: body.role, result: String(body.email).startsWith('new') ? 'invited' : 'added' } }
  : undefined;

test("team: the window shows this event's team, its seats and who organises it", async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {});
  try {
    await openTeam(page);
    await expect(page.locator('#users-modal-title')).toHaveText('Team for GTR North Africa 2026');
    await expect(page.locator('#team-seats')).toHaveText('Team 2 of 20 seats');
    await expect(page.locator('#users-modal-body .team-row')).toHaveCount(3);
    await expect(page.locator('#users-modal-body .team-row').first()).toContainText('Organiser');
    await expect(page.locator('.team-row[data-uid="op-2"]')).toHaveClass(/is-suspended/);
    await expect(page.locator('[data-fk="team-removeall-op-1"]')).toBeVisible();   // the creator may remove from all
    await expect(page.locator('#inv-btn')).toBeEnabled();
  } finally { await ctx.close(); }
});

test('team: inviting an existing account says it was added; a new email is invited; both name this event', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, { fnReply: inviteReply });
  try {
    await openTeam(page);
    await page.fill('#inv-email', 'karim@example.com');
    await page.selectOption('#inv-role', 'av');
    await page.locator('#inv-btn').click();
    await expect(page.locator('#inv-status')).toHaveText('karim@example.com was added to this event.');
    await page.fill('#inv-email', 'new.crew@example.com');
    await page.locator('#inv-btn').click();
    await expect(page.locator('#inv-status')).toHaveText('Invitation sent to new.crew@example.com.');
    const sent = calls.filter(c => c.path === '/functions/v1/invite-operator').map(c => c.body);
    expect(sent).toEqual([
      expect.objectContaining({ email: 'karim@example.com', role: 'av', event_id: EVENT_ID }),
      expect.objectContaining({ email: 'new.crew@example.com', event_id: EVENT_ID }),
    ]);
  } finally { await ctx.close(); }
});

test('team: a full team asks the owner to upgrade, and an invited director to ask the organiser', async ({ browser }) => {
  const full = { is_owner: true, seats: { used: 5, limit: 5 }, owner: defaultTeam().owner, members: [1, 2, 3, 4, 5].map(k => member(k)) };
  const owner = await openConsole(browser, { team: { [EVENT_ID]: full } });
  try {
    await openTeam(owner.page);
    await expect(owner.page.locator('#team-full')).toHaveText('All seats are taken. Upgrade for more seats.');
    await expect(owner.page.locator('#inv-btn')).toBeDisabled();
  } finally { await owner.ctx.close(); }
  const invited = await openConsole(browser, {
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER }],
    team: { [EVENT_ID]: { ...full, is_owner: false } },
  });
  try {
    await openTeam(invited.page);
    await expect(invited.page.locator('#team-full')).toHaveText('All seats are taken. Ask the organiser for more seats.');
    await expect(invited.page.locator('[data-fk="team-removeall-op-1"]')).toHaveCount(0);   // only the creator removes from all
  } finally { await invited.ctx.close(); }
  // The server refuses a seat the window thought was free (another director took it).
  const raced = await openConsole(browser, {
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER }],
    fnReply: (fn) => fn === 'invite-operator' ? { status: 409, body: { error: 'All seats on this event are taken', code: 'seats_full', is_owner: false } } : undefined,
  });
  try {
    await openTeam(raced.page);
    await raced.page.fill('#inv-email', 'late@example.com');
    await raced.page.locator('#inv-btn').click();
    await expect(raced.page.locator('#inv-status')).toHaveText('All seats are taken. Ask the organiser for more seats.');
  } finally { await raced.ctx.close(); }
});

test('team: over the seat count after a downgrade', async ({ browser }) => {
  const over = { is_owner: true, seats: { used: 7, limit: 5 }, owner: defaultTeam().owner, members: [1, 2, 3, 4, 5, 6, 7].map(k => member(k)) };
  const { ctx, page, calls } = await openConsole(browser, { team: { [EVENT_ID]: over } });
  try {
    await openTeam(page);
    await expect(page.locator('#team-seats')).toHaveText('Team 7 of 5 seats');
    await expect(page.locator('#inv-btn')).toBeDisabled();
    await expect(page.locator('#users-modal-body .team-row')).toHaveCount(8);   // nobody was cut off
    await expect(page.locator('[data-fk="team-role-op-3"]')).toBeEnabled();
    await page.locator('[data-fk="team-suspend-op-3"]').click();
    await expect.poll(() => calls.filter(c => c.path === '/functions/v1/manage-operator').map(c => c.body))
      .toEqual([{ user_id: 'op-3', action: 'suspend', event_id: EVENT_ID }]);
  } finally { await ctx.close(); }
});

test('team: remove takes two presses and names this event only; the person stays on the other event', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true },
    { id: EV_B, name: 'Spring summit', role: 'director', isOwner: true },
  ] });
  try {
    await afterBootReread(page);
    await openTeam(page);
    await page.locator('[data-fk="team-remove-op-1"]').click();
    await expect(page.locator('[data-fk="team-remove-op-1"]')).toHaveText('Press again to remove');
    expect(calls.filter(c => c.path === '/functions/v1/manage-operator')).toEqual([]);
    await page.locator('[data-fk="team-remove-op-1"]').click();
    await expect.poll(() => calls.filter(c => c.path === '/functions/v1/manage-operator').map(c => c.body))
      .toEqual([{ user_id: 'op-1', action: 'remove', event_id: EVENT_ID }]);
    await expect(toasts(page)).toContainText('Ahmed Fawzy was removed from this event.');
    await evalPage(page, 'closeUsersModal(); 0');
    await switchTo(page, EV_B);
    await openTeam(page);
    await expect(page.locator('.team-row[data-uid="op-1"]')).toHaveCount(1);
    await expect(page.locator('#users-modal-title')).toHaveText('Team for Spring summit');
  } finally { await ctx.close(); }
});

test('team: remove from all my events is the creator\'s, takes two presses and sends no event', async ({ browser }) => {
  const { ctx, page, calls } = await openConsole(browser, {});
  try {
    await openTeam(page);
    await page.locator('[data-fk="team-removeall-op-1"]').click();
    await expect(page.locator('[data-fk="team-removeall-op-1"]')).toHaveText('Press again to remove from all');
    await page.locator('[data-fk="team-removeall-op-1"]').click();
    await expect.poll(() => calls.filter(c => c.path === '/functions/v1/manage-operator').map(c => c.body))
      .toEqual([{ user_id: 'op-1', action: 'remove' }]);
    await expect(toasts(page)).toContainText('Ahmed Fawzy was removed from all your events.');
  } finally { await ctx.close(); }
});

test('team: a full Pro team keeps the seats, the invite row and Close on screen; the list scrolls', async ({ browser }) => {
  const twenty = { is_owner: true, seats: { used: 20, limit: 20 }, owner: defaultTeam().owner, members: Array.from({ length: 20 }, (_, i) => member(i + 1, { added_at: '2026-09-01T09:00:00Z' })) };
  const { ctx, page } = await openConsole(browser, { team: { [EVENT_ID]: twenty } });
  try {
    await openTeam(page);
    for (const sel of ['#users-modal-title', '#team-seats', '#inv-email', '#team-close']) await expect(page.locator(sel)).toBeInViewport();
    const scrolls = await evalPage(page, `(() => { const b = document.getElementById('users-modal-body'); return b.scrollHeight > b.clientHeight && getComputedStyle(b).overflowY === 'auto'; })()`);
    expect(scrolls).toBe(true);
    // nothing above the list is squeezed to make room for it
    expect(await evalPage(page, `document.getElementById('um-search').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(30);
  } finally { await ctx.close(); }
});

test('team: an invite the server refuses as already on this event says so', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {
    fnReply: (fn) => fn === 'invite-operator' ? { status: 409, body: { error: 'This person was just added to this event', code: 'already_on_event' } } : undefined,
  });
  try {
    await openTeam(page);
    await page.fill('#inv-email', 'ahmed@example.com');
    await page.locator('#inv-btn').click();
    await expect(page.locator('#inv-status')).toHaveText("This person is already on this event's team.");
    await expect(page.locator('#inv-status')).toHaveClass(/is-error/);
  } finally { await ctx.close(); }
});
