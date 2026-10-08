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
    // #plan-badge is display:none in CSS since the redesign: read what updatePlanBadge decided
    expect(await evalPage(page, `document.getElementById('plan-badge').style.display`)).toBe('none');
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
    await expect(toasts(page)).toContainText('Ahmed Fawzy was removed from this event.');
    // The mock keeps a team per event (console-boot-mock teamOf): gone here...
    await expect(page.locator('.team-row[data-uid="op-1"]')).toHaveCount(0);
    await evalPage(page, 'closeUsersModal(); 0');
    await switchTo(page, EV_B);
    await openTeam(page);
    // ...and still on the other event.
    await expect(page.locator('#users-modal-title')).toHaveText('Team for Spring summit');
    await expect(page.locator('.team-row[data-uid="op-1"]')).toHaveCount(1);
    expect(calls.filter(c => c.path === '/functions/v1/manage-operator').map(c => c.body))
      .toEqual([{ user_id: 'op-1', action: 'remove', event_id: EVENT_ID }]);
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

// ── Review round 1 (stage3-review.md F1, F8, F13): the switch is atomic ──
const sessionsOf = (id: string) => new RegExp(`/rest/v1/leod_sessions\\?.*event_id=eq\\.${id}`);
const startSwitch = (page: Page, id: string, tag: string) => evalPage(page,
  `window.__sw_${tag} = false; switchEvent('${id}').then(() => { window.__sw_${tag} = true; }, e => { window.__sw_${tag} = 'error: ' + (e && e.message); }); 0`);
async function waitSwitch(page: Page, tag: string) {
  for (let i = 0; i < 200; i++) {
    const done = await evalPage(page, `window.__sw_${tag}`);
    if (done === true) return;
    if (typeof done === 'string') throw new Error(done);
    await page.clock.runFor(50);
  }
  throw new Error(`switch ${tag} did not finish`);
}
const ctrlJoins = (page: Page) => evalPage(page,
  `(window.__rtSent || []).filter(m => m.event === 'phx_join' && String(m.topic).startsWith('realtime:leod-ctrl-')).map(m => m.topic.replace('realtime:leod-ctrl-', ''))`);

test('switch: while the new event loads, the old event keeps its own role and list', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'av', isOwner: false, ownerId: OTHER_OWNER },
    { id: EV_B, name: 'Spring summit', role: 'director', isOwner: false, ownerId: OTHER_OWNER },
  ] });
  try {
    await afterBootReread(page);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    await page.route(sessionsOf(EV_B), async r => { await gate; await r.fallback(); });
    await startSwitch(page, EV_B, 'b');
    for (let i = 0; i < 10; i++) await page.clock.runFor(50);
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('av');
    expect(await evalPage(page, 'S.role')).toBe('av');
    await expect(page.locator('#role-lock')).toHaveText('AV');
    release();
    await waitSwitch(page, 'b');
    expect(await evalPage(page, 'S.event.id')).toBe(EV_B);
    expect(await evalPage(page, 'S.userRole')).toBe('director');
  } finally { await ctx.close(); }
});

test('switch: a failed load of the new event stays fully on the current event and says so', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await afterBootReread(page);
    const before = await evalPage(page, 'S.sessions.map(s => s.id)');
    const joinsBefore = (await ctrlJoins(page)).length;
    await page.route(sessionsOf(EV_B), r => r.fulfill({ status: 500, contentType: 'application/json',
      body: JSON.stringify({ message: 'upstream timeout' }), headers: { 'access-control-allow-origin': '*' } }));
    await startSwitch(page, EV_B, 'f');
    await waitSwitch(page, 'f');
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('stage');
    expect(await evalPage(page, 'S.sessions.map(s => s.id)')).toEqual(before);
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    expect((await ctrlJoins(page)).length).toBe(joinsBefore);   // realtime untouched
    await expect(toasts(page)).toContainText('Could not open Spring summit. You are still on GTR North Africa 2026.');
  } finally { await ctx.close(); }
});

test('switch: only the latest of two quick switches applies', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: [
    ...twoEvents(),
    { id: EV_C, name: 'Atlas awards', role: 'av', isOwner: false, ownerId: OTHER_OWNER, organiser: 'Nilegate Events' },
  ] });
  try {
    await afterBootReread(page);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    await page.route(sessionsOf(EV_B), async r => { await gate; await r.fallback(); });
    await startSwitch(page, EV_B, 'b');
    for (let i = 0; i < 5; i++) await page.clock.runFor(50);
    await startSwitch(page, EV_C, 'c');
    await waitSwitch(page, 'c');
    release();
    await waitSwitch(page, 'b');
    for (let i = 0; i < 10; i++) await page.clock.runFor(50);
    expect(await evalPage(page, 'S.event.id')).toBe(EV_C);
    expect(await evalPage(page, 'S.userRole')).toBe('av');
    expect((await ctrlJoins(page)).pop()).toBe(EV_C);
    expect(await ctrlJoins(page)).not.toContain(EV_B);
  } finally { await ctx.close(); }
});

test('switch: a refused switch still applies a role change on the current event', async ({ browser }) => {
  const mine = twoEvents();
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: mine });
  try {
    await afterBootReread(page);
    mine[0].role = 'av';    // the organiser changed this person's role here
    mine.splice(1, 1);      // and removed them from Spring summit
    await switchTo(page, EV_B);
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('av');
    await expect(page.locator('#role-lock')).toHaveText('AV');
  } finally { await ctx.close(); }
});

// ── Review round 1 (F2): a failed read at boot never leaves a blank console ──
test('boot: a failed events read with nothing of your own keeps a clear message and Retry', async ({ browser }) => {
  const fail = ['cuedeck_my_events'];
  const { ctx, page } = await openConsole(browser, { role: 'stage', rpcFail: fail, waitBoot: false,
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER }] });
  try {
    await expect(page.locator('#load-step')).toHaveText('Could not load your events. Check your connection and try again.', { timeout: 30_000 });
    await expect(page.locator('#boot-retry')).toBeVisible();
    await page.waitForTimeout(3500);   // the old boot error hid the overlay after 3 s
    await expect(page.locator('#loading-overlay')).toBeVisible();
    await expect(page.locator('#boot-retry')).toBeVisible();
    expect(await evalPage(page, 'S.event')).toBeNull();
    fail.length = 0;                   // the connection is back
    await page.locator('#boot-retry').click();
    await expect(page.locator('#loading-overlay')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
  } finally { await ctx.close(); }
});

test('boot: a failed events read never locks the creator out of their own events', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'director', rpcFail: ['cuedeck_my_events'], myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: true },
    { id: EV_B, name: 'Spring summit', role: 'stage', isOwner: false, ownerId: OTHER_OWNER, organiser: 'Northwind Events' },
  ] });
  try {
    expect(await evalPage(page, 'S.event.id')).toBe(EVENT_ID);
    expect(await evalPage(page, 'S.userRole')).toBe('director');
    expect(await evalPage(page, 'S.events.map(e => e.id)')).toEqual([EVENT_ID]);   // other organisers' events wait for a good read
    await expect(page.locator('#viewas-btn')).toBeVisible();
    expect(await evalPage(page, `document.getElementById('boot-retry')?.offsetParent ?? null`)).toBeNull();
  } finally { await ctx.close(); }
});

test('boot: a failed plan read lets everyone in; no trial is created while the plan is unknown', async ({ browser }) => {
  const member = await openConsole(browser, { role: 'stage', rpcFail: ['get_subscription_for_user'], ownSub: null,
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' }] });
  try {
    await expect(member.page.locator('#role-lock')).toHaveText('Stage');
    expect(await evalPage(member.page, 'S.planLimits.label')).toBe('Pro');
    expect(member.calls.filter(c => c.method === 'POST' && c.path.startsWith('/rest/v1/leod_subscriptions'))).toEqual([]);
  } finally { await member.ctx.close(); }
  const fail = ['get_subscription_for_user'];
  const creator = await openConsole(browser, { role: 'director', rpcFail: fail, ownSub: null });
  try {
    expect(await evalPage(creator.page, 'S.event.id')).toBe(EVENT_ID);
    await evalPage(creator.page, `openEvModal('create'); document.getElementById('evm-name').value = 'Own launch'; submitEvModal(); 0`);
    await expect(creator.page.locator('#evm-error')).toHaveText('Could not check your plan. Try again.');
    expect(creator.calls.filter(c => c.method === 'POST' && /\/rest\/v1\/leod_(subscriptions|events)/.test(c.path))).toEqual([]);
  } finally { await creator.ctx.close(); }
});

// ── Review round 1 (F3): the AI panels follow the current event's plan ──
test('teams: the AI panels follow the current event owner\'s plan on every switch', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'director', myEvents: [
    { id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' },
    { id: EV_B, name: 'Spring summit', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'starter' },
  ] });
  const shown = () => evalPage(page, `['ai-agents-wrap', 'ave-brain-wrap'].map(id => document.getElementById(id).style.display)`);
  try {
    await afterBootReread(page);
    expect(await shown()).toEqual(['', '']);
    await switchTo(page, EV_B);
    expect(await shown()).toEqual(['none', 'none']);
    await evalPage(page, `setRole('director'); 0`);   // View as director again does not bring them back
    expect(await shown()).toEqual(['none', 'none']);
    await switchTo(page, EVENT_ID);
    expect(await shown()).toEqual(['', '']);
  } finally { await ctx.close(); }
});

// ── Review round 1 (F4, F11): the Team card's size ──
test('team: at 1440 the card is wide enough for each member\'s actions on one row; the fields are 44 px', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, {});
  try {
    await openTeam(page);
    const g = await evalPage(page, `(() => { const r = s => document.querySelector(s).getBoundingClientRect();
      const acts = ['team-role-op-1', 'team-suspend-op-1', 'team-remove-op-1', 'team-removeall-op-1'].map(k => Math.round(r('[data-fk="' + k + '"]').top + r('[data-fk="' + k + '"]').height / 2));
      return { card: Math.round(r('#users-modal .ev-modal-card').width), acts,
               fields: ['#inv-email', '#inv-name', '#inv-role', '#inv-btn', '#um-search'].map(s => Math.round(r(s).height)) }; })()`);
    expect(g.card).toBeGreaterThanOrEqual(560);
    expect(Math.max(...g.acts) - Math.min(...g.acts)).toBeLessThanOrEqual(2);   // one row
    expect(g.fields).toEqual([44, 44, 44, 44, 44]);
  } finally { await ctx.close(); }
});

test('team: on a short screen the member list keeps a usable height', async ({ browser }) => {
  const twenty = { is_owner: true, seats: { used: 20, limit: 20 }, owner: defaultTeam().owner, members: Array.from({ length: 20 }, (_, i) => member(i + 1, { added_at: '2026-09-01T09:00:00Z' })) };
  const { ctx, page } = await openConsole(browser, { viewport: { width: 900, height: 420 }, team: { [EVENT_ID]: twenty } });
  try {
    await openTeam(page);
    expect(await evalPage(page, `document.getElementById('users-modal-body').getBoundingClientRect().height`)).toBeGreaterThanOrEqual(120);
  } finally { await ctx.close(); }
});

// ── Review round 1 (F5): members-only means never created an event (spec §5) ──
const STALE_TRIAL = { plan: 'trial', status: 'active', trial_ends_at: '2026-09-20T08:00:00Z' };   // left by the old console
test('teams: a member with a leftover trial row sees no trial badge, upgrade or billing', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'director', ownSub: STALE_TRIAL,
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'director', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro' }] });
  try {
    expect(await evalPage(page, 'isMembersOnlyAccount()')).toBe(true);
    expect(await evalPage(page, `document.getElementById('plan-badge').style.display`)).toBe('none');
    expect(await evalPage(page, `renderProfilePanel(); ['pp-plan-section', 'pp-upgrade-wrap', 'pp-billing-btn', 'pp-invoices-btn'].map(id => document.getElementById(id).style.display)`))
      .toEqual(['none', 'none', 'none', 'none']);
    expect(await evalPage(page, `toggleProfileEdit(); document.getElementById('pp-billing-section').style.display`)).toBe('none');
    expect(await evalPage(page, `['hm-billing', 'hm-invoices'].map(id => document.getElementById(id).style.display)`)).toEqual(['none', 'none']);
  } finally { await ctx.close(); }
});

test('teams: a member with a leftover trial whose event plans all ended gets the screen without prices', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', ownSub: STALE_TRIAL, waitBoot: false,
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER, plan: 'pro', planStatus: 'canceled' }] });
  try {
    await expect(page.locator('#trial-expired-screen')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#trial-expired-screen')).toHaveClass(/te-member/);
    await expect(page.locator('#te-title')).toHaveText('This event plan has ended');
  } finally { await ctx.close(); }
});

test('teams: an organiser keeps the trial badge and billing', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'director', ownSub: { plan: 'trial', status: 'active', trial_ends_at: '2026-10-08T08:00:00Z' } });
  try {
    expect(await evalPage(page, 'isMembersOnlyAccount()')).toBe(false);
    expect(await evalPage(page, `[document.getElementById('plan-badge').style.display, document.getElementById('plan-badge').textContent.startsWith('TRIAL')]`)).toEqual(['', true]);
    expect(await evalPage(page, `['hm-billing', 'hm-invoices'].map(id => document.getElementById(id).style.display)`)).toEqual(['', '']);
  } finally { await ctx.close(); }
});

// ── Review round 1 (F6, F7): Send after a failed re-read, and on a full team ──
test('team: a failed re-read after an invite leaves Send usable', async ({ browser }) => {
  const fail: string[] = [];
  const { ctx, page } = await openConsole(browser, { rpcFail: fail, fnReply: inviteReply });
  try {
    await openTeam(page);
    fail.push('cuedeck_event_team');
    await page.fill('#inv-email', 'new.crew@example.com');
    await page.locator('#inv-btn').click();
    await expect(page.locator('#inv-status')).toHaveText('Invitation sent to new.crew@example.com.');
    await expect(page.locator('#users-modal-body')).toContainText('Could not load the team.');
    await expect(page.locator('#inv-btn')).toBeEnabled();
    await expect(page.locator('#inv-btn')).toHaveText('Send invite');
  } finally { await ctx.close(); }
});

test('team: a full team still changes the role of, or resends to, someone already on it', async ({ browser }) => {
  const full = { is_owner: true, seats: { used: 5, limit: 5 }, owner: defaultTeam().owner, members: [1, 2, 3, 4, 5].map(k => member(k)) };
  const { ctx, page, calls } = await openConsole(browser, { team: { [EVENT_ID]: full },
    fnReply: (fn, body) => fn === 'invite-operator' ? { status: 200, body: { ok: true, role: body.role, result: 'role_changed' } } : undefined });
  try {
    await openTeam(page);
    await expect(page.locator('#inv-btn')).toBeDisabled();
    await page.fill('#inv-email', 'Crew3@example.com');
    await expect(page.locator('#inv-btn')).toBeEnabled();
    await page.selectOption('#inv-role', 'stage');
    await page.locator('#inv-btn').click();
    await expect(page.locator('#inv-status')).toHaveText('Role changed to Stage.');
    expect(calls.filter(c => c.path === '/functions/v1/invite-operator').map(c => c.body))
      .toEqual([expect.objectContaining({ email: 'Crew3@example.com', role: 'stage', event_id: EVENT_ID })]);
    await page.fill('#inv-email', 'someone.new@example.com');
    await expect(page.locator('#inv-btn')).toBeDisabled();
  } finally { await ctx.close(); }
});

// ── Review round 1 (F9): the last role is remembered per event ──
test('teams: different roles on two events are not a role change; a real change is told per event, translated', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', myEvents: twoEvents() });
  try {
    await evalPage(page, `localStorage.setItem('cuedeck_last_role_${USER_ID}', 'director'); delete S._showRoleChange; delete S._showWelcome; noteRoleForWelcome(); 0`);
    expect(await evalPage(page, 'S._showRoleChange || null')).toBeNull();     // director on the other event is not a change here
    expect(await evalPage(page, 'S._showWelcome || null')).toBeNull();
    await evalPage(page, `localStorage.setItem('cuedeck_last_role_${USER_ID}_${EVENT_ID}', 'av'); noteRoleForWelcome(); showRoleNotice(); 0`);
    await expect(toasts(page)).toContainText('Your role on GTR North Africa 2026 is now Stage.');
  } finally { await ctx.close(); }
});

// ── Review round 1 (F10): a legacy pending account on an event team gets in ──
test('teams: an account still marked pending that is on an event team opens the console', async ({ browser }) => {
  const { ctx, page } = await openConsole(browser, { role: 'stage', accountRole: 'pending',
    myEvents: [{ id: EVENT_ID, name: 'GTR North Africa 2026', role: 'stage', isOwner: false, ownerId: OTHER_OWNER }] });
  try {
    await expect(page.locator('#pending-screen')).toBeHidden();
    await expect(page.locator('#role-lock')).toHaveText('Stage');
    expect(await evalPage(page, 'S.accountRole')).toBe('pending');
  } finally { await ctx.close(); }
});
