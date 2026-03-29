#!/usr/bin/env node
/**
 * CueDeck Caption-Synchronized Demo Recorder
 *
 * Records screen demos where UI actions are timed to match SRT caption narration.
 * Each episode's recording lasts exactly as long as its SRT file.
 * Actions fire at specific seconds matching what the captions describe.
 *
 * Features:
 *   - Smooth visible cursor overlay (dot + click ripple)
 *   - Auth persistence via storageState (login once in ep01, reuse in ep02+)
 *   - Onboarding guides hidden after ep01
 *   - Professional pacing with hover-before-click
 *
 * Usage:
 *   node scripts/youtube-pipeline/record-demo.mjs 3       # record episode 3
 *   node scripts/youtube-pipeline/record-demo.mjs 1       # record episode 1 (does login)
 *   node scripts/youtube-pipeline/record-demo.mjs --all   # record all 21 episodes in order
 *
 * Prerequisites:
 *   - CueDeck console running at http://127.0.0.1:7230/cuedeck-console.html
 *   - Demo data loaded (sessions in PLANNED state for ep01-03 start)
 *   - Playwright browsers installed: npx playwright install chromium
 *   - .env with CUEDECK_EMAIL and CUEDECK_PASSWORD
 *
 * Output: youtube-branding/recordings/ep{NN}-raw.webm
 */

import { chromium } from '@playwright/test';
import { mkdirSync, renameSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUT_DIR = resolve(ROOT, 'youtube-branding/recordings');
const CAPTIONS_DIR = resolve(ROOT, 'youtube-branding/captions');
const AUTH_STATE = resolve(ROOT, 'youtube-branding/.auth-state.json');
const CONSOLE_URL = 'http://127.0.0.1:7230/cuedeck-console.html';
const DISPLAY_URL = 'http://127.0.0.1:7230/cuedeck-display.html';

// ─── Credentials ────────────────────────────────────────────────────────────
function loadCredentials() {
  let email = process.env.CUEDECK_EMAIL;
  let password = process.env.CUEDECK_PASSWORD;
  if (!email || !password) {
    const envPath = resolve(ROOT, '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const [k, ...v] = line.split('=');
        if (k.trim() === 'CUEDECK_EMAIL') email = v.join('=').trim();
        if (k.trim() === 'CUEDECK_PASSWORD') password = v.join('=').trim();
      }
    }
  }
  return { email, password };
}

// ─── SRT Parser ─────────────────────────────────────────────────────────────
function parseSRT(epNum) {
  const pad = String(epNum).padStart(2, '0');
  const srtPath = resolve(CAPTIONS_DIR, `ep${pad}-captions.srt`);
  if (!existsSync(srtPath)) return { totalDuration: 180, captions: [] };

  const text = readFileSync(srtPath, 'utf8');
  const blocks = text.trim().split(/\n\n+/);
  const captions = [];
  let maxEnd = 0;

  for (const block of blocks) {
    const lines = block.split('\n');
    if (lines.length < 3) continue;
    const timeMatch = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d+)\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d+)/
    );
    if (!timeMatch) continue;
    const startSec =
      parseInt(timeMatch[1]) * 3600 +
      parseInt(timeMatch[2]) * 60 +
      parseInt(timeMatch[3]) +
      parseInt(timeMatch[4]) / 1000;
    const endSec =
      parseInt(timeMatch[5]) * 3600 +
      parseInt(timeMatch[6]) * 60 +
      parseInt(timeMatch[7]) +
      parseInt(timeMatch[8]) / 1000;
    const content = lines.slice(2).join(' ').trim();
    captions.push({ start: startSec, end: endSec, text: content });
    if (endSec > maxEnd) maxEnd = endSec;
  }

  return { totalDuration: maxEnd + 3, captions }; // +3s buffer at end
}

// ─── Cursor Overlay (arrow cursor shape) ────────────────────────────────────
// SVG arrow cursor — white fill, dark shadow border, classic upper-left pointer
const CURSOR_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='22' height='28' viewBox='0 0 22 28'%3E%3Cpath d='M2 2 L2 24 L8 18 L13 28 L16 26.5 L11 16.5 L18 16.5 Z' fill='white' stroke='%23222' stroke-width='1.5' stroke-linejoin='round'/%3E%3C/svg%3E`;

async function injectCursor(page) {
  await page.addStyleTag({
    content: `
      #cd-cursor {
        position: fixed; width: 22px; height: 28px;
        background: url("${CURSOR_SVG}") no-repeat 0 0 / contain;
        pointer-events: none; z-index: 99999;
        left: 960px; top: 540px;
        filter: drop-shadow(0 1px 3px rgba(0,0,0,0.4));
        transition: none;
      }
      @keyframes cd-ripple {
        0%   { transform: translate(-50%,-50%) scale(1); opacity: 0.7; }
        100% { transform: translate(-50%,-50%) scale(3); opacity: 0; }
      }
      .cd-click-ring {
        position: fixed; width: 20px; height: 20px; border-radius: 50%;
        border: 2px solid rgba(59,130,246,0.9); pointer-events: none; z-index: 99998;
        transform: translate(-50%,-50%);
        animation: cd-ripple 0.45s ease-out forwards;
      }
    `,
  });
  await page.addScriptTag({
    content: `(() => {
      const c = document.createElement('div');
      c.id = 'cd-cursor';
      // Set initial position as inline styles so parseFloat works
      c.style.left = '960px';
      c.style.top = '540px';
      document.body.appendChild(c);
      // Track position in a global so smoothMoveTo can read it without DOM
      window.__cdPos = { x: 960, y: 540 };
      window.__cdMove = (x,y) => {
        c.style.left = x+'px'; c.style.top = y+'px';
        window.__cdPos = { x, y };
      };
      window.__cdRipple = (x,y) => {
        const r = document.createElement('div');
        r.className = 'cd-click-ring';
        r.style.left = x+'px'; r.style.top = y+'px';
        document.body.appendChild(r);
        setTimeout(() => r.remove(), 500);
      };
    })();`,
  });
}

// ─── Timing Helpers ─────────────────────────────────────────────────────────
async function waitUntilSec(page, startTime, targetSec) {
  const targetMs = targetSec * 1000;
  while (Date.now() - startTime < targetMs) {
    await page.waitForTimeout(100);
  }
}

// ─── Smooth Interaction Helpers ─────────────────────────────────────────────
function clampCoord(v, max) {
  return Math.round(Math.max(0, Math.min(max, isFinite(v) ? v : max / 2)));
}

async function smoothMoveTo(page, x, y, steps = 20) {
  // Read tracked position (avoids NaN from unset CSS style.left)
  const cur = await page.evaluate(() =>
    window.__cdPos || { x: 960, y: 540 }
  );
  const tx = clampCoord(x, 1919);
  const ty = clampCoord(y, 1079);
  const sx = clampCoord(cur.x, 1919);
  const sy = clampCoord(cur.y, 1079);

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const cx = clampCoord(sx + (tx - sx) * ease, 1919);
    const cy = clampCoord(sy + (ty - sy) * ease, 1079);
    await page.evaluate(([px, py]) => window.__cdMove(px, py), [cx, cy]);
    await page.mouse.move(cx, cy);
    await page.waitForTimeout(15);
  }
}

async function smoothClick(page, selector, label) {
  const el = page.locator(selector).first();
  // Scroll into view first (handles elements in scrollable panels/modals below viewport)
  await el.scrollIntoViewIfNeeded().catch(() => {});
  // Use boundingBox (not isVisible) — more reliable inside modals/transitions
  const box = await el.boundingBox().catch(() => null);
  if (!box) {
    if (label) console.log(`    ⚠ Not visible: ${label}`);
    return false;
  }
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await smoothMoveTo(page, x, y);
  await page.waitForTimeout(350); // hover pause
  await page.evaluate(([px, py]) => window.__cdRipple(px, py), [x, y]);
  await el.click({ force: true }); // force:true bypasses Playwright visibility gate
  if (label) console.log(`    🖱 ${label}`);
  await page.waitForTimeout(600);
  return true;
}

async function smoothType(page, selector, text, label, charDelay = 55) {
  const el = page.locator(selector).first();
  if (!(await el.isVisible().catch(() => false))) return false;
  const box = await el.boundingBox();
  if (box) {
    await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(300);
  }
  await el.click();
  await page.waitForTimeout(200);
  for (const char of text) {
    await page.keyboard.type(char, { delay: charDelay + Math.random() * (charDelay * 0.4) });
  }
  if (label) console.log(`    ⌨️ ${label}`);
  await page.waitForTimeout(400);
  return true;
}

async function smoothScroll(page, px, steps = 3) {
  const per = Math.round(px / steps);
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, per);
    await page.waitForTimeout(500);
  }
}

async function pressKey(page, key, label) {
  await page.keyboard.press(key);
  if (label) console.log(`    ⌨️ ${label}`);
  await page.waitForTimeout(600);
}

// ─── Page Loading ───────────────────────────────────────────────────────────
// showLogin = true: ep02 mode — navigate, inject cursor, return immediately on login screen.
// Cues handle the actual login at the right caption timestamp.
async function loadConsole(page, { doLogin = false, hideGuides = true, showLogin = false } = {}) {
  await page.goto(CONSOLE_URL);
  await page.waitForTimeout(2000);

  // ── Ep02 mode: start recording on the login form ──────────────────────────
  if (showLogin) {
    const loginVisible = await page.locator('#login-form').isVisible().catch(() => false);
    if (!loginVisible) {
      console.log('    ⚠ Expected login form but it\'s not visible — check that storageState was skipped');
    }
    await injectCursor(page);
    console.log('    ✓ Login screen ready');
    return;
  }

  // Login if needed
  const loginVisible = await page.locator('#login-form').isVisible().catch(() => false);
  if (loginVisible && doLogin) {
    const { email, password } = loadCredentials();
    if (email && password) {
      console.log('    🔑 Logging in...');
      await page.locator('#lf-email').fill(email);
      await page.locator('#lf-password').fill(password);
      await page.locator('#login-form button[type=submit]').click();
      await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 30000 }).catch(() => {});
      await page.waitForTimeout(2000);
    }
  } else if (loginVisible) {
    // Not logging in but login form shows — force dismiss (shouldn't happen with storageState)
    console.log('    ⚠ Login form visible but doLogin=false — check storageState');
  }

  // Wait for app to load
  await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {
    page.evaluate(() => {
      const ol = document.getElementById('loading-overlay');
      if (ol) ol.style.display = 'none';
    });
  });

  // Wait for boot() to finish: S.user.id is populated once auth + loadSnapshot complete
  // S is a top-level `const` (not window.S) so reference it directly in the page context
  await page.waitForFunction(() => typeof S !== 'undefined' && !!S?.user?.id,
    { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(800); // extra buffer for setTimeout(showRoleTips, 800) to have been queued

  // Hide onboarding elements + AI agent overlays that could block recording clicks
  if (hideGuides) {
    await page.evaluate(() => {
      const hide = (sel) => {
        document.querySelectorAll(sel).forEach((el) => (el.style.display = 'none'));
      };
      hide('#welcome-modal');
      hide('#wizard-modal');
      hide('#checklist-wrap');
      hide('#ob-tip');

      // ── Layer 1: override the functions that show guides ──────────────────
      // boot() calls initChecklist() directly and setTimeout(showRoleTips, 800).
      // Overriding them stops any call that fires after this evaluate.
      window.initChecklist  = () => {};
      window.showRoleTips   = () => {};
      window.showTipAt      = () => {};
      window._tipQueue      = [];

      // ── Layer 2: set localStorage dismissed keys (functions check these first)
      // This handles any call that slips through before the override takes effect.
      try {
        const uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : 'anon';
        const roles = ['director', 'stage', 'av', 'interp', 'reg', 'signage'];
        roles.forEach(r => localStorage.setItem('cuedeck_tips_' + uid + '_' + r, '1'));
        localStorage.setItem('cuedeck_ck_' + uid + '_dismissed', '1');
      } catch (_) {}

      // ── Layer 3: MutationObserver backstop — catches any display: '' that sneaks through
      const GUARD = ['#cuedeck-cue-overlay', '#cuedeck-cue-modal', '#ob-tip', '#checklist-wrap'];
      hide('#cuedeck-cue-overlay');
      hide('#cuedeck-cue-modal');
      const obs = new MutationObserver(() => {
        GUARD.forEach(s => {
          const el = document.querySelector(s);
          if (el && el.style.display !== 'none') el.style.display = 'none';
        });
      });
      obs.observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    await page.waitForTimeout(300);
  }

  // Inject cursor overlay
  await injectCursor(page);
  console.log('    ✓ Console loaded');
}

// ─── Ep02 Pre-recording Cleanup ─────────────────────────────────────────────
// Deletes all events + sessions for the demo user so the empty console + wizard
// shows when ep02 recording starts. Runs headless using the ep01 auth-state.
async function cleanupForEp02() {
  if (!existsSync(AUTH_STATE)) {
    console.log('  ⚠ No auth-state found — skipping cleanup (will record with whatever state is in DB)');
    return;
  }
  console.log('  🧹 Cleanup: deleting all demo events so ep02 starts empty...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    storageState: AUTH_STATE,
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();
  try {
    await page.goto(CONSOLE_URL);
    await page.waitForFunction(() => typeof S !== 'undefined' && !!S?.user?.id,
      { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1000);

    const result = await page.evaluate(async () => {
      try {
        // The app's Supabase client is stored as `sb` (const in the page's non-module script)
        // Use the raw CDN namespace to create a fresh client using the same constants,
        // which avoids having to rely on the app's `sb` variable name
        const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: { persistSession: false },
        });

        // Fetch the current user's session token so RLS policies allow deletions
        const { data: { session } } = await sb.auth.getSession();
        if (!session) return { error: 'No active session found' };

        // Use the app's authenticated client (sb) for deletes — RLS requires auth
        const { data: events, error: evErr } = await sb.from('leod_events').select('id');
        if (evErr) return { error: evErr.message };
        if (!events || events.length === 0) return { deleted: 0 };

        let deleted = 0;
        for (const ev of events) {
          await sb.from('leod_sessions').delete().eq('event_id', ev.id);
          const { error: delErr } = await sb.from('leod_events').delete().eq('id', ev.id);
          if (!delErr) deleted++;
        }
        return { deleted };
      } catch (e) {
        return { error: String(e) };
      }
    });

    if (result.error) {
      console.log(`  ⚠ Cleanup error: ${result.error}`);
    } else {
      console.log(`  ✓ Cleanup done: ${result.deleted} event(s) deleted`);
    }
  } finally {
    await page.close();
    await context.close();
    await browser.close();
  }
}

// Helper: switch role
async function switchRole(page, role) {
  await smoothClick(page, `[data-role="${role}"]`, `Switch to ${role}`);
  await page.waitForTimeout(800);
}

// Helper: find an action button by text via JS (robust, bypasses selector quirks)
async function findBtnCoords(page, text) {
  return page.evaluate((txt) => {
    // Use getBoundingClientRect for visibility — offsetParent fails inside fixed containers
    function isVisibleEl(el) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0;
    }
    const btns = [...document.querySelectorAll('.ctx-btn, .abtn')];
    const btn = btns.find(
      (b) => b.textContent.trim() === txt && isVisibleEl(b) && !b.disabled
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  }, text);
}

// Helper: wait for a button then click it via JS coords + smooth cursor
async function clickBtn(page, text, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let coords = null;
  while (Date.now() < deadline) {
    coords = await findBtnCoords(page, text);
    if (coords) break;
    await page.waitForTimeout(350);
  }
  if (!coords) {
    console.log(`    ⚠ Button not found: "${text}"`);
    return false;
  }
  await smoothMoveTo(page, coords.x, coords.y);
  await page.waitForTimeout(350);
  await page.evaluate(([px, py]) => window.__cdRipple(px, py), [coords.x, coords.y]);
  await page.mouse.click(coords.x, coords.y);
  console.log(`    🖱 ${text}`);
  await page.waitForTimeout(700);
  return true;
}

// Aliases
async function clickCtxBtn(page, text) { return clickBtn(page, text); }
async function clickCardBtn(page, text) { return clickBtn(page, text); }

// Helper: click nth session card (0-indexed)
async function clickSession(page, n = 0) {
  const card = page.locator('.sc').nth(n);
  if (await card.isVisible().catch(() => false)) {
    const box = await card.boundingBox();
    if (box) {
      await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(350);
      await page.evaluate(([px, py]) => window.__cdRipple(px, py), [
        box.x + box.width / 2,
        box.y + box.height / 2,
      ]);
      await card.click();
      console.log(`    🖱 Select session #${n + 1}`);
      await page.waitForTimeout(800);
      return true;
    }
  }
  return false;
}

// ─── EPISODE CUE DEFINITIONS ───────────────────────────────────────────────
// Each episode: { name, doLogin, hideGuides, cues: [{ at: seconds, fn }] }
// `at` = seconds from recording start when this action should fire.
// Cue timestamps are aligned with what the SRT captions describe.

const EPISODES = {
  // ── Episode 1: Welcome & Overview ────────────────────────────────────────
  1: {
    name: 'Welcome & Overview',
    doLogin: true,
    hideGuides: true,
    cues: [
      // 0:00-0:25 intro narration — just show the loaded console
      { at: 5, fn: async (page) => {
        // Console already visible after loadConsole
        console.log('    📍 Console visible — intro narration');
      }},
      // 0:25-1:10 "What is CueDeck" — show session list, context panel
      { at: 28, fn: async (page) => {
        // Dismiss any remaining onboarding modals
        await page.evaluate(() => {
          document.querySelectorAll('#welcome-modal, #wizard-modal, .tooltip-overlay, .tip-card')
            .forEach(el => el.style.display = 'none');
        });
        await page.waitForTimeout(500);
      }},
      { at: 35, fn: async (page) => {
        await clickSession(page, 0);
      }},
      { at: 50, fn: async (page) => {
        // Show context panel actions
        console.log('    📍 Showing context panel');
      }},
      // 1:21-1:50 "The Roles" — switch each role 1s before its describing caption
      // Caption timestamps: Director@87.5s, Stage@92.35s, AV@96s,
      //                     Interp@99.3s, Reg@103s, Signage@105.9s
      { at: 86, fn: async (page) => { await switchRole(page, 'director'); }},
      { at: 91, fn: async (page) => { await switchRole(page, 'stage'); }},
      { at: 95, fn: async (page) => { await switchRole(page, 'av'); }},
      { at: 98, fn: async (page) => { await switchRole(page, 'interp'); }},
      { at: 102, fn: async (page) => { await switchRole(page, 'reg'); }},
      { at: 105, fn: async (page) => { await switchRole(page, 'signage'); }},
      { at: 110, fn: async (page) => { await switchRole(page, 'director'); }},
      // 1:55-3:30 "What's coming" — show signage, stage monitor
      { at: 120, fn: async (page) => {
        await clickSession(page, 0);
      }},
      { at: 135, fn: async (page) => {
        await smoothScroll(page, 400);
      }},
      { at: 150, fn: async (page) => {
        await smoothScroll(page, -400);
      }},
      // 3:30-4:00 CTA — final console view
      { at: 210, fn: async (page) => {
        console.log('    📍 Final overview');
      }},
    ],
  },

  // ── Episode 2: Create Your First Event & Add Sessions ────────────────────
  // IMPORTANT: ep02 uses showLogin:true + preCleanup:true.
  //   • preCleanup deletes all events so the console starts empty
  //   • showLogin:true means loadConsole() returns immediately on the login screen
  //   • Login is performed by cues at the correct caption timestamps
  //   • The setup wizard is shown manually at t=53 (caption 17)
  //   • Sessions are added via + button (wizard step 1 is skipped)
  //   • Reorder uses hover + click on .sc-mgmt-btn (▲▼ arrows on each card)
  //   • Edit session modal closed via Save button, NOT Escape
  2: {
    name: 'Create Event & Sessions',
    doLogin: false,
    hideGuides: false,   // do NOT suppress wizard — we trigger it manually at t=53
    showLogin: true,     // recording starts on the login screen
    preCleanup: true,    // delete all events + sessions before recording
    cues: [
      // 0:05-0:27 intro narration — login form visible, cursor idle on page
      { at: 5, fn: async (page) => {
        console.log('    📍 Login screen — intro narration playing');
      }},

      // 0:20.5 "This is Tech Summit 2026" — move cursor gently toward email field
      { at: 20, fn: async (page) => {
        const el = page.locator('#lf-email');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2 - 30);
      }},

      // 0:27.9 "You land here." — settle cursor on email field
      { at: 27, fn: async (page) => {
        const el = page.locator('#lf-email');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(600);
      }},

      // 0:30.2 "Enter your email and password, hit sign in."
      { at: 30, fn: async (page) => {
        const { email } = loadCredentials();
        await smoothType(page, '#lf-email', email || '', 'Type email', 80);
      }},

      { at: 32, fn: async (page) => {
        const { password } = loadCredentials();
        await smoothType(page, '#lf-password', password || '', 'Type password', 80);
      }},

      // 0:34 Click Sign In — block until app loaded, then defer wizard to t=53
      { at: 34, fn: async (page) => {
        await smoothClick(page, '#login-form button[type=submit]', 'Sign in');
        await page.locator('#loading-overlay').waitFor({ state: 'hidden', timeout: 25000 }).catch(() => {});
        await page.waitForFunction(() => typeof S !== 'undefined' && !!S?.user?.id, { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(600);

        await page.evaluate(() => {
          const hide = (sel) => document.querySelectorAll(sel).forEach(e => (e.style.display = 'none'));
          hide('#welcome-modal'); hide('#checklist-wrap'); hide('#ob-tip');
          hide('#cuedeck-cue-overlay'); hide('#cuedeck-cue-modal'); hide('#wizard-modal');
          window.initChecklist = () => {}; window.showRoleTips = () => {};
          window.showTipAt = () => {}; window._tipQueue = [];
          try {
            const uid = (typeof S !== 'undefined' && S?.user?.id) ? S.user.id : 'anon';
            ['director','stage','av','interp','reg','signage'].forEach(r =>
              localStorage.setItem('cuedeck_tips_' + uid + '_' + r, '1'));
            localStorage.setItem('cuedeck_ck_' + uid + '_dismissed', '1');
          } catch (_) {}
          window._origShowSetupWizard = window.showSetupWizard;
          window.showSetupWizard = () => {};
          const GUARD = ['#cuedeck-cue-overlay','#cuedeck-cue-modal','#ob-tip','#checklist-wrap'];
          const obs = new MutationObserver(() => {
            GUARD.forEach(s => { const el = document.querySelector(s); if (el && el.style.display !== 'none') el.style.display = 'none'; });
          });
          obs.observe(document.body, { childList: true, subtree: true, attributes: true });
        });
        console.log('    ✓ Logged in — empty console visible, wizard deferred to t=53');
      }},

      // 0:40-0:52 captions about auth/registration — slowly explore the empty console
      { at: 40, fn: async (page) => {
        const el = page.locator('#sessions-list');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 100);
      }},
      { at: 46, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 180, box.y + box.height / 2);
        await page.waitForTimeout(600);
      }},

      // 0:53 "For a brand new account, the setup wizard kicks in." — show wizard
      { at: 53, fn: async (page) => {
        await page.evaluate(() => {
          if (typeof window._origShowSetupWizard === 'function') {
            window.showSetupWizard = window._origShowSetupWizard; showSetupWizard();
          } else if (typeof showSetupWizard === 'function') { showSetupWizard(); }
        });
        await page.waitForTimeout(700);
        const box = await page.locator('#wizard-modal .ev-modal-card').boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 40);
        console.log('    📍 Wizard visible — step 0');
      }},

      // 0:57 "Four steps — create, add session, invite team, set up display"
      // Hover each step dot with long pauses so the 7s window is filled
      { at: 57, fn: async (page) => {
        const dots = page.locator('.wiz-dot');
        const count = await dots.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const box = await dots.nth(i).boundingBox().catch(() => null);
          if (box) {
            await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(800);
          }
        }
        // Slide back to the wizard title
        const titleEl = page.locator('#wiz-title');
        const tBox = await titleEl.boundingBox().catch(() => null);
        if (tBox) await smoothMoveTo(page, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
        await page.waitForTimeout(600);
        console.log('    📍 Wizard steps highlighted');
      }},

      // 1:04.5 "Let's follow it." — move cursor to the name field to signal we'll fill it
      { at: 64, fn: async (page) => {
        const nameEl = page.locator('#wiz-ev-name');
        const box = await nameEl.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(500);
      }},

      // 1:06.8 "Step one: create the event." — pause on the empty name field
      { at: 67, fn: async (page) => {
        const body = page.locator('#wiz-body');
        const box = await body.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 60, box.y + 15);
        await page.waitForTimeout(700);
        console.log('    📍 Wizard step 0 — Name / Date / Timezone');
      }},

      // 1:09.1 "Name: Tech Summit 2026." — type slowly to fill 2s caption window
      { at: 69, fn: async (page) => {
        await smoothType(page, '#wiz-ev-name', 'Tech Summit 2026', 'Wizard: Event name', 100);
      }},

      // 1:11.4 "Date: April 15th." — hover date field then fill it
      { at: 71, fn: async (page) => {
        const dateEl = page.locator('#wiz-ev-date');
        const box = await dateEl.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(500);
        }
        await dateEl.fill('2026-04-15');
        await page.waitForTimeout(700);
        console.log('    ⌨️ Wizard: Date 2026-04-15');
      }},

      // 1:13.7 "Timezone: Europe London." — hover then select
      { at: 73, fn: async (page) => {
        const tzEl = page.locator('#wiz-ev-tz');
        const box = await tzEl.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(500);
        }
        await page.evaluate(() => {
          const sel = document.getElementById('wiz-ev-tz');
          if (!sel) return;
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].value === 'Europe/London') {
              sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); return;
            }
          }
        });
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(700);
        console.log('    ⌨️ Wizard: Timezone Europe/London');
      }},

      // 1:16 "Event runs 9am to 6pm." — sweep cursor slowly across form confirming fields
      { at: 76, fn: async (page) => {
        const body = page.locator('#wiz-body');
        const bodyBox = await body.boundingBox().catch(() => null);
        if (bodyBox) {
          await smoothMoveTo(page, bodyBox.x + 50, bodyBox.y + 10);
          await page.waitForTimeout(400);
          await smoothMoveTo(page, bodyBox.x + bodyBox.width - 50, bodyBox.y + bodyBox.height - 10);
          await page.waitForTimeout(500);
        }
      }},

      // 1:18.3 "Venue: Grand Convention Centre London." — hover Next button (pre-click pause)
      { at: 78, fn: async (page) => {
        const nextBtn = page.locator('#wiz-next');
        const box = await nextBtn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(800);
        }
      }},

      // 1:20.6 "Hit Save." — click Next to save the event
      { at: 80, fn: async (page) => {
        await smoothClick(page, '#wiz-next', 'Wizard: Next (save event)');
        await page.waitForTimeout(1800);
        console.log('    📍 Event saved — wizard now on step 1');
      }},

      // 1:22.9 "Now we have an event with no sessions." — skip wizard
      { at: 83, fn: async (page) => {
        await smoothClick(page, '#wizard-modal button:has-text("Skip")', 'Wizard: Skip');
        await page.waitForTimeout(600);
        console.log('    📍 Wizard dismissed — console shows empty event');
      }},

      // 1:26.2 "Let's add them." — cursor glides to the + Add Session button
      { at: 86, fn: async (page) => {
        const addBtn = page.locator('button[onclick="openSessModal(\'add\')"]').first();
        const box = await addBtn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(700);
        }
      }},

      // 1:28.5 "Click the plus button." — click Add session, settle cursor on title field
      { at: 88, fn: async (page) => {
        await smoothClick(page, 'button[onclick="openSessModal(\'add\')"]', 'Add session');
        await page.waitForTimeout(500);
        const titleEl = page.locator('#smv-title');
        const box = await titleEl.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(400);
      }},

      // 1:30.8 "Each session has a title, a type —" — type title slowly
      { at: 91, fn: async (page) => {
        await smoothType(page, '#smv-title', 'Opening Keynote: Building the Future', 'Session title', 90);
      }},

      // 1:34.1 "keynote, panel, workshop, break, sponsor —" — hover the type dropdown
      { at: 94, fn: async (page) => {
        const typeEl = page.locator('#smv-type');
        const box = await typeEl.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(900);
        }
        // "a room name" — slide to room field
        const roomEl = page.locator('#smv-room');
        const rBox = await roomEl.boundingBox().catch(() => null);
        if (rBox) {
          await smoothMoveTo(page, rBox.x + rBox.width / 2, rBox.y + rBox.height / 2);
          await page.waitForTimeout(600);
        }
      }},

      // 1:36.65 "a room name, a speaker, their company" — type speaker + company
      { at: 97, fn: async (page) => {
        await smoothType(page, '#smv-spk', 'Sarah Chen', 'Speaker', 100);
        await smoothType(page, '#smv-co', 'Nexovate', 'Company', 100);
        // Hover room field — it's next
        const roomEl = page.locator('#smv-room');
        const box = await roomEl.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(400);
        }
      }},

      // 1:39.575 "planned start and end times" — hover start/end before filling
      { at: 100, fn: async (page) => {
        const startEl = page.locator('#smv-start');
        const sBox = await startEl.boundingBox().catch(() => null);
        if (sBox) {
          await smoothMoveTo(page, sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
          await page.waitForTimeout(500);
        }
        const endEl = page.locator('#smv-end');
        const eBox = await endEl.boundingBox().catch(() => null);
        if (eBox) {
          await smoothMoveTo(page, eBox.x + eBox.width / 2, eBox.y + eBox.height / 2);
          await page.waitForTimeout(500);
        }
      }},

      // Fill room + times (slightly later to give hovering time to breathe)
      { at: 103, fn: async (page) => {
        await smoothType(page, '#smv-room', 'Main Stage', 'Room', 90);
        const startEl = page.locator('#smv-start');
        const sBox = await startEl.boundingBox().catch(() => null);
        if (sBox) {
          await smoothMoveTo(page, sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
          await page.waitForTimeout(300);
        }
        await startEl.fill('09:30');
        await page.waitForTimeout(400);
        const endEl = page.locator('#smv-end');
        const eBox = await endEl.boundingBox().catch(() => null);
        if (eBox) {
          await smoothMoveTo(page, eBox.x + eBox.width / 2, eBox.y + eBox.height / 2);
          await page.waitForTimeout(300);
        }
        await endEl.fill('10:15');
        // "sort order" — hover sort field briefly
        const sortEl = page.locator('#smv-sort');
        const soBox = await sortEl.boundingBox().catch(() => null);
        if (soBox) {
          await smoothMoveTo(page, soBox.x + soBox.width / 2, soBox.y + soBox.height / 2);
          await page.waitForTimeout(600);
        }
        console.log('    ⌨️ Session times: 09:30-10:15');
      }},

      // 1:45.425 "I'll also tick Recording and Streaming for the keynote —"
      // Hover rec checkbox, pause, tick, pause, tick Streaming
      { at: 109, fn: async (page) => {
        const recEl = page.locator('#smv-rec');
        const rBox = await recEl.boundingBox().catch(() => null);
        if (rBox) {
          await smoothMoveTo(page, rBox.x + rBox.width / 2, rBox.y + rBox.height / 2);
          await page.waitForTimeout(600);
        }
        await smoothClick(page, '#smv-rec', 'Tick Recording');
        await page.waitForTimeout(800);
        await smoothClick(page, '#smv-stream', 'Tick Streaming');
        await page.waitForTimeout(600);
        // "AV team knows what to prep" — cursor rests near the flags area
        const streamEl = page.locator('#smv-stream');
        const sBox = await streamEl.boundingBox().catch(() => null);
        if (sBox) await smoothMoveTo(page, sBox.x + sBox.width + 50, sBox.y + sBox.height / 2);
        await page.waitForTimeout(700);
      }},

      // 1:55.825 "Save."
      { at: 115, fn: async (page) => {
        await smoothClick(page, 'button[onclick="submitSessModal()"]', 'Save keynote session');
        await page.locator('#sess-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          console.warn('    ⚠ sess-modal still open after 10s — force closing');
          await page.evaluate(() => { const m = document.getElementById('sess-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(400);
      }},

      // 1:58.125 "There it is — first session, PLANNED, showing in the list."
      // Hover over the new card to show it appeared
      { at: 118, fn: async (page) => {
        const card = page.locator('.sc').first();
        const box = await card.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
          await smoothMoveTo(page, box.x + 80, box.y + 18);
          await page.waitForTimeout(500);
          await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height - 18);
          await page.waitForTimeout(500);
        }
        console.log('    📍 First session in list — PLANNED');
      }},

      // 2:03.225 "I'll add a few more —" — glide to + ADD SESSION button
      { at: 121, fn: async (page) => {
        const addBtn = page.locator('button[onclick="openSessModal(\'add\')"]').last();
        const box = await addBtn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
        }
      }},

      // 2:05.775 "a panel and a lunch break." — click Add session for panel
      { at: 123, fn: async (page) => {
        await smoothClick(page, 'button[onclick="openSessModal(\'add\')"]', 'Add panel session');
        await page.waitForTimeout(500);
      }},

      // Fill panel title (slow), then hover type to show it's different from Break, then fill times+room
      { at: 126, fn: async (page) => {
        await smoothType(page, '#smv-title', 'Panel: AI Ethics & Governance in 2026', 'Panel title', 90);
        // Hover type dropdown — hints at "different types like break"
        const typeEl = page.locator('#smv-type');
        const tBox = await typeEl.boundingBox().catch(() => null);
        if (tBox) {
          await smoothMoveTo(page, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
          await page.waitForTimeout(600);
        }
        const startEl = page.locator('#smv-start');
        const sBox = await startEl.boundingBox().catch(() => null);
        if (sBox) {
          await smoothMoveTo(page, sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
          await page.waitForTimeout(300);
        }
        await page.locator('#smv-start').fill('10:30');
        await page.locator('#smv-end').fill('11:30');
        await smoothType(page, '#smv-room', 'Main Stage', 'Panel room', 90);
      }},

      // 2:08.325 "Notice the lunch break is type 'break'" — save panel
      { at: 134, fn: async (page) => {
        await smoothClick(page, 'button[onclick="submitSessModal()"]', 'Save panel');
        await page.locator('#sess-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          console.warn('    ⚠ sess-modal still open after 10s — force closing');
          await page.evaluate(() => { const m = document.getElementById('sess-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(400);
      }},

      // 2:12.375 "with a different visual treatment in the list." — glide to + button
      { at: 136, fn: async (page) => {
        const addBtn = page.locator('button[onclick="openSessModal(\'add\')"]').last();
        const box = await addBtn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(700);
        }
      }},

      // Open break modal
      { at: 138, fn: async (page) => {
        await smoothClick(page, 'button[onclick="openSessModal(\'add\')"]', 'Add break');
        await page.waitForTimeout(500);
      }},

      // Fill break: title, select type=Break (pause on dropdown), fill times
      { at: 141, fn: async (page) => {
        await smoothType(page, '#smv-title', 'Lunch Break', 'Break title', 90);
        const typeEl = page.locator('#smv-type');
        const tBox = await typeEl.boundingBox().catch(() => null);
        if (tBox) {
          await smoothMoveTo(page, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
          await page.waitForTimeout(600);
        }
        await page.locator('#smv-type').selectOption('Break');
        await page.waitForTimeout(500);
        await page.locator('#smv-start').fill('13:00');
        await page.locator('#smv-end').fill('14:00');
        console.log('    ⌨️ Break: type=Break, 13:00-14:00');
      }},

      // 2:21.65 "You can also duplicate sessions" — hover modal to let viewer read it
      { at: 147, fn: async (page) => {
        const card = page.locator('.ev-modal-card').first();
        const bBox = await card.boundingBox().catch(() => null);
        if (bBox) {
          await smoothMoveTo(page, bBox.x + bBox.width / 2, bBox.y + bBox.height * 0.3);
          await page.waitForTimeout(700);
          await smoothMoveTo(page, bBox.x + bBox.width * 0.6, bBox.y + bBox.height * 0.6);
          await page.waitForTimeout(600);
        }
      }},

      // 2:15.675 "In a real event..." — save break
      { at: 150, fn: async (page) => {
        await smoothClick(page, 'button[onclick="submitSessModal()"]', 'Save break');
        await page.locator('#sess-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          console.warn('    ⚠ sess-modal still open after 10s — force closing');
          await page.evaluate(() => { const m = document.getElementById('sess-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(400);
        // Scroll down through the 3-session list to show them all
        await smoothScroll(page, 170);
        await page.waitForTimeout(700);
        await smoothScroll(page, -170);
        console.log('    📍 All 3 sessions in list — Keynote, Panel, Break');
      }},

      // 2:31.675 "Need to reorder?" — hover the ▼ button on first card
      { at: 153, fn: async (page) => {
        console.log('    📍 Hovering reorder arrows');
        const downBtn = page.locator('.sc-mgmt-btn[title="Move down"]').first();
        const box = await downBtn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(800);
        }
      }},

      // 2:33.975 "Click the up/down arrows..." — click ▼ then show ▲
      { at: 154, fn: async (page) => {
        const downBtn = page.locator('.sc-mgmt-btn[title="Move down"]').first();
        const box = await downBtn.boundingBox().catch(() => null);
        if (box) {
          await page.evaluate(([px, py]) => window.__cdRipple(px, py), [box.x + box.width / 2, box.y + box.height / 2]);
          await downBtn.click();
          console.log('    🖱 Move first session down ▼');
          await page.waitForTimeout(1000);
        }
        const upBtn = page.locator('.sc-mgmt-btn[title="Move up"]').nth(1);
        const upBox = await upBtn.boundingBox().catch(() => null);
        if (upBox) {
          await smoothMoveTo(page, upBox.x + upBox.width / 2, upBox.y + upBox.height / 2);
          await page.waitForTimeout(900);
        }
      }},

      // 2:39.575 "The list re-sorts instantly." — scroll to show full reordered list
      { at: 159, fn: async (page) => {
        console.log('    📍 List re-sorted');
        await smoothScroll(page, 230);
        await page.waitForTimeout(1200);
        await smoothScroll(page, -230);
        await page.waitForTimeout(600);
      }},

      // 2:41.875 "To edit a session — click anywhere on the card."
      // Hover card centre to reveal mgmt buttons, then click ✎
      { at: 162, fn: async (page) => {
        const card = page.locator('.sc').first();
        const cardBox = await card.boundingBox().catch(() => null);
        if (cardBox) {
          await smoothMoveTo(page, cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
          await page.waitForTimeout(800);
        }
        const editBtn = page.locator('.sc-mgmt-btn[title="Edit session"]').first();
        const editBox = await editBtn.boundingBox().catch(() => null);
        if (editBox) {
          await smoothMoveTo(page, editBox.x + editBox.width / 2, editBox.y + editBox.height / 2);
          await page.waitForTimeout(400);
          await page.evaluate(([px, py]) => window.__cdRipple(px, py), [editBox.x + editBox.width / 2, editBox.y + editBox.height / 2]);
          await editBtn.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Session edit modal — pre-filled');
      }},

      // 2:45.925 "The modal comes back pre-filled." — hover pre-filled fields
      { at: 166, fn: async (page) => {
        const titleEl = page.locator('#smv-title');
        const tBox = await titleEl.boundingBox().catch(() => null);
        if (tBox) {
          await smoothMoveTo(page, tBox.x + tBox.width / 2, tBox.y + tBox.height / 2);
          await page.waitForTimeout(600);
        }
        const spkEl = page.locator('#smv-spk');
        const sBox = await spkEl.boundingBox().catch(() => null);
        if (sBox) {
          await smoothMoveTo(page, sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
          await page.waitForTimeout(500);
        }
      }},

      // 2:48.225 "Change the speaker, adjust the time, tick or untick flags."
      { at: 168, fn: async (page) => {
        const endEl = page.locator('#smv-end');
        if (await endEl.isVisible().catch(() => false)) {
          const box = await endEl.boundingBox().catch(() => null);
          if (box) {
            await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(600);
          }
          await endEl.fill('10:30');
          await page.waitForTimeout(400);
          // Also hover Recording flag to show tick/untick
          const recEl = page.locator('#smv-rec');
          const rBox = await recEl.boundingBox().catch(() => null);
          if (rBox) {
            await smoothMoveTo(page, rBox.x + rBox.width / 2, rBox.y + rBox.height / 2);
            await page.waitForTimeout(600);
          }
          console.log('    ⌨️ Edit: adjust end time to 10:30');
        }
      }},

      // 2:52.275 "Save." — save edit, wait for close, glide to filter bar
      { at: 172, fn: async (page) => {
        await smoothClick(page, 'button[onclick="submitSessModal()"]', 'Save edit');
        await page.locator('#sess-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          console.warn('    ⚠ sess-modal still open after 10s — force closing');
          await page.evaluate(() => { const m = document.getElementById('sess-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(300);
        // "Once you have a full programme, the filter bar keeps you sane." — glide to filter bar
        const filterBar = page.locator('#filter-bar');
        const fBox = await filterBar.boundingBox().catch(() => null);
        if (fBox) {
          await smoothMoveTo(page, fBox.x + 100, fBox.y + fBox.height / 2);
          await page.waitForTimeout(600);
        }
      }},

      // 2:59.675 "Type a speaker name — matching sessions surface immediately."
      { at: 179, fn: async (page) => {
        await smoothType(page, '#fb-search', 'Sarah', 'Search speaker', 100);
        await page.waitForTimeout(900);
      }},

      // 3:03.35 "Click a room chip to see just that room's schedule."
      { at: 183, fn: async (page) => {
        await page.locator('#fb-search').fill('');
        const roomSel = page.locator('#fb-room');
        const rBox = await roomSel.boundingBox().catch(() => null);
        if (rBox) await smoothMoveTo(page, rBox.x + rBox.width / 2, rBox.y + rBox.height / 2);
        await page.waitForTimeout(400);
        await roomSel.selectOption({ index: 1 }).catch(() => {});
        console.log('    🖱 Filter by room');
        await page.waitForTimeout(700);
      }},

      // 3:07.4 "Filter by status to find everything that's still PLANNED."
      { at: 187, fn: async (page) => {
        await page.locator('#fb-room').selectOption('');
        const statusSel = page.locator('#fb-status');
        const sBox = await statusSel.boundingBox().catch(() => null);
        if (sBox) await smoothMoveTo(page, sBox.x + sBox.width / 2, sBox.y + sBox.height / 2);
        await page.waitForTimeout(400);
        await statusSel.selectOption('PLANNED');
        console.log('    🖱 Filter by status: PLANNED');
        await page.waitForTimeout(700);
      }},

      // 3:11.075 "These filters are local — they don't affect what anyone else sees."
      { at: 191, fn: async (page) => {
        await page.locator('#fb-status').selectOption('');
        console.log('    🖱 Filters cleared — full list restored');
        await page.waitForTimeout(400);
        // Scroll down briefly to show the full programme
        await smoothScroll(page, 160);
        await page.waitForTimeout(900);
        await smoothScroll(page, -160);
      }},

      // 3:15.875 "That's it — event created, sessions in, programme structured."
      { at: 196, fn: async (page) => {
        const card = page.locator('.sc').first();
        const box = await card.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        console.log('    📍 Ep02 complete — full programme visible');
      }},
    ],
  },

  // ── Episode 3: Running a Live Event — State Machine ──────────────────────
  // Synchronized to ep03-captions.srt (~268s)
  3: {
    name: 'State Machine',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "Your event is set up" — move cursor over session list
      { at: 5, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        console.log('    📍 Console loaded — sessions in PLANNED state');
      }},
      // 0:07 "every session lives in one of eight states" — hover session list header
      { at: 8, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 180, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 0:10 "PLANNED, READY, CALLING, LIVE" — scroll to show all cards
      { at: 10, fn: async (page) => {
        await smoothScroll(page, 260);
        await page.waitForTimeout(1200);
        await smoothScroll(page, -260);
      }},
      // 0:30 "scroll down" narration gap — hover second card
      { at: 30, fn: async (page) => {
        const el = page.locator('.sc').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(800);
      }},
      // 0:34 "PLANNED badge" — hover PLANNED badge on first card
      { at: 34, fn: async (page) => {
        const badge = page.locator('.sc').first();
        const box = await badge.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 70, box.y + 16);
        await page.waitForTimeout(1200);
      }},
      // 0:43 narration gap — hover over first card centre
      { at: 43, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 0:53 narration gap — hover filter bar
      { at: 53, fn: async (page) => {
        const el = page.locator('#filter-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 120, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 0:80 "hover over first card" — move cursor onto first session card
      { at: 80, fn: async (page) => {
        const card = page.locator('.sc').first();
        const box = await card.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 160, box.y + box.height / 2);
        await page.waitForTimeout(800);
      }},
      // 1:26 "Click SET READY" — click the inline SET READY button
      { at: 86, fn: async (page) => {
        await clickCardBtn(page, 'SET READY');
      }},
      // 1:31 "READY badge" — hover the READY badge on the card
      { at: 91, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 70, box.y + 16);
        await page.waitForTimeout(2000);
        console.log('    📍 Session is READY');
      }},
      // 1:44 "CALL SPEAKER" — click ctx panel button
      { at: 104, fn: async (page) => {
        await clickCtxBtn(page, 'CALL SPEAKER');
      }},
      // 1:47 narration — hover CALLING badge
      { at: 109, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 70, box.y + 16);
        await page.waitForTimeout(2500);
        console.log('    📍 Session CALLING — amber badge');
      }},
      // 2:07 "CONFIRM ON STAGE" — CALLING→LIVE
      { at: 127, fn: async (page) => {
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
      }},
      // 2:13 "LIVE — green, timer running" — hover card timer
      { at: 133, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height / 2);
        await page.waitForTimeout(5500);
        console.log('    📍 Session LIVE — timer running');
      }},
      // 2:37 "HOLD" — click HOLD in ctx panel
      { at: 157, fn: async (page) => {
        await clickCtxBtn(page, 'HOLD');
      }},
      // 2:41 "timer frozen" — hover frozen timer on card
      { at: 161, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height / 2);
        await page.waitForTimeout(3000);
        console.log('    📍 Session HOLD — timer frozen');
      }},
      // 2:47 "RESUME" — resume from HOLD
      { at: 167, fn: async (page) => {
        await clickCtxBtn(page, 'RESUME');
      }},
      // 2:51 narration — hover timer resuming
      { at: 173, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height / 2);
        await page.waitForTimeout(2500);
        console.log('    📍 Resumed — timer continues');
      }},
      // 3:03 "nudge +1m" — click nudge three times
      { at: 183, fn: async (page) => {
        await smoothClick(page, '.abtn:has-text("+1m")', 'Nudge +1m');
        await page.waitForTimeout(900);
        await smoothClick(page, '.abtn:has-text("+1m")', 'Nudge +1m (2)');
        await page.waitForTimeout(900);
        await smoothClick(page, '.abtn:has-text("+1m")', 'Nudge +1m (3)');
      }},
      // 3:11 "cascade shifts" — scroll down to show downstream sessions
      { at: 191, fn: async (page) => {
        await smoothScroll(page, 320);
        await page.waitForTimeout(2200);
        await smoothScroll(page, -320);
        console.log('    📍 Delay cascade visible');
      }},
      // 3:24 "END SESSION"
      { at: 204, fn: async (page) => {
        await clickCtxBtn(page, 'END SESSION');
      }},
      // 3:29 "ENDED status" — hover ENDED badge
      { at: 209, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 70, box.y + 16);
        await page.waitForTimeout(2500);
        console.log('    📍 Session ENDED');
      }},
      // 3:46 "next session" — hover second session card
      { at: 226, fn: async (page) => {
        const card = page.locator('.sc').nth(1);
        const box = await card.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 160, box.y + box.height / 2);
        await page.waitForTimeout(800);
      }},
      // 3:50 "MARK ARRIVED" — click arrived button
      { at: 230, fn: async (page) => {
        await clickSession(page, 1); // ensure session[1] context panel is visible
        await page.waitForTimeout(500);
        await clickBtn(page, 'MARK ARRIVED'); // use clickBtn (getBoundingClientRect) — more reliable than :has-text()
      }},
      // 4:01 "ARRIVED badge visible"
      { at: 241, fn: async (page) => {
        const el = page.locator('.sc').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 70, box.y + 16);
        await page.waitForTimeout(1500);
        console.log('    📍 Speaker ARRIVED badge visible');
      }},
      // 4:12 outro narration — hover session list
      { at: 252, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 120);
        console.log('    📍 State machine walkthrough complete');
      }},
    ],
  },

  // ── Episode 4: Roles & Team Invites ──────────────────────────────────────
  // Synchronized to ep04-captions.srt (~173s)
  4: {
    name: 'Roles & Team Invites',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "A live event is a team sport" — hover role bar
      { at: 5, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 80, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Console loaded — roles intro');
      }},
      // 0:08 "Director sees everything" — switch to director, click first session
      { at: 8, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 0);
      }},
      // 0:24 "The Director role" — hover director button
      { at: 24, fn: async (page) => {
        const el = page.locator('[data-role="director"]');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(800);
      }},
      // 0:38 "Stage role" — switch to stage
      { at: 38, fn: async (page) => {
        await switchRole(page, 'stage');
        await clickSession(page, 0);
      }},
      // 0:52 "AV role" — switch to av
      { at: 52, fn: async (page) => {
        await switchRole(page, 'av');
      }},
      // 0:65 "Interp role" — switch to interp
      { at: 65, fn: async (page) => {
        await switchRole(page, 'interp');
      }},
      // 0:77 "Reg role" — switch to reg
      { at: 77, fn: async (page) => {
        await switchRole(page, 'reg');
      }},
      // 0:85 "Signage role" — switch to signage
      { at: 85, fn: async (page) => {
        await switchRole(page, 'signage');
      }},
      // 1:34 "back to director" — switch back
      { at: 94, fn: async (page) => {
        await switchRole(page, 'director');
      }},
      // 1:36 "Invite section" — hover the always-visible inline invite form
      { at: 96, fn: async (page) => {
        const el = page.locator('#inv-email').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(600);
        console.log('    📍 Invite form visible — inline in director sidebar');
      }},
      // 1:41 "enter their email" — type email slowly
      { at: 101, fn: async (page) => {
        await smoothType(page, '#inv-email', 'stage-manager@venue.com', 'Invite email', 90);
      }},
      // 1:44 "choose their role" — hover role select
      { at: 104, fn: async (page) => {
        const el = page.locator('#inv-role').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 1:46 "hit Send Invite" — hover Send Invite button (don't actually send)
      { at: 106, fn: async (page) => {
        const el = page.locator('#inv-btn').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Invite form filled — showing Send Invite button');
      }},
      // 1:50 "they get an email" — clear the email field and move away
      { at: 110, fn: async (page) => {
        await page.locator('#inv-email').fill('').catch(() => {});
        await page.waitForTimeout(600);
      }},
      // 2:14 "hit the ? in the header" — click help button
      { at: 134, fn: async (page) => {
        await smoothClick(page, '#help-btn, button[aria-label*="help" i], .help-btn', 'Open help menu');
      }},
      // 2:18 "Quick Reference" — click Quick Reference item
      { at: 138, fn: async (page) => {
        await smoothClick(page, 'button:has-text("Quick Reference"), li:has-text("Quick Reference")', 'Quick Reference');
      }},
      // 2:23 "full table visible" — let viewer read the table
      { at: 143, fn: async (page) => {
        const el = page.locator('#quick-ref-modal, .modal-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.4);
        await page.waitForTimeout(3500);
        console.log('    📍 Quick Reference — role permissions table visible');
      }},
      // 2:32 "field reference during production" — scroll table slightly
      { at: 152, fn: async (page) => {
        await smoothScroll(page, 120);
        await page.waitForTimeout(800);
        await smoothScroll(page, -120);
      }},
      // 2:37 "close" — press Escape
      { at: 157, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close Quick Reference');
        console.log('    📍 Roles demo complete');
      }},
    ],
  },

  // ── Episode 5: Broadcast Bar ─────────────────────────────────────────────
  // Synchronized to ep05-captions.srt (~142s)
  5: {
    name: 'Broadcast Bar',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "group chat noise" intro — hover console header
      { at: 5, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Console loaded — broadcast episode');
      }},
      // 0:16 "press B" — open broadcast bar
      { at: 16, fn: async (page) => {
        await pressKey(page, 'b', 'Open broadcast bar (B key)');
      }},
      // 0:23 "bar opens" — hover broadcast bar
      { at: 23, fn: async (page) => {
        const el = page.locator('#broadcast-bar, .broadcast-bar').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Broadcast bar open');
      }},
      // 0:48 "click bar / open text area" — click input
      { at: 48, fn: async (page) => {
        await smoothClick(page, '#bc-input, textarea[placeholder*="broadcast" i], .bc-input', 'Click broadcast input');
      }},
      // 0:51 "type message" — type slowly
      { at: 51, fn: async (page) => {
        await smoothType(page, '#bc-input, textarea[placeholder*="broadcast" i], .bc-input',
          'All crew: 5 minutes to doors open', 'Type broadcast', 90);
      }},
      // 0:55 "char counter" — hover char counter element
      { at: 55, fn: async (page) => {
        const el = page.locator('#bc-char').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const bar = page.locator('#bc-bar').first();
          const bBox = await bar.boundingBox().catch(() => null);
          if (bBox) await smoothMoveTo(page, bBox.x + bBox.width - 80, bBox.y + bBox.height / 2);
        }
        await page.waitForTimeout(1200);
        console.log('    📍 Character counter visible');
      }},
      // 1:02 "hit send" — click Send
      { at: 62, fn: async (page) => {
        await smoothClick(page, 'button[onclick="sendBroadcast()"]', 'Send broadcast');
      }},
      // 1:07 "boom — every device" — hover sessions list
      { at: 67, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(1500);
        console.log('    📍 Broadcast sent — visible to all roles');
      }},
      // 1:15 "presets section" — hover presets area
      { at: 75, fn: async (page) => {
        const el = page.locator('.bc-preset-btn').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Presets section visible');
      }},
      // 1:19 "HOLD preset" — click HOLD preset button
      { at: 79, fn: async (page) => {
        await smoothClick(page, '.bc-preset-btn:has-text("HOLD"), .bc-preset-btn:has-text("Hold"), .bc-preset-btn', 'Click HOLD preset');
      }},
      // 1:26 "custom presets" — hover preset area
      { at: 86, fn: async (page) => {
        const el = page.locator('.bc-preset-btn').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const bar = page.locator('#broadcast-bar, .broadcast-bar').first();
          const bBox = await bar.boundingBox().catch(() => null);
          if (bBox) await smoothMoveTo(page, bBox.x + 120, bBox.y + bBox.height / 2);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Custom presets available');
      }},
      // 1:40 "each person dismisses" — narration gap, hover broadcast notification area
      { at: 100, fn: async (page) => {
        const el = page.locator('#broadcast-bar, .broadcast-bar').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.7);
        await page.waitForTimeout(900);
        console.log('    📍 Broadcast dismiss behavior');
      }},
      // 1:46 "broadcast stays visible" — narration gap, hover input
      { at: 106, fn: async (page) => {
        const el = page.locator('#bc-input, .bc-input').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 2:00 "Escape" — close broadcast bar
      { at: 120, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close broadcast bar');
        console.log('    📍 Broadcast bar closed');
      }},
    ],
  },

  // ── Episode 6: Delay Cascade ─────────────────────────────────────────────
  // Synchronized to ep06-captions.srt (~461s)
  6: {
    name: 'Delay Cascade',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:02 setup — ensure session[0] is in READY state for CALL SPEAKER at 4:08
      { at: 2, fn: async (page) => {
        await switchRole(page, 'director');
        await page.waitForTimeout(600);
        const resetResult = await page.evaluate(async () => {
          try {
            // Get session IDs from rendered .sc cards — cards have id="card-{uuid}"
            const cards = [...document.querySelectorAll('.sc')];
            let ids = cards.map(c => {
              const cardId = c.getAttribute('id') || '';
              return cardId.startsWith('card-') ? cardId.slice(5) : null;
            }).filter(id => id && id.length === 36);
            if (ids.length === 0) {
              const { data } = await sb.from('leod_sessions').select('id').order('seq').limit(2);
              if (data) ids = data.map(r => r.id).filter(id => typeof id === 'string' && id.length === 36);
            }
            if (ids.length === 0) return 'no session IDs found';
            const targetId = ids[0];
            const { error } = await sb.from('leod_sessions')
              .update({ status: 'READY', cumulative_delay: 0, delay_minutes: 0 })
              .eq('id', targetId);
            if (error) return `error: ${error.message}`;
            if (typeof loadSnapshot === 'function' && S.event) await loadSnapshot(S.event.id);
            return `reset to READY: ${targetId.slice(0, 8)}`;
          } catch (e) { return `exception: ${e?.message || String(e)}`; }
        });
        await page.waitForTimeout(2000); // wait for loadSnapshot + realtime propagation
        console.log(`    📍 Session DB reset: ${resetResult}`);
        console.log('    📍 Session[0] in READY state — delay cascade demo ready');
      }},
      // 0:05 intro narration — hover first session card
      { at: 5, fn: async (page) => {
        await clickSession(page, 0);
        console.log('    📍 Delay cascade episode — session selected');
      }},
      // 0:35 "planned_start / planned_end fields" — hover ctx panel timing section
      { at: 35, fn: async (page) => {
        const el = page.locator('#ctx-panel, .ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 120);
        await page.waitForTimeout(900);
      }},
      // 0:41 "two numbers" — move cursor around timing fields
      { at: 41, fn: async (page) => {
        const el = page.locator('#ctx-panel, .ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + 80, box.y + 100);
          await page.waitForTimeout(600);
          await smoothMoveTo(page, box.x + box.width - 80, box.y + 140);
          await page.waitForTimeout(600);
        }
      }},
      // 0:55 "scheduled_start/end fields" — hover scheduling area
      { at: 55, fn: async (page) => {
        const el = page.locator('#ctx-panel, .ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 180);
        await page.waitForTimeout(900);
      }},
      // 1:18 "delay_minutes / cumulative_delay" — scroll sessions list to show delay
      { at: 78, fn: async (page) => {
        await smoothScroll(page, 180);
        await page.waitForTimeout(900);
        await smoothScroll(page, -180);
        console.log('    📍 Delay fields explained');
      }},
      // 1:40 "delay cascade amber tag" — hover second session card
      { at: 100, fn: async (page) => {
        const el = page.locator('.sc').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Delay cascade amber tag on downstream sessions');
      }},
      // 1:55 "current session 10 min late" — hover current session
      { at: 115, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 2:02 "director view amber buttons" — hover delay buttons on card
      { at: 122, fn: async (page) => {
        const el = page.locator('button[onclick*="applyDelay"][onclick*=",5)"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 2:15 "hit plus-five" — apply +5 delay
      { at: 135, fn: async (page) => {
        await smoothClick(page, 'button[onclick*="applyDelay"][onclick*=",5)"]', 'Apply +5m delay');
      }},
      // 2:17 "watch session list" — scroll to show cascade
      { at: 137, fn: async (page) => {
        await smoothScroll(page, 380);
        await page.waitForTimeout(2000);
        console.log('    📍 Cascade rolling forward — downstream sessions shifted');
      }},
      // 2:40 "amber +5 tags" — hover shifted session
      { at: 160, fn: async (page) => {
        const el = page.locator('.sc').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1500);
        await smoothScroll(page, -380);
      }},
      // 2:51 "delay strip" — hover delay strip element
      { at: 171, fn: async (page) => {
        const el = page.locator('.delay-strip, .delay-banner, #delay-strip').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const ctx = page.locator('#ctx-panel').first();
          const cBox = await ctx.boundingBox().catch(() => null);
          if (cBox) await smoothMoveTo(page, cBox.x + cBox.width / 2, cBox.y + 60);
        }
        await page.waitForTimeout(1200);
        console.log('    📍 Delay strip visible');
      }},
      // 3:05 "client-side first" — narration gap, hover first session
      { at: 185, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 3:20 "anchor sessions" — scroll to show lunch/anchor session card
      { at: 200, fn: async (page) => {
        await smoothScroll(page, 300);
        await page.waitForTimeout(1200);
        console.log('    📍 Anchor session visible — stops cascade');
      }},
      // 3:35 "hit plus-five again" — apply second +5 delay
      { at: 215, fn: async (page) => {
        await smoothScroll(page, -300);
        await smoothClick(page, 'button[onclick*="applyDelay"][onclick*=",5)"]', 'Apply +5m again');
      }},
      // 3:46 "sessions shifted not lunch" — scroll to verify anchor held
      { at: 226, fn: async (page) => {
        await smoothScroll(page, 320);
        await page.waitForTimeout(1800);
        console.log('    📍 Anchor held — non-anchor sessions shifted');
      }},
      // 3:55 "anchor absorbed" — hover anchor card
      { at: 235, fn: async (page) => {
        const el = page.locator('.sc[data-anchor="true"], .sc .anchor-badge').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const sc = page.locator('.sc').nth(2);
          const scBox = await sc.boundingBox().catch(() => null);
          if (scBox) await smoothMoveTo(page, scBox.x + scBox.width / 2, scBox.y + scBox.height / 2);
        }
        await page.waitForTimeout(1200);
      }},
      // 4:05 "delay strip shows anchor name" — hover delay strip
      { at: 245, fn: async (page) => {
        await smoothScroll(page, -320);
        const el = page.locator('.delay-strip, .delay-banner, #delay-strip').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Delay strip shows anchor name');
      }},
      // 4:08 "second set of controls for LIVE session" — transition session to LIVE so nudge buttons appear
      { at: 248, fn: async (page) => {
        // sessions start READY; need CALL SPEAKER → CONFIRM ON STAGE to reach LIVE
        await clickSession(page, 0);
        await page.waitForTimeout(500);
        // Use clickCtxBtn (10s retry) for reliable state transitions via Supabase Edge Functions
        await clickCtxBtn(page, 'CALL SPEAKER');
        await page.waitForTimeout(2000); // wait for CALLING state to propagate via realtime
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
        await page.waitForTimeout(1500); // wait for LIVE state to propagate
        console.log('    📍 Session now LIVE — nudge buttons visible');
      }},
      // 4:15 "nudge controls" — hover nudge buttons
      { at: 255, fn: async (page) => {
        const el = page.locator('button[onclick*="nudgeSession"][onclick*=", 1)"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Nudge controls visible');
      }},
      // 4:30 "nudge vs cascade" — narration gap, hover -1m
      { at: 270, fn: async (page) => {
        const el = page.locator('button[onclick*="nudgeSession"][onclick*=",-1)"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 4:49 "hit minus-one" — click -1m
      { at: 289, fn: async (page) => {
        await smoothClick(page, 'button[onclick*="nudgeSession"][onclick*=",-1)"]', 'Nudge -1m');
      }},
      // 4:55 "plus-one" — click +1m
      { at: 295, fn: async (page) => {
        await smoothClick(page, 'button[onclick*="nudgeSession"][onclick*=", 1)"]', 'Nudge +1m');
      }},
      // 5:10 "timer updates" — hover live timer on session card
      { at: 310, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Timer updates with nudge');
      }},
      // 5:30 "apply delay then reset" — hover Reset Delays button
      { at: 330, fn: async (page) => {
        const el = page.locator('#ds-reset-btn').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Reset Delays button visible');
      }},
      // 5:55 "hit Reset" — click Reset then confirm within 3s window
      { at: 355, fn: async (page) => {
        await smoothClick(page, '#ds-reset-btn', 'Reset delays');
        await page.waitForTimeout(900); // button changes to "Confirm reset?"
        await smoothClick(page, '#ds-reset-btn', 'Confirm reset'); // second click confirms
        await page.waitForTimeout(600);
        console.log('    📍 Reset confirmed');
      }},
      // 6:11 "every session reset" narration — hover session list
      { at: 371, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 All sessions reset to planned times');
      }},
      // 6:23 "every session reset" — scroll to show all sessions back to original times
      { at: 383, fn: async (page) => {
        await smoothScroll(page, 300);
        await page.waitForTimeout(1500);
        await smoothScroll(page, -300);
        console.log('    📍 All sessions reset to planned times');
      }},
      // 6:40 "multi-room: cascade stops at ENDED/CANCELLED" — narration gap
      { at: 400, fn: async (page) => {
        const el = page.locator('.sc').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Multi-room cascade behavior');
      }},
      // 7:20 "cascade per sort order" — hover sort-ordered sessions
      { at: 440, fn: async (page) => {
        await smoothScroll(page, 200);
        await page.waitForTimeout(900);
        await smoothScroll(page, -200);
        console.log('    📍 Cascade follows sort order');
      }},
    ],
  },

  // ── Episode 7: Digital Signage Setup ─────────────────────────────────────
  // Synchronized to ep07-captions.srt (~536s)
  7: {
    name: 'Digital Signage Setup',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "every venue has screens" — hover console in director view
      { at: 5, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Signage episode intro');
      }},
      // 0:31 "signage system" — switch to signage role
      { at: 31, fn: async (page) => {
        await switchRole(page, 'signage');
      }},
      // 0:44 "let's do it" — hover signage sidebar
      { at: 44, fn: async (page) => {
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
      }},
      // 0:51 "two parts" — hover sidebar sections
      { at: 51, fn: async (page) => {
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + 40);
          await page.waitForTimeout(600);
          await smoothMoveTo(page, box.x + box.width / 2, box.y + 200);
          await page.waitForTimeout(600);
        }
      }},
      // 0:58 "signage panel" — hover top of signage sidebar
      { at: 58, fn: async (page) => {
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 30);
        await page.waitForTimeout(900);
        console.log('    📍 Signage panel visible');
      }},
      // 1:08 "display page" — narration gap, hover display cards area
      { at: 68, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const panel = page.locator('.sp-panel').first();
          const pBox = await panel.boundingBox().catch(() => null);
          if (pBox) await smoothMoveTo(page, pBox.x + pBox.width / 2, pBox.y + 120);
        }
        await page.waitForTimeout(900);
      }},
      // 1:28 "each display = db row" — narration gap, scroll sidebar down
      { at: 88, fn: async (page) => {
        await smoothScroll(page, 150);
        await page.waitForTimeout(900);
        await smoothScroll(page, -150);
      }},
      // 1:53 "scroll down sidebar" — scroll signage panel
      { at: 113, fn: async (page) => {
        await smoothScroll(page, 200);
        await page.waitForTimeout(1200);
      }},
      // 2:05 "display panel shows" — scroll back up
      { at: 125, fn: async (page) => {
        await smoothScroll(page, -200);
        await page.waitForTimeout(900);
        console.log('    📍 Display panel visible');
      }},
      // 2:35 "add a display" — hover Add Display button
      { at: 155, fn: async (page) => {
        const el = page.locator('button:has-text("Add Display"), button:has-text("+ Display"), button:has-text("Add")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 2:45 "modal opens" — click Add Display
      { at: 165, fn: async (page) => {
        await smoothClick(page, 'button:has-text("Add Display"), button:has-text("+ Display"), button:has-text("Add")', 'Add Display');
        await page.waitForTimeout(600);
        console.log('    📍 Display modal open');
      }},
      // 3:05 "name field" — type display name slowly
      { at: 185, fn: async (page) => {
        await smoothType(page, '#dm-name', 'Main Lobby Screen', 'Display name', 90);
      }},
      // 3:21 "zone type" — hover zone/location field
      { at: 201, fn: async (page) => {
        const el = page.locator('#disp-zone, select[id*="zone"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const modal = page.locator('.ev-modal-card').first();
          const mBox = await modal.boundingBox().catch(() => null);
          if (mBox) await smoothMoveTo(page, mBox.x + mBox.width / 2, mBox.y + 100);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Zone type field visible');
      }},
      // 3:36 "orientation" — hover orientation field
      { at: 216, fn: async (page) => {
        const el = page.locator('#disp-orientation, select[id*="orient"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const modal = page.locator('.ev-modal-card').first();
          const mBox = await modal.boundingBox().catch(() => null);
          if (mBox) await smoothMoveTo(page, mBox.x + mBox.width / 2, mBox.y + 140);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Orientation field visible');
      }},
      // 3:53 "content mode" — hover content mode / mode dropdown
      { at: 233, fn: async (page) => {
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(900);
        }
        console.log('    📍 Content mode selector visible');
      }},
      // 4:05 "schedule mode" — select schedule in dropdown
      { at: 245, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('schedule').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Schedule mode selected');
      }},
      // 4:22 "schedule mode" — hover room filter field
      { at: 262, fn: async (page) => {
        const el = page.locator('#disp-room, input[placeholder*="room" i]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const modal = page.locator('.ev-modal-card').first();
          const mBox = await modal.boundingBox().catch(() => null);
          if (mBox) await smoothMoveTo(page, mBox.x + mBox.width / 2, mBox.y + 200);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Room filter field');
      }},
      // 4:44 "hit save" — click Save
      { at: 284, fn: async (page) => {
        await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save display');
        await page.locator('#disp-modal, .ev-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(600);
        console.log('    📍 Display saved — card appears');
      }},
      // 4:55 "card appears" — hover new display card
      { at: 295, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 5:10 "open button URL" — hover open/link button on display card
      { at: 310, fn: async (page) => {
        const el = page.locator('.sp-display-card button:has-text("Open"), .display-card a[target]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const card = page.locator('.sp-display-card').first();
          const cBox = await card.boundingBox().catch(() => null);
          if (cBox) await smoothMoveTo(page, cBox.x + cBox.width - 50, cBox.y + cBox.height / 2);
        }
        await page.waitForTimeout(1200);
        console.log('    📍 Open button — links to display page');
      }},
      // 5:35 "display page opens" — narration gap, hover display card
      { at: 335, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 6:02 "full-screen schedule" — narration gap
      { at: 362, fn: async (page) => {
        const el = page.locator('#ctx-panel, .ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 Full-screen schedule display mode');
      }},
      // 6:25 "sequences" — click display card to open edit modal
      { at: 385, fn: async (page) => {
        await smoothClick(page, 'button[onclick^="openDisplayModal(\'edit\'"]', 'Open display for sequences');
        await page.waitForTimeout(600);
        console.log('    📍 Sequences section');
      }},
      // 6:55 "add slide" — hover sequence add button
      { at: 415, fn: async (page) => {
        const el = page.locator('button:has-text("Add Slide"), button:has-text("+ Slide"), button:has-text("Add Mode")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(900);
          await page.evaluate(([px, py]) => window.__cdRipple(px, py), [box.x + box.width / 2, box.y + box.height / 2]);
          await page.locator('button:has-text("Add Slide"), button:has-text("+ Slide"), button:has-text("Add Mode")').first().click();
          await page.waitForTimeout(600);
        }
        console.log('    📍 Add slide clicked');
      }},
      // 7:15 "three slides" — narration gap, hover sequence list
      { at: 435, fn: async (page) => {
        const el = page.locator('.seq-item, .sequence-item').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const modal = page.locator('.ev-modal-card').first();
          const mBox = await modal.boundingBox().catch(() => null);
          if (mBox) await smoothMoveTo(page, mBox.x + mBox.width / 2, mBox.y + 250);
        }
        await page.waitForTimeout(1200);
        console.log('    📍 Three sequence slides visible');
      }},
      // 8:00 "scroll style" — hover scroll style dropdown
      { at: 480, fn: async (page) => {
        const el = page.locator('#disp-scroll, select[id*="scroll"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const modal = page.locator('.ev-modal-card').first();
          const mBox = await modal.boundingBox().catch(() => null);
          if (mBox) await smoothMoveTo(page, mBox.x + mBox.width / 2, mBox.y + 320);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Scroll style options visible');
      }},
      // 8:17 "scroll mode" — select scroll in dropdown
      { at: 497, fn: async (page) => {
        await page.locator('#disp-scroll, select[id*="scroll"]').first().selectOption('scroll').catch(() => {});
        const el = page.locator('#disp-scroll, select[id*="scroll"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Scroll mode selected');
      }},
      // 8:28 "paginate mode" — switch to paginate
      { at: 508, fn: async (page) => {
        await page.locator('#disp-scroll, select[id*="scroll"]').first().selectOption('paginate').catch(() => {});
        const el = page.locator('#disp-scroll, select[id*="scroll"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Paginate mode selected');
        // Save and close
        await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save display settings');
        await page.locator('#disp-modal, .ev-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
      }},
    ],
  },

  // ── Episode 8: All 11 Signage Display Modes ──────────────────────────────
  // Synchronized to ep08-captions.srt (~587s)
  8: {
    name: 'Signage Display Modes',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 intro — switch to signage, ensure a display card exists to demo modes
      { at: 5, fn: async (page) => {
        await switchRole(page, 'signage');
        await page.waitForTimeout(800);
        // If no display card exists (ep07 might not have saved), create one now
        const cardExists = await page.locator('.sp-display-card').first().isVisible().catch(() => false);
        if (!cardExists) {
          await smoothClick(page, "button[onclick=\"openDisplayModal('add')\"]", 'Add Display');
          await page.waitForTimeout(500);
          await page.locator('#dm-name').first().fill('Main Screen').catch(() => {});
          await page.waitForTimeout(300);
          await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save display');
          await page.locator('#disp-modal').waitFor({ state: 'hidden', timeout: 8000 }).catch(async () => {
            await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          });
          await page.waitForTimeout(500);
        }
        console.log('    📍 Signage display modes episode');
      }},
      // 0:33 "schedule mode" — open display card, select schedule mode
      { at: 33, fn: async (page) => {
        await smoothClick(page, "button[onclick^=\"openDisplayModal('edit'\"]", 'Open display config');
        if (!await page.locator('#disp-modal').isVisible().catch(() => false)) {
          await smoothClick(page, 'button[onclick^="openDisplayModal(\'edit\'"]', 'Open display config (fallback)');
        }
        await page.waitForTimeout(600);
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('schedule').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Schedule mode');
      }},
      // 0:58 "agenda mode" — select agenda
      { at: 58, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('agenda').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Agenda mode');
      }},
      // 1:45 "timeline mode" — select timeline
      { at: 105, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('timeline').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Timeline mode');
      }},
      // 2:23 "programme mode" — select programme
      { at: 143, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('programme').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Programme mode');
      }},
      // 2:55 "next up mode" — select next-up
      { at: 175, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('next-up').catch(async () => {
          await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('nextup').catch(() => {});
        });
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Next Up mode');
      }},
      // 3:33 "countdown mode" — select countdown
      { at: 213, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('countdown').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Countdown mode');
      }},
      // 4:07 "clock mode" — select clock
      { at: 247, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('clock').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Clock mode');
      }},
      // 4:29 "sponsor mode" — select sponsor
      { at: 269, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('sponsor').catch(() => {
          page.locator('#disp-mode, select[id*="mode"]').first().selectOption('sponsors').catch(() => {});
        });
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Sponsor mode');
      }},
      // 5:08 "ticker mode" — select ticker
      { at: 308, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('ticker').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Ticker mode');
      }},
      // 5:35 "recall mode" — select recall
      { at: 335, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('recall').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Recall mode');
      }},
      // 6:05 "stage timer mode" — select stage-timer
      { at: 365, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('stage-timer').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1500);
        console.log('    📍 Stage Timer mode');
        // Save and close
        await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save display');
        await page.locator('#disp-modal, .ev-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
      }},
      // 7:10 "global overrides" — hover global override buttons in ctx panel
      { at: 430, fn: async (page) => {
        const el = page.locator('.ctx-btn, #ctx-actions').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Global overrides visible');
      }},
      // 8:05 "break screen" — hover break screen button
      { at: 485, fn: async (page) => {
        const el = page.locator('.ctx-btn:has-text("Break"), button:has-text("Break Screen")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(900);
          await smoothClick(page, '.ctx-btn:has-text("Break"), button:has-text("Break Screen")', 'Break screen override');
        } else {
          const ctx = page.locator('#ctx-panel').first();
          const cBox = await ctx.boundingBox().catch(() => null);
          if (cBox) await smoothMoveTo(page, cBox.x + cBox.width / 2, cBox.y + 100);
          await page.waitForTimeout(900);
        }
        console.log('    📍 Break screen override');
      }},
      // 8:30 "five-minute recall" — hover recall button
      { at: 510, fn: async (page) => {
        const el = page.locator('.ctx-btn:has-text("Recall"), button:has-text("5 Min")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const ctx = page.locator('#ctx-panel').first();
          const cBox = await ctx.boundingBox().catch(() => null);
          if (cBox) await smoothMoveTo(page, cBox.x + cBox.width / 2, cBox.y + 140);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Five-minute recall override');
      }},
      // 9:00 "clear override / outro" — narration gap, hover ctx panel
      { at: 540, fn: async (page) => {
        const el = page.locator('#ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Display modes walkthrough complete');
      }},
    ],
  },

  // ── Episode 9: Stage Confidence Monitor ──────────────────────────────────
  // Synchronized to ep09-captions.srt (~407s)
  9: {
    name: 'Stage Confidence Monitor',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "director eyes everywhere" — ensure director role, select first session
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 0);
        console.log('    📍 Stage confidence monitor episode');
      }},
      // 0:32 "stage confidence monitor" — hover ctx panel STAGE MONITOR button
      { at: 32, fn: async (page) => {
        const el = page.locator('.ctx-btn:has-text("STAGE MONITOR"), button:has-text("Stage Monitor")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const ctx = page.locator('#ctx-panel').first();
          const cBox = await ctx.boundingBox().catch(() => null);
          if (cBox) await smoothMoveTo(page, cBox.x + cBox.width / 2, cBox.y + 80);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Stage Monitor button visible');
      }},
      // 0:36 "click it" — click STAGE MONITOR (use onclick selector — icon prefix breaks exact text match)
      { at: 36, fn: async (page) => {
        await smoothClick(page, 'button[onclick="openStageMonitor()"]', 'STAGE MONITOR');
      }},
      // 0:41 "overlay fills screen" — let overlay display
      { at: 41, fn: async (page) => {
        console.log('    📍 Stage monitor overlay — fullscreen');
        await page.waitForTimeout(5000);
      }},
      // 1:08 "z-index 9000" — narration, hover overlay
      { at: 68, fn: async (page) => {
        await smoothMoveTo(page, 960, 540);
        await page.waitForTimeout(900);
      }},
      // 1:28 "session title huge" — move cursor to title area (top of screen)
      { at: 88, fn: async (page) => {
        await smoothMoveTo(page, 960, 200);
        await page.waitForTimeout(900);
        console.log('    📍 Session title visible in monitor');
      }},
      // 1:40 "speaker name" — hover speaker area
      { at: 100, fn: async (page) => {
        await smoothMoveTo(page, 960, 320);
        await page.waitForTimeout(800);
      }},
      // 1:43 "timer" — hover timer area (centre screen)
      { at: 103, fn: async (page) => {
        await smoothMoveTo(page, 960, 480);
        await page.waitForTimeout(900);
        console.log('    📍 Live timer visible');
      }},
      // 1:58 "next session" — hover bottom area
      { at: 118, fn: async (page) => {
        await smoothMoveTo(page, 960, 750);
        await page.waitForTimeout(900);
        console.log('    📍 Next session visible at bottom');
      }},
      // 2:13 "three colour scheme" — move cursor back to centre
      { at: 133, fn: async (page) => {
        await smoothMoveTo(page, 960, 540);
        await page.waitForTimeout(900);
        console.log('    📍 Colour scheme — green state');
      }},
      // 2:46 "amber < 5 min" — narration gap, hover timer area
      { at: 166, fn: async (page) => {
        await smoothMoveTo(page, 960, 480);
        await page.waitForTimeout(900);
        console.log('    📍 Amber colour at < 5 min');
      }},
      // 3:06 "red < 2 min" — narration gap
      { at: 186, fn: async (page) => {
        await smoothMoveTo(page, 960, 480);
        await page.waitForTimeout(900);
        console.log('    📍 Red colour at < 2 min');
      }},
      // 3:24 "OVERRUN" — narration gap, hover centre
      { at: 204, fn: async (page) => {
        await smoothMoveTo(page, 960, 540);
        await page.waitForTimeout(900);
        console.log('    📍 OVERRUN flash state');
      }},
      // 4:00 "practical moment" — narration gap, hover title area
      { at: 240, fn: async (page) => {
        await smoothMoveTo(page, 960, 200);
        await page.waitForTimeout(900);
        console.log('    📍 Practical use case');
      }},
      // 4:40 "close monitor" — click close button (not just Escape)
      { at: 280, fn: async (page) => {
        const closeBtn = page.locator('#stage-monitor-overlay .close-btn, .stage-monitor .close, button:has-text("CLOSE")').first();
        const box = await closeBtn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await closeBtn.click();
        } else {
          await pressKey(page, 'Escape', 'Close stage monitor');
        }
        await page.waitForTimeout(600);
        console.log('    📍 Monitor closed — console visible again');
      }},
      // 5:07 "console comes back" — click session to show it's interactive
      { at: 307, fn: async (page) => {
        await clickSession(page, 0);
        await page.waitForTimeout(600);
        console.log('    📍 Console fully interactive after closing monitor');
      }},
      // 5:20 "press Escape alternative" — re-open monitor, then press Escape
      { at: 320, fn: async (page) => {
        await smoothClick(page, 'button[onclick="openStageMonitor()"]', 'Re-open STAGE MONITOR');
        await page.waitForTimeout(2000);
        await pressKey(page, 'Escape', 'Close via Escape key');
        await page.waitForTimeout(600);
        console.log('    📍 Escape also closes monitor');
      }},
      // 5:40 "not director-only" — switch to AV role
      { at: 340, fn: async (page) => {
        await switchRole(page, 'av');
        await page.waitForTimeout(600);
        console.log('    📍 Switching to AV role');
      }},
      // 6:00 "AV role" — click session and open monitor from AV
      { at: 360, fn: async (page) => {
        await clickSession(page, 0);
        await page.waitForTimeout(600);
        await smoothClick(page, 'button[onclick="openStageMonitor()"]', 'STAGE MONITOR from AV');
        await page.waitForTimeout(2000);
        console.log('    📍 AV role can also open monitor');
      }},
      // 6:20 "AV sees same overlay" — hover overlay content
      { at: 380, fn: async (page) => {
        await smoothMoveTo(page, 960, 400);
        await page.waitForTimeout(900);
        console.log('    📍 AV sees same monitor overlay');
      }},
      // 6:35 "outro" — close and switch back to director
      { at: 395, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close monitor');
        await page.waitForTimeout(400);
        await switchRole(page, 'director');
        console.log('    📍 Stage monitor demo complete');
      }},
    ],
  },

  // ── Episode 10: Stage Timer ──────────────────────────────────────────────
  // Synchronized to ep10-captions.srt (~484s)
  10: {
    name: 'Stage Timer',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:02 setup — reset session[0] to PLANNED for Stage Timer state machine demo
      { at: 2, fn: async (page) => {
        await switchRole(page, 'director');
        await page.waitForTimeout(600);
        const resetResult = await page.evaluate(async () => {
          try {
            // Get session IDs from rendered .sc cards — cards have id="card-{uuid}"
            const cards = [...document.querySelectorAll('.sc')];
            let ids = cards.map(c => {
              const cardId = c.getAttribute('id') || '';
              return cardId.startsWith('card-') ? cardId.slice(5) : null;
            }).filter(id => id && id.length === 36);
            if (ids.length === 0) {
              // Fallback: query first 2 sessions from DB
              const { data } = await sb.from('leod_sessions').select('id').order('seq').limit(2);
              if (data) ids = data.map(r => r.id).filter(id => typeof id === 'string' && id.length === 36);
            }
            if (ids.length === 0) return 'no session IDs found';
            const targetId = ids[0];
            const { error } = await sb.from('leod_sessions')
              .update({ status: 'PLANNED', cumulative_delay: 0, delay_minutes: 0 })
              .eq('id', targetId);
            if (error) return `error: ${error.message}`;
            if (typeof loadSnapshot === 'function' && S.event) await loadSnapshot(S.event.id);
            return `reset to PLANNED: ${targetId.slice(0, 8)}`;
          } catch (e) { return `exception: ${e?.message || String(e)}`; }
        });
        await page.waitForTimeout(2000); // wait for loadSnapshot + realtime propagation
        console.log(`    📍 Session DB reset: ${resetResult}`);
        console.log('    📍 Session[0] reset to PLANNED for Stage Timer state machine demo');
      }},
      // 0:05 "problem speakers face" — hover session card in director view
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 0);
        console.log('    📍 Stage Timer episode — director view');
      }},
      // 0:30 "stage timer solves" — hover ctx panel
      { at: 30, fn: async (page) => {
        const el = page.locator('#ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Stage timer concept');
      }},
      // 0:55 "set one up" — switch to signage role
      { at: 55, fn: async (page) => {
        await switchRole(page, 'signage');
        console.log('    📍 Signage role — create stage-timer display');
      }},
      // 1:20 "create display" — hover Add Display button
      { at: 80, fn: async (page) => {
        const el = page.locator('button:has-text("Add Display"), button:has-text("+ Display")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 1:35 "give name Stage Timer" — click Add Display, type name
      { at: 95, fn: async (page) => {
        await smoothClick(page, 'button:has-text("Add Display"), button:has-text("+ Display")', 'Add Display');
        await page.waitForTimeout(600);
        await smoothType(page, '#dm-name', 'Stage Timer — Room A', 'Display name', 90);
      }},
      // 1:48 "zone stage" — hover zone field
      { at: 108, fn: async (page) => {
        const el = page.locator('#disp-zone, select[id*="zone"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(900);
        }
        console.log('    📍 Zone: stage');
      }},
      // 1:57 "select stage-timer mode" — select the mode
      { at: 117, fn: async (page) => {
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('stage-timer').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Stage-timer mode selected');
      }},
      // 2:00 "hit save" — save display
      { at: 120, fn: async (page) => {
        await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save stage-timer display');
        await page.locator('#disp-modal, .ev-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(600);
        console.log('    📍 Stage-timer display saved');
      }},
      // 2:03 "display card appears" — hover new display card
      { at: 123, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Stage-timer display card visible');
      }},
      // 2:11 "click open" — hover open button
      { at: 131, fn: async (page) => {
        const el = page.locator('.sp-display-card button:has-text("Open"), .display-card a').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Open button — links to stage timer display page');
      }},
      // 2:30 "large full-screen timer" — switch to director, open STAGE TIMER ctx button
      { at: 150, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 0);
        await page.waitForTimeout(600);
        const el = page.locator('.ctx-btn:has-text("STAGE TIMER"), button:has-text("Stage Timer")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 STAGE TIMER button in ctx panel');
      }},
      // 2:47 "standby state" — hover session card (PLANNED = standby)
      { at: 167, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Standby state (PLANNED session)');
      }},
      // 3:03 "go through each state" — SET READY
      { at: 183, fn: async (page) => {
        await clickCardBtn(page, 'SET READY');
        await page.waitForTimeout(1200);
        console.log('    📍 READY state on timer');
      }},
      // 3:38 "green state live" — CALL SPEAKER then CONFIRM ON STAGE
      { at: 218, fn: async (page) => {
        await clickCtxBtn(page, 'CALL SPEAKER');
        await page.waitForTimeout(1200);
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
        await page.waitForTimeout(1200);
        console.log('    📍 LIVE — green timer running');
      }},
      // 4:00 "label REMAINING" — hover ctx panel timer info
      { at: 240, fn: async (page) => {
        const el = page.locator('#ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 120);
        await page.waitForTimeout(1200);
        console.log('    📍 REMAINING label on timer');
      }},
      // 4:35 "amber < 5 min" — narration gap, hover session card
      { at: 275, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Amber at < 5 min remaining');
      }},
      // 5:00 "red < 2 min" — narration gap
      { at: 300, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Red at < 2 min remaining');
      }},
      // 5:30 "OVERRUN flips" — trigger OVERRUN via DB (no manual button exists)
      { at: 330, fn: async (page) => {
        await page.evaluate(async () => {
          const cards = [...document.querySelectorAll('.sc')];
          const id = cards.map(c => (c.id || '').startsWith('card-') ? c.id.slice(5) : null).find(x => x?.length === 36);
          if (id) {
            await sb.from('leod_sessions').update({ status: 'OVERRUN' }).eq('id', id);
            if (typeof loadSnapshot === 'function' && S.event) await loadSnapshot(S.event.id);
          }
        });
        await page.waitForTimeout(1200);
        console.log('    📍 OVERRUN state — timer flashes');
      }},
      // 6:00 "HOLD paused state" — click HOLD
      { at: 360, fn: async (page) => {
        // First end overrun to get back to live, then hold
        await clickCtxBtn(page, 'RESUME').catch(() => {});
        await page.waitForTimeout(600);
        await clickCtxBtn(page, 'HOLD');
        await page.waitForTimeout(1200);
        console.log('    📍 HOLD state — timer paused');
      }},
      // 6:35 "timer freezes" — narration gap, hover timer area
      { at: 395, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width - 80, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Timer frozen in HOLD');
      }},
      // 7:00 "portrait orientation" — narration gap
      { at: 420, fn: async (page) => {
        const el = page.locator('#ctx-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 Portrait orientation tip');
      }},
      // 7:30 "context panel STAGE TIMER button" — hover ctx btn
      { at: 450, fn: async (page) => {
        const el = page.locator('.ctx-btn:has-text("STAGE TIMER"), button:has-text("Stage Timer")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const ctx = page.locator('#ctx-panel').first();
          const cBox = await ctx.boundingBox().catch(() => null);
          if (cBox) await smoothMoveTo(page, cBox.x + cBox.width / 2, cBox.y + 100);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Stage Timer context button');
      }},
    ],
  },

  // ── Episode 11: AI Incident Advisor ──────────────────────────────────────
  // Synchronized to ep11-captions.srt (~366s)
  11: {
    name: 'AI Incident Advisor',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "keynote laptop died" — scroll to AI agents panel, click director
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        await smoothScroll(page, 400);
        await page.waitForTimeout(600);
        console.log('    📍 AI agents panel visible');
      }},
      // 0:36 "AI agents panel" — hover panel heading
      { at: 36, fn: async (page) => {
        const el = page.locator('.ai-agents-panel, #agents-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 30);
        await page.waitForTimeout(900);
        console.log('    📍 AI Agents panel');
      }},
      // 0:56 "director only" — click director role button to demonstrate
      { at: 56, fn: async (page) => {
        await smoothClick(page, '[data-role="director"]', 'Director role');
        await page.waitForTimeout(600);
        console.log('    📍 AI agents — director only');
      }},
      // 1:05 "powered by Claude" — hover Claude branding in panel
      { at: 65, fn: async (page) => {
        const el = page.locator('.ai-agents-panel, #agents-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 Powered by Claude');
      }},
      // 1:20 "you trigger manually" — hover Incident Advisor button
      { at: 80, fn: async (page) => {
        const el = page.locator('button[onclick*="CueDeckIncidentAdvisor"], button:has-text("Incident Alert"), button:has-text("Incident")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Incident Advisor button');
      }},
      // 1:30 "click Incident Advisor" — trigger incident via JS (triggers modal + fallback data)
      { at: 90, fn: async (page) => {
        await page.evaluate(() => {
          CueDeckIncidentAdvisor.trigger({
            system: 'Hall B PA System',
            location: 'Main Stage Left',
            severity: 'Critical',
            description: 'Keynote speaker laptop HDMI output died mid-presentation, slides frozen on backup switcher',
            timestamp: new Date().toLocaleTimeString()
          });
        });
        await page.waitForTimeout(800);
        console.log('    📍 Incident triggered — modal opening');
      }},
      // 1:40 "modal dark background red accent" — hover modal header
      { at: 100, fn: async (page) => {
        const el = page.locator('#cuedeck-incident-modal .ia-header').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Incident modal open — red accent bar');
      }},
      // 1:58 "title shown" — hover the auto-populated incident title
      { at: 118, fn: async (page) => {
        const el = page.locator('#ia-incident-title').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Incident title auto-populated');
      }},
      // 2:10 "AI thinking spinner" — hover thinking spinner (may already be done)
      { at: 130, fn: async (page) => {
        const el = page.locator('#ia-incident-meta').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Location + timestamp metadata');
      }},
      // 2:42 "under ten seconds" — hover diagnosis text
      { at: 162, fn: async (page) => {
        const el = page.locator('#ia-diagnosis').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 400);
        await page.waitForTimeout(1200);
        console.log('    📍 Diagnosis text visible');
      }},
      // 3:15 "response populates" — hover the diagnosis section label
      { at: 195, fn: async (page) => {
        const el = page.locator('#cuedeck-incident-modal .ia-section-label').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Diagnosis section');
      }},
      // 3:35 "resolution steps" — hover first resolution step
      { at: 215, fn: async (page) => {
        const el = page.locator('#ia-steps .ia-step').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 500);
        await page.waitForTimeout(900);
        console.log('    📍 Resolution step 1');
      }},
      // 3:59 "click to check off" — click step 1 (toggles strikethrough)
      { at: 239, fn: async (page) => {
        const step1 = page.locator('#ia-steps .ia-step').first();
        const box = await step1.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await step1.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Clicked step 1 — checked off');
      }},
      // 4:10 — click step 2
      { at: 250, fn: async (page) => {
        const step2 = page.locator('#ia-steps .ia-step').nth(1);
        const box = await step2.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await step2.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Clicked step 2 — checked off');
      }},
      // 4:25 — click step 3
      { at: 265, fn: async (page) => {
        const step3 = page.locator('#ia-steps .ia-step').nth(2);
        const box = await step3.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await step3.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Clicked step 3 — checked off');
      }},
      // 4:40 — hover estimated resolution time in footer
      { at: 280, fn: async (page) => {
        const el = page.locator('#ia-eta').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 680);
        await page.waitForTimeout(900);
        console.log('    📍 Estimated resolution: ~5 min');
      }},
      // 4:50 "mark resolved" — click MARK RESOLVED button
      { at: 290, fn: async (page) => {
        await smoothClick(page, '.ia-btn-resolve', 'MARK RESOLVED');
        await page.waitForTimeout(1200);
        console.log('    📍 Clicked MARK RESOLVED — green banner appears');
      }},
      // 5:05 "CueDeck logs" — hover the resolved banner
      { at: 305, fn: async (page) => {
        const el = page.locator('#ia-resolved-banner').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 RESOLVED banner — logged to event log');
      }},
      // 5:15 "close and reopen for escalate demo" — close modal
      { at: 315, fn: async (page) => {
        await smoothClick(page, '#cuedeck-incident-modal .ia-close', 'Close incident modal');
        await page.waitForTimeout(800);
        // Re-trigger a fresh incident to demo escalation
        await page.evaluate(() => {
          CueDeckIncidentAdvisor.trigger({
            system: 'Wireless Mic System',
            location: 'Workshop Room B',
            severity: 'Error',
            description: 'Channel 3 receiver showing intermittent dropouts on bodypack transmitter',
            timestamp: new Date().toLocaleTimeString()
          });
        });
        await page.waitForTimeout(1000);
        console.log('    📍 Second incident triggered for escalation demo');
      }},
      // 5:25 "Escalate button" — click ESCALATE button
      { at: 325, fn: async (page) => {
        await smoothClick(page, '.ia-btn-escalate', 'ESCALATE');
        await page.waitForTimeout(1200);
        console.log('    📍 Clicked ESCALATE — red banner appears');
      }},
      // 5:41 "when to reach for it" — hover escalated banner
      { at: 341, fn: async (page) => {
        const el = page.locator('#ia-escalated-banner').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Escalated — senior technician notified');
      }},
      // 6:05 outro — close modal
      { at: 365, fn: async (page) => {
        await smoothClick(page, '#cuedeck-incident-modal .ia-close', 'Close incident modal');
        console.log('    📍 Incident Advisor demo complete');
      }},
    ],
  },

  // ── Episode 12: AI Cue Engine ────────────────────────────────────────────
  // Synchronized to ep12-captions.srt (~335s)
  12: {
    name: 'AI Cue Engine',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "production problems 7 min before" — select session, director view
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 0);
        await page.waitForTimeout(600);
        console.log('    📍 AI Cue Engine episode — director view');
      }},
      // 0:23 "cue engine" — scroll to AI agents panel
      { at: 23, fn: async (page) => {
        await smoothScroll(page, 400);
        await page.waitForTimeout(600);
        const el = page.locator('.ai-agents-panel, #agents-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 40);
        await page.waitForTimeout(600);
        console.log('    📍 AI Agents panel — Cue Engine');
      }},
      // 0:33 "8 min before fires modal" — hover Cue Engine button
      { at: 33, fn: async (page) => {
        const el = page.locator('button[onclick*="CueDeckCueEngine"], button:has-text("Cue Alert"), button:has-text("Cue")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Cue Engine button — fires 8 min before');
      }},
      // 0:43 "show what happens" — trigger cue engine via JS with a fake session
      { at: 43, fn: async (page) => {
        await page.evaluate(() => {
          const fakeSession = {
            title: 'Opening Keynote — Sarah Chen',
            location: 'Main Stage',
            notes: 'Livestream + Polish interpretation',
            scheduled_start: new Date(Date.now() + 8 * 60000).toISOString(),
            speaker: 'Dr Sarah Chen',
            speaker_company: 'TechCorp',
            type: 'keynote',
          };
          const sessionTime = new Date(Date.now() + 8 * 60000);
          CueDeckCueEngine.triggerCue(fakeSession, sessionTime);
        });
        await page.waitForTimeout(1200);
        console.log('    📍 Cue Engine modal triggered');
      }},
      // 0:56 "pre-cue concept" — hover modal header (orange accent)
      { at: 56, fn: async (page) => {
        const el = page.locator('#cuedeck-cue-modal .ce-header').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Pre-cue modal header — orange accent');
      }},
      // 1:19 "session title" — hover session title in modal
      { at: 79, fn: async (page) => {
        const el = page.locator('#ce-title').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Session title: Opening Keynote');
      }},
      // 1:38 "countdown ticking" — hover countdown timer
      { at: 98, fn: async (page) => {
        const el = page.locator('#ce-timer').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Countdown timer ticking');
      }},
      // 1:48 "progress bar" — hover progress bar
      { at: 108, fn: async (page) => {
        const el = page.locator('#ce-progress').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Progress bar depleting');
      }},
      // 2:03 "Claude generates checklist" — hover checklist area
      { at: 123, fn: async (page) => {
        const el = page.locator('#ce-checklist .ce-check-item').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 AI-generated checklist items');
      }},
      // 2:13 "coloured tags CREW SYSTEM" — hover tag on first item
      { at: 133, fn: async (page) => {
        const el = page.locator('#ce-checklist .ce-tag').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Coloured tags — SYSTEM / CREW / INTERP');
      }},
      // 2:35 "click to confirm" — click checklist item 1
      { at: 155, fn: async (page) => {
        const item = page.locator('#ce-checklist .ce-check-item').first();
        const box = await item.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + 20, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await item.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Clicked item 1 — turns green');
      }},
      // 2:50 — click checklist item 2
      { at: 170, fn: async (page) => {
        const item = page.locator('#ce-checklist .ce-check-item').nth(1);
        const box = await item.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + 20, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await item.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Clicked item 2 — turns green');
      }},
      // 3:10 — click checklist item 3
      { at: 190, fn: async (page) => {
        const item = page.locator('#ce-checklist .ce-check-item').nth(2);
        const box = await item.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + 20, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await item.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Clicked item 3 — turns green');
      }},
      // 3:45 "session-specific items" — click checklist item 4
      { at: 225, fn: async (page) => {
        const item = page.locator('#ce-checklist .ce-check-item').nth(3);
        const box = await item.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + 20, box.y + box.height / 2);
          await page.waitForTimeout(400);
          await item.click();
        }
        await page.waitForTimeout(800);
        console.log('    📍 Clicked item 4 — turns green');
      }},
      // 4:03 "completion counter" — hover the checked count in footer
      { at: 243, fn: async (page) => {
        const el = page.locator('.ce-completion').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Completion counter updating');
      }},
      // 4:30 "click remaining items" — click items 5 and 6 if they exist
      { at: 270, fn: async (page) => {
        for (let i = 4; i < 7; i++) {
          const item = page.locator('#ce-checklist .ce-check-item').nth(i);
          if (await item.isVisible().catch(() => false)) {
            const box = await item.boundingBox().catch(() => null);
            if (box) {
              await smoothMoveTo(page, box.x + 20, box.y + box.height / 2);
              await page.waitForTimeout(300);
              await item.click();
              await page.waitForTimeout(400);
            }
          }
        }
        console.log('    📍 All remaining items checked');
      }},
      // 4:50 "SNOOZE 2 MIN" — hover snooze button to show it
      { at: 290, fn: async (page) => {
        const el = page.locator('.ce-btn-snooze').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 SNOOZE 2 MIN button visible');
      }},
      // 5:05 "CUE READY" — click CUE READY button
      { at: 305, fn: async (page) => {
        await smoothClick(page, '.ce-btn-ready', 'CUE READY');
        await page.waitForTimeout(800);
        console.log('    📍 Clicked CUE READY — modal closes, logged');
      }},
      // 5:15 "back to console" — show console is back
      { at: 315, fn: async (page) => {
        await clickSession(page, 0);
        await page.waitForTimeout(600);
        console.log('    📍 Console visible — cue confirmed');
      }},
    ],
  },

  // ── Episode 13: AI Post-Event Report ─────────────────────────────────────
  // Synchronized to ep13-captions.srt (~414s)
  13: {
    name: 'AI Report Generator',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "last session ended" — hover console showing ended sessions
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Post-event — sessions ended');
      }},
      // 0:25 "send client debrief" — hover AI agents panel
      { at: 25, fn: async (page) => {
        const el = page.locator('.ai-agents-panel, #agents-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 40);
        else await smoothMoveTo(page, 1700, 400);
        await page.waitForTimeout(900);
        console.log('    📍 AI Agents panel');
      }},
      // 0:43 "one click" — hover Report Generator button
      { at: 43, fn: async (page) => {
        const el = page.locator('#ai-report-btn, button:has-text("Report Generator"), button:has-text("Report")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Report Generator button');
      }},
      // 0:59 "report generator third AI agent" — hover button again (pre-click)
      { at: 59, fn: async (page) => {
        const el = page.locator('#ai-report-btn, button:has-text("Report Generator"), button:has-text("Report")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
      }},
      // 1:20 "click generate report" — open report modal
      { at: 80, fn: async (page) => {
        await smoothClick(page, '#ai-report-btn, button:has-text("Report Generator"), button:has-text("Report")', 'Open Report Generator');
        await page.waitForTimeout(600);
        console.log('    📍 Report modal opening');
      }},
      // 1:40 "pulls session records" — hover modal loading state
      { at: 100, fn: async (page) => {
        const el = page.locator('#cuedeck-report-modal, .report-modal').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.4);
        else await smoothMoveTo(page, 960, 450);
        await page.waitForTimeout(900);
        console.log('    📍 Pulling session records');
      }},
      // 2:00 "thinking animation" — hover animated loading indicator
      { at: 120, fn: async (page) => {
        const el = page.locator('#cuedeck-report-modal .loading, .report-modal .thinking, .report-modal .spinner').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 480);
        await page.waitForTimeout(1200);
        console.log('    📍 Thinking animation');
      }},
      // 2:15 "typically 15-20 seconds" — narration gap
      { at: 135, fn: async (page) => {
        const el = page.locator('#cuedeck-report-modal, .report-modal').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.5);
        await page.waitForTimeout(900);
        console.log('    📍 Waiting for Claude response (~15-20s)');
      }},
      // 2:25 "tabs appear" — hover report tabs
      { at: 145, fn: async (page) => {
        const el = page.locator('#ra-tabs .ra-tab, #cuedeck-report-modal .ra-tab').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 350);
        await page.waitForTimeout(900);
        console.log('    📍 Report tabs appeared');
      }},
      // 2:40 "summary tab stat cards" — hover summary tab content
      { at: 160, fn: async (page) => {
        const el = page.locator('#cuedeck-report-modal .stat-card, .report-modal .summary-stat').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 420);
        await page.waitForTimeout(1200);
        console.log('    📍 Summary tab — stat cards');
      }},
      // 3:15 "written sections from Claude" — scroll down in modal
      { at: 195, fn: async (page) => {
        await smoothScroll(page, 200);
        await page.waitForTimeout(1200);
        console.log('    📍 Written sections from Claude');
      }},
      // 3:35 "executive summary" — hover executive summary section
      { at: 215, fn: async (page) => {
        const el = page.locator('#cuedeck-report-modal .executive-summary, .report-modal h2, .report-modal h3').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 480);
        await page.waitForTimeout(900);
        console.log('    📍 Executive summary section');
      }},
      // 3:55 "sessions tab variance table" — click Sessions tab
      { at: 235, fn: async (page) => {
        await smoothScroll(page, -200);
        await smoothClick(page, 'div[onclick*="switchTab(\'sessions\')"]', 'Sessions tab');
        await page.waitForTimeout(600);
        console.log('    📍 Sessions tab — variance table');
      }},
      // 4:25 "green orange red" — hover coloured variance cells
      { at: 265, fn: async (page) => {
        const el = page.locator('#cuedeck-report-modal table, .report-modal .variance-table').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
          await page.waitForTimeout(600);
          await smoothMoveTo(page, box.x + box.width * 0.7, box.y + 100);
          await page.waitForTimeout(600);
        }
        console.log('    📍 Colour-coded variance: green / orange / red');
      }},
      // 4:45 "incidents tab" — click Incidents tab
      { at: 285, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'incidents\')"]', 'Incidents tab');
        await page.waitForTimeout(600);
        console.log('    📍 Incidents tab');
      }},
      // 5:10 "AI narrative fourth tab" — click AI/Narrative tab
      { at: 310, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'recommendations\')"]', 'Narrative tab');
        await page.waitForTimeout(600);
        console.log('    📍 AI Narrative tab');
      }},
      // 5:40 "synthesises everything" — scroll narrative content
      { at: 340, fn: async (page) => {
        await smoothScroll(page, 180);
        await page.waitForTimeout(1000);
        console.log('    📍 Claude synthesises full event narrative');
      }},
      // 6:05 "recommendations" — scroll to recommendations
      { at: 365, fn: async (page) => {
        await smoothScroll(page, 180);
        await page.waitForTimeout(900);
        console.log('    📍 Recommendations section');
      }},
      // 6:25 "copy text" — click Copy Text button
      { at: 385, fn: async (page) => {
        await smoothScroll(page, -360);
        const copyBtn = page.locator('#cuedeck-report-modal button:has-text("Copy"), .ra-btn:has-text("Copy")').first();
        const box = await copyBtn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(500);
          await copyBtn.click();
          await page.waitForTimeout(800);
        }
        console.log('    📍 Copy Text clicked — report in clipboard');
      }},
      // 6:40 "Print/PDF" — hover Print button
      { at: 400, fn: async (page) => {
        const printBtn = page.locator('#cuedeck-report-modal button:has-text("Print"), .ra-btn:has-text("Print")').first();
        const box = await printBtn.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Print / PDF export button');
      }},
      // 6:54 outro — close modal
      { at: 414, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close report modal');
        console.log('    📍 Report Generator demo complete');
      }},
    ],
  },

  // ── Episode 14: Timeline & Programme Displays ────────────────────────────
  // Synchronized to ep14-captions.srt (~456s)
  14: {
    name: 'Timeline & Programme',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:02 setup — reset sessions[0,1] to PLANNED for state machine demo
      { at: 2, fn: async (page) => {
        await switchRole(page, 'director');
        await page.waitForTimeout(400);
        const resetResult = await page.evaluate(async () => {
          try {
            // Get current event's sessions
            const eventId = S?.eventId || null;
            let query = sb.from('leod_sessions').select('id, status').order('seq').limit(2);
            if (eventId) query = query.eq('event_id', eventId);
            const { data: sessions } = await query;
            if (sessions && sessions.length > 0) {
              const before = sessions.map(s => `${s.id.slice(0,8)}:${s.status}`).join(', ');
              const ids = sessions.map(s => s.id);
              const { error } = await sb.from('leod_sessions')
                .update({ status: 'PLANNED', cumulative_delay: 0, delay_minutes: 0 })
                .in('id', ids);
              if (error) return `error: ${error.message}`;
              // Verify the update
              let vQuery = sb.from('leod_sessions').select('id, status').order('seq').limit(2);
              if (eventId) vQuery = vQuery.eq('event_id', eventId);
              const { data: after } = await vQuery;
              const afterStr = after?.map(s => `${s.id.slice(0,8)}:${s.status}`).join(', ') || 'none';
              // Force UI refresh
              if (typeof loadSnapshot === 'function' && S.event) await loadSnapshot(S.event.id);
              return `before=[${before}] after=[${afterStr}]`;
            }
            return 'no sessions found';
          } catch (e) { return `exception: ${e}`; }
        });
        await page.waitForTimeout(2000); // wait for loadSnapshot + realtime propagation
        console.log(`    📍 Session DB reset: ${resetResult}`);
        console.log('    📍 Sessions[0,1] reset to PLANNED for timeline & programme demo');
      }},
      // 0:05 "attendees shouldn't check phones" — switch to signage + ensure display card exists
      { at: 5, fn: async (page) => {
        await switchRole(page, 'signage');
        await page.waitForTimeout(800);
        // Ensure at least one display card exists (ep10 might not have saved one)
        const cardExists = await page.locator('.sp-display-card').first().isVisible().catch(() => false);
        if (!cardExists) {
          await smoothClick(page, "button[onclick=\"openDisplayModal('add')\"]", 'Add Display');
          await page.waitForTimeout(500);
          await page.locator('#dm-name').first().fill('Main Screen').catch(() => {});
          await page.waitForTimeout(300);
          await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save display');
          await page.locator('#disp-modal').waitFor({ state: 'hidden', timeout: 8000 }).catch(async () => {
            await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          });
          await page.waitForTimeout(500);
        }
        console.log('    📍 Timeline & Programme episode');
      }},
      // 0:23 "timeline and programme modes" — hover display cards
      { at: 23, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const panel = page.locator('.sp-panel, #signage-panel').first();
          const pBox = await panel.boundingBox().catch(() => null);
          if (pBox) await smoothMoveTo(page, pBox.x + pBox.width / 2, pBox.y + 100);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Display cards visible');
      }},
      // 0:31 "signage panel" — hover panel header
      { at: 31, fn: async (page) => {
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 30);
        await page.waitForTimeout(900);
      }},
      // 0:53 "displays configured" — hover existing display card
      { at: 53, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 1:05 "set to timeline mode" — open display and select timeline
      { at: 65, fn: async (page) => {
        await smoothClick(page, 'button[onclick^="openDisplayModal(\'edit\'"]', 'Open display config');
        await page.waitForTimeout(600);
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('timeline').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Timeline mode selected');
      }},
      // 1:25 "scroll style options" — hover scroll style
      { at: 85, fn: async (page) => {
        const el = page.locator('#disp-scroll, select[id*="scroll"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(900);
        }
        console.log('    📍 Scroll style options');
      }},
      // 1:48 "paginate 10 seconds" — select paginate, set seconds
      { at: 108, fn: async (page) => {
        await page.locator('#disp-scroll, select[id*="scroll"]').first().selectOption('paginate').catch(() => {});
        const el = page.locator('#disp-paginate-secs, input[id*="paginate"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
          await el.fill('10');
          await page.waitForTimeout(600);
        }
        console.log('    📍 Paginate 10 seconds set');
      }},
      // 1:56 "here's what display looks like" — save and close
      { at: 116, fn: async (page) => {
        await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save timeline display');
        await page.locator('#disp-modal, .ev-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(600);
        console.log('    📍 Timeline display saved');
      }},
      // 2:25 "live session green indicator" — hover display card
      { at: 145, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Live session green indicator in timeline');
      }},
      // 2:55 "updates realtime" — narration gap
      { at: 175, fn: async (page) => {
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Real-time updates');
      }},
      // 3:00 "go live shows" — switch to director and go live on first session
      { at: 180, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 0);
        await clickCardBtn(page, 'SET READY');
        await page.waitForTimeout(800);
        await clickCtxBtn(page, 'CALL SPEAKER');
        await page.waitForTimeout(800);
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
        await page.waitForTimeout(800);
        console.log('    📍 Session LIVE — timeline updates');
      }},
      // 3:20 "set up programme mode" — switch back to signage
      { at: 200, fn: async (page) => {
        await switchRole(page, 'signage');
        console.log('    📍 Setting up Programme mode');
      }},
      // 3:40 "content mode programme" — open display, select programme
      { at: 220, fn: async (page) => {
        await smoothClick(page, 'button[onclick^="openDisplayModal(\'edit\'"]', 'Open display config');
        await page.waitForTimeout(600);
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('programme').catch(() => {});
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Programme mode selected');
      }},
      // 3:55 "time×room grid" — hover modal body
      { at: 235, fn: async (page) => {
        const el = page.locator('.ev-modal-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.5);
        await page.waitForTimeout(900);
        console.log('    📍 Time × room grid');
      }},
      // 4:25 "currently LIVE green highlight" — save and describe
      { at: 265, fn: async (page) => {
        await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save programme display');
        await page.locator('#disp-modal, .ev-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(600);
        console.log('    📍 Programme display saved — LIVE session highlighted green');
      }},
      // 4:45 "paginate setting" — open display config again for paginate
      { at: 285, fn: async (page) => {
        await smoothClick(page, 'button[onclick^="openDisplayModal(\'edit\'"]', 'Re-open display config');
        await page.waitForTimeout(600);
        const el = page.locator('#disp-scroll, select[id*="scroll"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Paginate setting for programme display');
      }},
      // 5:20 "for large conference grid" — close modal
      { at: 320, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close display config');
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 Paginate for large conference grid');
      }},
      // 5:50 "quick comparison" — hover both display cards
      { at: 350, fn: async (page) => {
        const cards = page.locator('.sp-display-card, .display-card');
        const count = await cards.count().catch(() => 0);
        for (let i = 0; i < Math.min(count, 2); i++) {
          const box = await cards.nth(i).boundingBox().catch(() => null);
          if (box) {
            await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(700);
          }
        }
        console.log('    📍 Quick comparison — Timeline vs Programme');
      }},
      // 6:40 "paginate settings per display" — hover display card
      { at: 400, fn: async (page) => {
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Paginate settings per display');
      }},
      // 7:15 "click go live" — switch to director, click go live
      { at: 435, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 1);
        await clickCardBtn(page, 'SET READY');
        console.log('    📍 Next session going READY');
      }},
    ],
  },

  // ── Episode 15: Sponsor Logos ────────────────────────────────────────────
  // Synchronized to ep15-captions.srt (~463s)
  15: {
    name: 'Sponsor Logos',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "every conference has sponsors" — switch to signage role
      { at: 5, fn: async (page) => {
        await switchRole(page, 'signage');
        console.log('    📍 Sponsor Logos episode');
      }},
      // 0:26 "in this episode upload sponsors" — hover sponsors section in panel
      { at: 26, fn: async (page) => {
        const el = page.locator('.sp-sponsors, #sponsors-section, .sponsor-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 30);
        else {
          const panel = page.locator('.sp-panel, #signage-panel').first();
          const pBox = await panel.boundingBox().catch(() => null);
          if (pBox) await smoothMoveTo(page, pBox.x + pBox.width / 2, pBox.y + 200);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Sponsors section in panel');
      }},
      // 0:40 "sponsors section signage panel" — scroll to sponsors section
      { at: 40, fn: async (page) => {
        await smoothScroll(page, 200);
        await page.waitForTimeout(900);
        console.log('    📍 Sponsors section visible');
      }},
      // 0:56 "sponsor name logo duration" — hover sponsor list header
      { at: 56, fn: async (page) => {
        const el = page.locator('.sp-sponsors h3, .sponsor-list h3, .sponsor-section-header').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 1700, 400);
        await page.waitForTimeout(900);
        console.log('    📍 Sponsor name / logo / duration fields');
      }},
      // 1:15 "feeds every display in sponsor mode" — narration gap
      { at: 75, fn: async (page) => {
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 250);
        await page.waitForTimeout(900);
        console.log('    📍 Feeds all displays in sponsor mode');
      }},
      // 1:31 "add a sponsor" — scroll back to Add Sponsor button
      { at: 91, fn: async (page) => {
        await smoothScroll(page, -200);
        await page.waitForTimeout(600);
      }},
      // 1:35 "click Add Sponsor" — hover button
      { at: 95, fn: async (page) => {
        const el = page.locator('button:has-text("Add Sponsor"), button:has-text("+ Sponsor")').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 1:40 "small form" — click Add Sponsor
      { at: 100, fn: async (page) => {
        await smoothClick(page, 'button:has-text("Add Sponsor"), button:has-text("+ Sponsor")', 'Add Sponsor');
        await page.waitForTimeout(600);
        console.log('    📍 Sponsor modal open');
      }},
      // 1:48 "logo file PNG transparent" — hover name field and logo upload
      { at: 108, fn: async (page) => {
        const el = page.locator('#spon-name, input[placeholder*="sponsor" i], input[placeholder*="name" i]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
        }
        // Type sponsor name
        await smoothType(page, '#spon-name, input[placeholder*="sponsor" i]', 'TechCorp Solutions', 'Sponsor name', 90);
      }},
      // 2:23 "upload logo" — hover file upload area
      { at: 143, fn: async (page) => {
        const el = page.locator('#spon-logo, input[type="file"], .logo-upload').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const modal = page.locator('.ev-modal-card').first();
          const mBox = await modal.boundingBox().catch(() => null);
          if (mBox) await smoothMoveTo(page, mBox.x + mBox.width / 2, mBox.y + 120);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Logo upload area');
      }},
      // 2:35 "hit save uploads" — click Save
      { at: 155, fn: async (page) => {
        await smoothClick(page, 'button[onclick="saveSponsor()"]', 'Save sponsor');
        // Wait for modal to fully close before clicking Add Sponsor again
        await page.locator('#spon-modal').waitFor({ state: 'hidden', timeout: 8000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('spon-modal'); if (m) m.style.display = 'none'; });
        });
        await page.waitForTimeout(400);
        console.log('    📍 Sponsor saved');
      }},
      // 2:55 "add as many as needed" — add second sponsor
      { at: 175, fn: async (page) => {
        await smoothClick(page, "button[onclick=\"openSponsorModal('add')\"]", 'Add second sponsor');
        await page.waitForTimeout(600);
        await smoothType(page, '#spon-name, input[placeholder*="sponsor" i]', 'InnovateTech Ltd', 'Sponsor 2 name', 90);
        await smoothClick(page, 'button[onclick="saveSponsor()"]', 'Save sponsor 2');
        await page.locator('#spon-modal').waitFor({ state: 'hidden', timeout: 8000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('spon-modal'); if (m) m.style.display = 'none'; });
        });
        await page.waitForTimeout(400);
        console.log('    📍 Multiple sponsors added');
      }},
      // 3:20 "sort order rotation sequence" — hover sponsor list
      { at: 200, fn: async (page) => {
        const el = page.locator('.sponsor-item, .spon-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Sort order / rotation sequence');
      }},
      // 3:40 "logos uploaded live immediately" — narration gap
      { at: 220, fn: async (page) => {
        const el = page.locator('.sponsor-item, .spon-card').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Logos live immediately on display');
      }},
      // 3:50 "open display" — switch display to sponsor mode
      { at: 230, fn: async (page) => {
        const el = page.locator('button[onclick^="openDisplayModal(\'edit\'"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(800);
        console.log('    📍 Opening display for sponsor mode');
      }},
      // 4:05 "content mode sponsors" — click display, set to sponsor mode
      { at: 245, fn: async (page) => {
        await smoothClick(page, 'button[onclick^="openDisplayModal(\'edit\'"]', 'Open display config');
        await page.waitForTimeout(600);
        await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('sponsor').catch(async () => {
          await page.locator('#disp-mode, select[id*="mode"]').first().selectOption('sponsors').catch(() => {});
        });
        const el = page.locator('#disp-mode, select[id*="mode"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Sponsor mode selected');
      }},
      // 4:30 "sequence builder" — hover sequence area
      { at: 270, fn: async (page) => {
        const el = page.locator('.seq-builder, .sequence-builder, #seq-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 40);
        else {
          const modal = page.locator('.ev-modal-card').first();
          const mBox = await modal.boundingBox().catch(() => null);
          if (mBox) await smoothMoveTo(page, mBox.x + mBox.width / 2, mBox.y + 250);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Sequence builder');
      }},
      // 4:55 "sequence NextUp + sponsors" — add slides
      { at: 295, fn: async (page) => {
        const addBtn = page.locator('button:has-text("Add Slide"), button:has-text("+ Slide")').first();
        if (await addBtn.isVisible().catch(() => false)) {
          await smoothClick(page, 'button:has-text("Add Slide"), button:has-text("+ Slide")', 'Add slide 1');
          await page.waitForTimeout(600);
        }
        console.log('    📍 Sequence: NextUp + sponsors');
      }},
      // 5:30 "sequence runs automatically" — save display
      { at: 330, fn: async (page) => {
        await smoothClick(page, 'button[onclick="saveDisplay()"]', 'Save sequence');
        await page.locator('#disp-modal, .ev-modal').waitFor({ state: 'hidden', timeout: 10000 }).catch(async () => {
          await page.evaluate(() => { const m = document.getElementById('disp-modal'); if (m) m.style.display = 'none'; });
          await page.waitForTimeout(150);
        });
        await page.waitForTimeout(600);
        console.log('    📍 Sequence runs automatically');
      }},
      // 6:30 "PNG tips" — narration gap, hover sponsors section
      { at: 390, fn: async (page) => {
        await smoothScroll(page, 200);
        const el = page.locator('.sp-sponsors, #sponsors-section, .sponsor-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 PNG tips — transparent background');
      }},
      // 7:00 "duration 8-10 seconds" — narration gap, hover sponsor items
      { at: 420, fn: async (page) => {
        const el = page.locator('.sponsor-item, .spon-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Duration 8-10 seconds recommendation');
      }},
    ],
  },

  // ── Episode 16: Event Log & Post-Event Report ────────────────────────────
  // Synchronized to ep16-captions.srt (~450s)
  16: {
    name: 'Event Log & Report',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "event is over" — hover session list in director view
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Event Log episode');
      }},
      // 0:17 "which sessions ran late" — hover session cards with delay tags
      { at: 17, fn: async (page) => {
        const el = page.locator('.sc').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Which sessions ran late');
      }},
      // 0:24 "CueDeck recording every action" — hover event log button area
      { at: 24, fn: async (page) => {
        const el = page.locator('#log-toggle, button:has-text("Event Log"), .log-btn').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 80);
        await page.waitForTimeout(900);
        console.log('    📍 CueDeck records every action');
      }},
      // 0:40 "where it lives" — highlight Event Log panel (always visible in sidebar)
      { at: 40, fn: async (page) => {
        const el = page.locator('#log-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + 30);
          await page.waitForTimeout(300);
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.4);
        } else {
          await smoothMoveTo(page, 250, 400);
        }
        await page.waitForTimeout(600);
        console.log('    📍 Event log panel (always visible in sidebar)');
      }},
      // 0:52 "event log leod_event_log" — hover log table header
      { at: 52, fn: async (page) => {
        const el = page.locator('#event-log, .event-log, .log-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 30);
        else await smoothMoveTo(page, 960, 300);
        await page.waitForTimeout(900);
        console.log('    📍 leod_event_log table');
      }},
      // 1:10 "every row state transition" — hover first log rows
      { at: 70, fn: async (page) => {
        const el = page.locator('#event-log tr, .event-log .log-row, .log-entry').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 350);
        await page.waitForTimeout(900);
        console.log('    📍 Every row = state transition');
      }},
      // 1:35 "scroll through" — scroll log
      { at: 95, fn: async (page) => {
        await smoothScroll(page, 250);
        await page.waitForTimeout(1200);
        console.log('    📍 Scrolling through event log');
      }},
      // 1:45 "session 2 played out" — hover mid-log entries
      { at: 105, fn: async (page) => {
        const el = page.locator('#event-log tr, .log-entry').nth(5);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 420);
        await page.waitForTimeout(900);
      }},
      // 2:00 "ready 9:02" — hover specific log entry
      { at: 120, fn: async (page) => {
        const el = page.locator('#event-log tr, .log-entry').nth(8);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 460);
        await page.waitForTimeout(900);
        console.log('    📍 READY at 9:02 — precise timestamps');
      }},
      // 2:10 "look further down" — scroll more
      { at: 130, fn: async (page) => {
        await smoothScroll(page, 200);
        await page.waitForTimeout(1000);
      }},
      // 2:20 "delay at ten-forty-seven" — hover delay entry
      { at: 140, fn: async (page) => {
        const el = page.locator('#event-log tr, .log-entry').nth(12);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 500);
        await page.waitForTimeout(900);
        console.log('    📍 Delay applied at 10:47');
      }},
      // 2:45 "if client asks why" — narration gap, scroll log
      { at: 165, fn: async (page) => {
        await smoothScroll(page, 100);
        await page.waitForTimeout(900);
        console.log('    📍 Client audit trail');
      }},
      // 3:05 "under the hood" — scroll back to top of log
      { at: 185, fn: async (page) => {
        await smoothScroll(page, -500);
        await page.waitForTimeout(900);
        console.log('    📍 Under the hood — leod_event_log table');
      }},
      // 3:40 "notes column" — hover notes column
      { at: 220, fn: async (page) => {
        const el = page.locator('#event-log .notes, .log-entry .notes, .log-entry td:last-child').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 380);
        await page.waitForTimeout(900);
        console.log('    📍 Notes column in log');
      }},
      // 4:05 "connect log to client output" — narration gap
      { at: 245, fn: async (page) => {
        const el = page.locator('#event-log, .event-log').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Connect log to client output');
      }},
      // 4:25 "connect to report" — click Report Generator button
      { at: 265, fn: async (page) => {
        await smoothScroll(page, 300);
        await page.waitForTimeout(400);
        await smoothClick(page, '#ai-report-btn, button:has-text("Report Generator"), button:has-text("Report")', 'Open Report Generator');
        await page.waitForTimeout(3000);
        console.log('    📍 Report Generator opened');
      }},
      // 4:50 "sessions tab variance" — click Sessions tab
      { at: 290, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'sessions\')"]', 'Sessions tab');
        await page.waitForTimeout(800);
        console.log('    📍 Sessions tab — variance table');
      }},
      // 5:10 "colour coding" — hover variance cells, scroll table
      { at: 310, fn: async (page) => {
        const el = page.locator('#cuedeck-report-modal table, .report-modal table').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width * 0.7, box.y + 80);
          await page.waitForTimeout(600);
          await smoothMoveTo(page, box.x + box.width * 0.7, box.y + 140);
          await page.waitForTimeout(600);
        }
        console.log('    📍 Colour coding: green/orange/red');
      }},
      // 5:25 "incidents tab" — click Incidents tab
      { at: 325, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'incidents\')"]', 'Incidents tab');
        await page.waitForTimeout(800);
        console.log('    📍 Incidents tab — incident log');
      }},
      // 5:40 "AI narrative" — click Recommendations tab
      { at: 340, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'recommendations\')"]', 'Recommendations tab');
        await page.waitForTimeout(800);
        console.log('    📍 AI Narrative tab — written debrief');
      }},
      // 5:55 "summary" — click back to Summary tab
      { at: 355, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'summary\')"]', 'Summary tab');
        await page.waitForTimeout(800);
        console.log('    📍 Summary tab — stat cards');
      }},
      // 6:10 "copy text" — click Copy Text button
      { at: 370, fn: async (page) => {
        const btn = page.locator('#cuedeck-report-modal button:has-text("Copy"), .ra-btn:has-text("Copy")').first();
        const box = await btn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(500);
          await btn.click();
          await page.waitForTimeout(800);
        }
        console.log('    📍 Copy Text clicked — clipboard');
      }},
      // 6:25 "Print/PDF" — hover Print button
      { at: 385, fn: async (page) => {
        const btn = page.locator('#cuedeck-report-modal button:has-text("Print"), .ra-btn:has-text("Print")').first();
        const box = await btn.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Print/PDF button');
      }},
      // 6:40 "close report" — close report modal
      { at: 400, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close report');
        await page.waitForTimeout(600);
        await smoothScroll(page, -300);
        console.log('    📍 Report closed');
      }},
      // 7:00 "SQL export" — narration about formal export
      { at: 420, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 SQL export query for CSV');
      }},
      // 7:30 outro — hover role bar
      { at: 435, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Event Log demo complete');
      }},
    ],
  },

  // ── Episode 17: Keyboard Shortcuts & Command Palette ─────────────────────
  // Synchronized to ep17-captions.srt (~492s)
  17: {
    name: 'Keyboard Shortcuts',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "live keynote scenario" — hover session list in director view
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Keyboard shortcuts episode');
      }},
      // 0:22 "stage manager on comms" — hover role bar
      { at: 22, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 200, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 0:42 "full keyboard shortcut system" — hover keyboard hint
      { at: 42, fn: async (page) => {
        const el = page.locator('#help-btn, button[aria-label*="help" i]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Full keyboard shortcut system');
      }},
      // 0:49 "? key opens reference" — press ?
      { at: 49, fn: async (page) => {
        await pressKey(page, 'Shift+/', 'Open keyboard shortcuts (? key)');
      }},
      // 0:62 "left panel navigation" — hover left section of shortcuts modal
      { at: 62, fn: async (page) => {
        const el = page.locator('#shortcuts-modal, .shortcuts-modal, .help-modal').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width * 0.25, box.y + box.height * 0.4);
        else await smoothMoveTo(page, 700, 450);
        await page.waitForTimeout(900);
        console.log('    📍 Navigation shortcuts column');
      }},
      // 0:68 "every shortcut listed" — sweep cursor across shortcuts grid
      { at: 68, fn: async (page) => {
        const el = page.locator('#shortcuts-modal, .shortcuts-modal, .help-modal').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width * 0.6, box.y + box.height * 0.4);
          await page.waitForTimeout(700);
          await smoothMoveTo(page, box.x + box.width * 0.25, box.y + box.height * 0.6);
          await page.waitForTimeout(700);
        }
        console.log('    📍 All shortcuts listed');
      }},
      // 0:83 "/ key search" — close shortcuts, press /
      { at: 83, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close shortcuts');
        await page.waitForTimeout(400);
        await pressKey(page, '/', 'Quick search (/ key)');
      }},
      // 0:95 "B opens broadcast" — close search, press B
      { at: 95, fn: async (page) => {
        await pressKey(page, 'Escape', 'Clear search');
        await page.waitForTimeout(300);
        await pressKey(page, 'b', 'Broadcast bar (B key)');
      }},
      // 1:00 "R sets ready" — close broadcast
      { at: 100, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close broadcast');
        console.log('    📍 R key sets ready');
      }},
      // 1:07 "Escape universal exit" — hover escape key visual
      { at: 107, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Escape = universal exit');
      }},
      // 1:11 "Cmd+K command palette" — press Cmd+K
      { at: 111, fn: async (page) => {
        await pressKey(page, 'Meta+k', 'Command palette (Cmd+K)');
        await page.waitForTimeout(600);
        console.log('    📍 Command palette open');
      }},
      // 1:16 "press / cursor jumps" — close palette, press /
      { at: 116, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close palette');
        await page.waitForTimeout(300);
        await pressKey(page, '/', 'Search (/ key)');
      }},
      // 1:31 "start typing workshop" — type in search bar
      { at: 131, fn: async (page) => {
        const el = page.locator('#fb-search, .filter-search, input[type="search"]').first();
        if (await el.isVisible().catch(() => false)) {
          for (const char of 'Workshop') {
            await page.keyboard.type(char, { delay: 90 + Math.random() * 36 });
            await page.waitForTimeout(50);
          }
        }
        await page.waitForTimeout(600);
        console.log('    📍 Searching for Workshop sessions');
      }},
      // 1:52 "for 30-session event" — narration, show filtered results
      { at: 152, fn: async (page) => {
        const el = page.locator('#fb-search').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Search essential for 30-session events');
      }},
      // 2:05 "press B broadcast bar" — clear search, press B
      { at: 165, fn: async (page) => {
        await page.locator('#fb-search').fill('').catch(() => {});
        await pressKey(page, 'Escape', 'Clear search');
        await page.waitForTimeout(300);
        await pressKey(page, 'b', 'Broadcast bar (B key)');
      }},
      // 2:00 "hit Enter every device" — type and send via Enter
      { at: 180, fn: async (page) => {
        const el = page.locator('#bc-input, .bc-input').first();
        if (await el.isVisible().catch(() => false)) {
          for (const char of 'Please return to your seats') {
            await page.keyboard.type(char, { delay: 90 + Math.random() * 36 });
            await page.waitForTimeout(40);
          }
          await page.waitForTimeout(600);
          // Click Send button instead of just hovering
          await smoothClick(page, 'button[onclick="sendBroadcast()"]', 'Send broadcast');
          await page.waitForTimeout(800);
        }
        console.log('    📍 Broadcast typed and SENT');
      }},
      // 3:20 "character counter" — hover char counter
      { at: 200, fn: async (page) => {
        const el = page.locator('#bc-char').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Character counter');
      }},
      // 3:33 "Escape closes without sending" — press Escape
      { at: 213, fn: async (page) => {
        await pressKey(page, 'Escape', 'Escape — close broadcast without sending');
        console.log('    📍 Escape closes broadcast without sending');
      }},
      // 3:40 "command palette Cmd+K" — open command palette
      { at: 220, fn: async (page) => {
        await pressKey(page, 'Meta+k', 'Command palette (Cmd+K)');
        await page.waitForTimeout(600);
        console.log('    📍 Command palette open');
      }},
      // 4:00 "type keynote sessions" — type in palette
      { at: 240, fn: async (page) => {
        const el = page.locator('#cmd-palette input, .cmd-input, #cp-input').first();
        if (await el.isVisible().catch(() => false)) {
          for (const char of 'keyn') {
            await page.keyboard.type(char, { delay: 90 + Math.random() * 36 });
            await page.waitForTimeout(100);
          }
        }
        await page.waitForTimeout(600);
        console.log('    📍 Fuzzy search: keyn → keynote sessions');
      }},
      // 4:20 "navigate arrows and select" — press arrow keys + Enter to select
      { at: 260, fn: async (page) => {
        await pressKey(page, 'ArrowDown', 'Arrow down in palette');
        await page.waitForTimeout(400);
        await pressKey(page, 'ArrowDown', 'Arrow down again');
        await page.waitForTimeout(400);
        await pressKey(page, 'ArrowUp', 'Arrow up');
        await page.waitForTimeout(400);
        // Select the highlighted result
        await pressKey(page, 'Enter', 'Select result');
        await page.waitForTimeout(800);
        console.log('    📍 Selected result with Enter — session opens');
      }},
      // 4:38 "open palette again, type go live" — Cmd+K, type go live
      { at: 278, fn: async (page) => {
        await pressKey(page, 'Meta+k', 'Reopen Cmd+K');
        await page.waitForTimeout(400);
        const el = page.locator('#cmd-palette input, .cmd-input, #cp-input').first();
        if (await el.isVisible().catch(() => false)) {
          await el.fill('');
          for (const char of 'go live') {
            await page.keyboard.type(char, { delay: 90 + Math.random() * 36 });
            await page.waitForTimeout(80);
          }
        }
        await page.waitForTimeout(600);
        console.log('    📍 Command palette: type go live');
      }},
      // 4:55 "no clicking" — narration gap
      { at: 295, fn: async (page) => {
        const el = page.locator('#cmd-palette, .cmd-palette').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.5);
        await page.waitForTimeout(900);
        console.log('    📍 All keyboard — no clicking needed');
      }},
      // 5:15 "R shortcut" — close palette, press R
      { at: 315, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close palette');
        await page.waitForTimeout(300);
        await clickSession(page, 0);
        await pressKey(page, 'r', 'R — set ready');
        console.log('    📍 R key — SET READY');
      }},
      // 5:25 "you've just ended" — narration gap
      { at: 325, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 70, box.y + 16);
        await page.waitForTimeout(1200);
        console.log('    📍 Session state from keyboard');
      }},
      // 6:00 "realistic keyboard sequence" — narration gap
      { at: 360, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Realistic keyboard sequence');
      }},
      // 6:20 "Cmd+K end session" — open command palette, type end session
      { at: 380, fn: async (page) => {
        await pressKey(page, 'Meta+k', 'Cmd+K');
        await page.waitForTimeout(400);
        const el = page.locator('#cmd-palette input, .cmd-input, #cp-input').first();
        if (await el.isVisible().catch(() => false)) {
          for (const char of 'end') {
            await page.keyboard.type(char, { delay: 90 + Math.random() * 36 });
            await page.waitForTimeout(80);
          }
        }
        await page.waitForTimeout(600);
        console.log('    📍 Cmd+K → end session');
      }},
      // 6:35 "R ready" — close palette, hover R
      { at: 395, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close palette');
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 R → READY');
      }},
      // 6:40 "B broadcast" — press B
      { at: 400, fn: async (page) => {
        await pressKey(page, 'b', 'B → broadcast bar');
        await page.waitForTimeout(600);
        console.log('    📍 B → Broadcast bar');
      }},
      // 7:00 "check schedule /" — close broadcast, press /
      { at: 420, fn: async (page) => {
        await pressKey(page, 'Escape', 'Close broadcast');
        await page.waitForTimeout(300);
        await pressKey(page, '/', 'Check schedule (/ key)');
        await page.waitForTimeout(600);
        await pressKey(page, 'Escape', 'Clear search');
        console.log('    📍 / → search schedule');
      }},
    ],
  },

  // ── Episode 18: Mobile & Tablet ──────────────────────────────────────────
  // Synchronized to ep18-captions.srt (~434s)
  18: {
    name: 'Mobile & Tablet',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:02 setup — reset session[0] to PLANNED + clear speaker_arrived for MARK ARRIVED demo
      { at: 2, fn: async (page) => {
        // Ensure we're in director role with desktop viewport
        await switchRole(page, 'director');
        await page.waitForTimeout(600);
        // Direct DB reset — ALLOWED[LIVE/ENDED] has no REINSTATE/SET READY buttons
        // Use the app's `sb` Supabase client (const in page script scope, accessible via evaluate)
        const resetResult = await page.evaluate(async () => {
          try {
            // Get session IDs from rendered .sc cards — cards have id="card-{uuid}"
            const cards = [...document.querySelectorAll('.sc')];
            let ids = cards.map(c => {
              const cardId = c.getAttribute('id') || '';
              return cardId.startsWith('card-') ? cardId.slice(5) : null;
            }).filter(id => id && id.length === 36);
            if (ids.length === 0) {
              // Fallback: query first 2 sessions from DB
              const { data } = await sb.from('leod_sessions').select('id').order('seq').limit(2);
              if (data) ids = data.map(r => r.id).filter(id => typeof id === 'string' && id.length === 36);
            }
            if (ids.length === 0) return 'no session IDs found';
            const targetId = ids[0];
            const { error } = await sb.from('leod_sessions')
              .update({ status: 'PLANNED', speaker_arrived: false, speaker: 'Dr Sarah Chen' })
              .eq('id', targetId);
            if (error) return `error: ${error.message}`;
            if (typeof loadSnapshot === 'function' && S.event) await loadSnapshot(S.event.id);
            return `reset to PLANNED (speaker_arrived=false): ${targetId.slice(0, 8)}`;
          } catch (e) { return `exception: ${e?.message || String(e)}`; }
        });
        await page.waitForTimeout(2000); // wait for loadSnapshot + realtime propagation
        console.log(`    📍 Session DB reset: ${resetResult}`);
        console.log('    📍 Session[0] reset to PLANNED / speaker_arrived=false for MARK ARRIVED demo');
      }},
      // 0:05 "tablet question" — hover role bar in desktop view
      { at: 5, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Mobile & Tablet episode — desktop view');
      }},
      // 0:25 "yes it works" — narration
      { at: 25, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Yes — works on tablet');
      }},
      // 0:39 "show responsive" — narration gap
      { at: 39, fn: async (page) => {
        await smoothMoveTo(page, 960, 540);
        await page.waitForTimeout(900);
        console.log('    📍 About to show responsive layouts');
      }},
      // 0:50 "iPad portrait" — switch to iPad portrait viewport
      { at: 50, fn: async (page) => {
        await page.setViewportSize({ width: 768, height: 1024 });
        await page.waitForTimeout(800);
        console.log('    📍 iPad portrait — 768×1024');
      }},
      // 1:08 "role bar wrapped two lines" — hover role bar
      { at: 68, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Role bar wrapped to two lines');
      }},
      // 1:15 "session list full width" — hover session list
      { at: 75, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 Session list full width');
      }},
      // 1:20 "context panel slides up from bottom" — tap first session
      { at: 80, fn: async (page) => {
        await clickSession(page, 0);
        await page.waitForTimeout(800);
        console.log('    📍 Context panel slides up from bottom (tablet)');
      }},
      // 1:35 "tap-first interaction" — hover session card
      { at: 95, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Tap-first interaction model');
      }},
      // 2:00 "stage manager setup" — switch to stage role
      { at: 120, fn: async (page) => {
        await switchRole(page, 'stage');
        console.log('    📍 Stage manager on iPad');
      }},
      // 2:15 "stage role iPad on stand" — hover stage session list
      { at: 135, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Stage role — iPad on stand portrait');
      }},
      // 2:35 "filter by room only sessions" — hover filter bar
      { at: 155, fn: async (page) => {
        const el = page.locator('#filter-bar, .filter-bar').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Filter by room — stage manager sees only their sessions');
      }},
      // 2:45 "tap session speaker arrived" — tap session, tap arrived
      { at: 165, fn: async (page) => {
        // Switch to director role to ensure MARK ARRIVED button is accessible
        // (stage role may not have write access for markArrived)
        await switchRole(page, 'director');
        await page.waitForTimeout(400);
        await clickSession(page, 0);
        await page.waitForTimeout(800);
        // Try clickBtn first; if button not in viewport, fall back to direct JS click
        const clicked = await clickBtn(page, 'MARK ARRIVED');
        if (!clicked) {
          const directClicked = await page.evaluate(() => {
            const btn = [...document.querySelectorAll('.abtn, .ctx-btn')]
              .find(b => b.textContent.trim() === 'MARK ARRIVED' && !b.disabled);
            if (btn) { btn.click(); return true; }
            return false;
          });
          if (directClicked) console.log('    🖱 MARK ARRIVED (direct JS)');
        }
        console.log('    📍 Tap → MARK ARRIVED');
      }},
      // 3:00 "go live one tap" — tap GO LIVE
      { at: 180, fn: async (page) => {
        await clickCardBtn(page, 'SET READY');
        await page.waitForTimeout(600);
        console.log('    📍 One tap to go READY');
      }},
      // 3:20 "state machine same rules" — narration gap
      { at: 200, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Same state machine rules on tablet');
      }},
      // 3:35 "phone registration desk" — switch to phone viewport + reg role
      { at: 215, fn: async (page) => {
        await page.setViewportSize({ width: 375, height: 812 });
        await page.waitForTimeout(600);
        await switchRole(page, 'reg');
        console.log('    📍 Phone — 375×812 — Registration role');
      }},
      // 4:00 "registration role simplest view" — hover session list on phone
      { at: 240, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Registration role — simplest view');
      }},
      // 4:25 "on phone stacks cleanly" — scroll phone view
      { at: 265, fn: async (page) => {
        await smoothScroll(page, 300);
        await page.waitForTimeout(800);
        await smoothScroll(page, -300);
        console.log('    📍 Phone view stacks cleanly');
      }},
      // 4:45 "keeps it open all day" — narration gap
      { at: 285, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Keeps it open all day — auto-updates');
      }},
      // 5:00 "directors tablet second monitor" — switch to tablet landscape
      { at: 300, fn: async (page) => {
        await page.setViewportSize({ width: 1024, height: 768 });
        await switchRole(page, 'director');
        console.log('    📍 Director — tablet landscape as second monitor');
      }},
      // 5:25 "some directors signage panel on iPad" — hover signage area
      { at: 325, fn: async (page) => {
        await switchRole(page, 'signage');
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 Signage panel on tablet — monitor venue screens');
      }},
      // 5:50 "practical tips" — switch back to desktop, director
      { at: 350, fn: async (page) => {
        await page.setViewportSize({ width: 1920, height: 1080 });
        await switchRole(page, 'director');
        console.log('    📍 Back to desktop — practical tips');
      }},
      // 6:18 "iOS add to home screen" — narration gap
      { at: 378, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 iOS Add to Home Screen tip');
      }},
      // 6:35 "keep screen on" — narration gap
      { at: 395, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Keep screen on during event');
      }},
      // 6:55 "internet connectivity" — narration gap
      { at: 415, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Internet connectivity — requires active connection');
      }},
    ],
  },

  // ── Episode 19: Plans & Billing ──────────────────────────────────────────
  // Synchronized to ep19-captions.srt (~388s)
  19: {
    name: 'Plans & Billing',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "free pro enterprise" — director view, hover name chip
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        const el = page.locator('#profile-chip, .profile-chip, .user-chip').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Plans & Billing episode');
      }},
      // 0:13 "per-event credit" — hover session list to show app context
      { at: 13, fn: async (page) => {
        await clickSession(page, 0);
        await page.waitForTimeout(600);
        console.log('    📍 Four options: Free, Pro, Enterprise, Per-Event');
      }},
      // 0:24 "three plans" — hover role bar to show the app
      { at: 24, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
      }},
      // 0:36 "free plan" — hover session list showing limited features
      { at: 36, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Free plan: 1 event, 5 operators, 2 displays');
      }},
      // 0:48 "pro plan" — hover AI agents panel (locked on free)
      { at: 48, fn: async (page) => {
        await smoothScroll(page, 300);
        await page.waitForTimeout(600);
        const el = page.locator('.ai-agents-panel, #agents-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Pro €79/month — unlocks AI agents');
      }},
      // 1:11 "enterprise" — scroll back up
      { at: 71, fn: async (page) => {
        await smoothScroll(page, -300);
        await page.waitForTimeout(600);
        console.log('    📍 Enterprise — custom pricing, SLA');
      }},
      // 1:22 "per-event credit" — hover sessions
      { at: 82, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Per-event credit — single event unlock');
      }},
      // 1:40 "current plan one click away" — hover profile chip
      { at: 100, fn: async (page) => {
        const el = page.locator('#profile-chip, .profile-chip, .user-chip').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Profile chip — one click away');
      }},
      // 1:48 "click name chip" — click profile chip to open panel
      { at: 108, fn: async (page) => {
        await smoothClick(page, '#profile-chip, .profile-chip, .user-chip', 'Open profile panel');
        await page.waitForTimeout(800);
        console.log('    📍 Profile panel open');
      }},
      // 1:58 "plan badge" — hover plan badge
      { at: 118, fn: async (page) => {
        const el = page.locator('.plan-badge, #plan-badge, .profile-plan').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 300, 200);
        await page.waitForTimeout(900);
        console.log('    📍 Plan badge — FREE');
      }},
      // 2:15 "usage bars" — hover usage bars
      { at: 135, fn: async (page) => {
        const el = page.locator('.usage-bar, .plan-usage, .progress-bar').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 300, 280);
        await page.waitForTimeout(900);
        console.log('    📍 Usage bars — events / operators / displays');
      }},
      // 2:35 "billing button" — click Billing button (shows Stripe UI)
      { at: 155, fn: async (page) => {
        const btn = page.locator('button:has-text("Billing"), button:has-text("Upgrade"), #billing-btn').first();
        const box = await btn.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
          await btn.click();
          await page.waitForTimeout(1200);
        }
        console.log('    📍 Billing button clicked — Stripe checkout opens');
      }},
      // 3:05 "checkout plan options" — hover profile panel (Stripe may have opened in new tab)
      { at: 185, fn: async (page) => {
        const el = page.locator('.profile-panel, #profile-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.5);
        await page.waitForTimeout(900);
        console.log('    📍 Plan selection — Pro or Per-Event');
      }},
      // 3:20 "upgrade applies immediately" — scroll down in profile panel
      { at: 200, fn: async (page) => {
        const el = page.locator('.profile-panel, #profile-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.4);
          await page.waitForTimeout(400);
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.7);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Upgrade applies immediately — no page refresh');
      }},
      // 3:50 "VAT invoicing" — hover lower part of profile panel
      { at: 230, fn: async (page) => {
        const el = page.locator('.profile-panel, #profile-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.6);
        await page.waitForTimeout(900);
        console.log('    📍 VAT invoicing for European businesses');
      }},
      // 4:05 "manage subscription" — hover Manage Subscription link
      { at: 245, fn: async (page) => {
        const el = page.locator('a:has-text("Manage Subscription"), button:has-text("Manage"), .manage-sub').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
        }
        console.log('    📍 Manage Subscription — Stripe customer portal');
      }},
      // 4:45 "invoice history" — scroll in profile panel
      { at: 285, fn: async (page) => {
        const el = page.locator('.profile-panel, #profile-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height * 0.8);
        await page.waitForTimeout(900);
        console.log('    📍 Invoice history for billing');
      }},
      // 5:05 "practical decision tree" — close profile panel
      { at: 305, fn: async (page) => {
        await smoothClick(page, '#profile-chip, .profile-chip, .user-chip', 'Close profile panel');
        await page.waitForTimeout(600);
        console.log('    📍 Decision tree: Free → evaluate → Pro');
      }},
      // 5:25 "enterprise" — click a session to show main console
      { at: 325, fn: async (page) => {
        await clickSession(page, 0);
        await page.waitForTimeout(600);
        console.log('    📍 Enterprise — contact for custom pricing');
      }},
      // 5:55 "pricing pays for itself" — hover session card
      { at: 355, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Pricing pays for itself');
      }},
    ],
  },

  // ── Episode 20: Multi-Room Events ────────────────────────────────────────
  // Synchronized to ep20-captions.srt (~512s)
  20: {
    name: 'Multi-Room Events',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "you've seen single room" — hover session list
      { at: 5, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Multi-Room Events episode');
      }},
      // 0:14 "now scale up three-track" — hover session cards
      { at: 14, fn: async (page) => {
        const el = page.locator('.sc').nth(1);
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Three-track conference');
      }},
      // 0:30 "room field free-text" — click first session, hover room field in ctx panel
      { at: 30, fn: async (page) => {
        await clickSession(page, 0);
        const el = page.locator('#ctx-panel .room, #ctx-room, .smv-room').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const ctx = page.locator('#ctx-panel').first();
          const cBox = await ctx.boundingBox().catch(() => null);
          if (cBox) await smoothMoveTo(page, cBox.x + cBox.width / 2, cBox.y + 100);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Room field — free-text input');
      }},
      // 0:53 "consistent names" — hover session cards with room labels
      { at: 53, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Consistent room names: Main Stage, Workshop A, Workshop B');
      }},
      // 1:08 "filter bar generates chips" — hover filter bar room chips
      { at: 68, fn: async (page) => {
        const el = page.locator('#filter-bar, .filter-bar').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Filter bar generates room chips automatically');
      }},
      // 1:27 "three room chips" — hover room filter select, cycle through options
      { at: 87, fn: async (page) => {
        const sel = page.locator('#fb-room').first();
        const box = await sel.boundingBox().catch(() => null);
        if (box) {
          await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
          await page.waitForTimeout(600);
          // Briefly select each room to visually show the options
          await sel.selectOption({ index: 1 }).catch(() => {});
          await page.waitForTimeout(400);
          await sel.selectOption({ index: 2 }).catch(() => {});
          await page.waitForTimeout(400);
          await sel.selectOption({ index: 0 }).catch(() => {}); // reset to All Rooms
          await page.waitForTimeout(400);
        }
        console.log('    📍 Three room options visible in filter bar');
      }},
      // 1:33 "click one to isolate" — select first room in dropdown
      { at: 93, fn: async (page) => {
        const sel = page.locator('#fb-room').first();
        const box = await sel.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        await page.locator('#fb-room').selectOption({ index: 1 }).catch(() => {});
        await page.waitForTimeout(600);
        console.log('    📍 Room filter selected — isolates that room');
      }},
      // 1:45 "click Workshop A sessions only" — narration gap
      { at: 105, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Only Workshop A sessions visible');
      }},
      // 1:55 "primary tool multi-room" — scroll to show filtered list
      { at: 115, fn: async (page) => {
        await smoothScroll(page, 250);
        await page.waitForTimeout(1000);
        await smoothScroll(page, -250);
        console.log('    📍 Primary tool for multi-room events');
      }},
      // 2:10 "filter + status + search" — hover status filter
      { at: 130, fn: async (page) => {
        const el = page.locator('#fb-status, select[id*="status"]').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const fb = page.locator('#filter-bar').first();
          const fbBox = await fb.boundingBox().catch(() => null);
          if (fbBox) await smoothMoveTo(page, fbBox.x + fbBox.width * 0.7, fbBox.y + fbBox.height / 2);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Combine: room filter + status filter + search');
      }},
      // 2:35 "click another room chip to switch" — select second room in dropdown
      { at: 155, fn: async (page) => {
        const sel = page.locator('#fb-room').first();
        const box = await sel.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        const optCount = await page.locator('#fb-room option').count().catch(() => 0);
        await page.locator('#fb-room').selectOption({ index: optCount > 2 ? 2 : 1 }).catch(() => {});
        await page.waitForTimeout(600);
        console.log('    📍 Switch to another room in filter dropdown');
      }},
      // 2:55 "structure team by room" — narration gap
      { at: 175, fn: async (page) => {
        const el = page.locator('#role-bar');
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Structure team by room');
      }},
      // 3:15 "director full view three rooms" — reset room filter to All Rooms
      { at: 195, fn: async (page) => {
        const sel = page.locator('#fb-room').first();
        const box = await sel.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        await page.locator('#fb-room').selectOption({ index: 0 }).catch(() => {});
        await page.waitForTimeout(600);
        const el = page.locator('#sessions-list').first();
        const elBox = await el.boundingBox().catch(() => null);
        if (elBox) await smoothMoveTo(page, elBox.x + elBox.width / 2, elBox.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Director: full view, all three rooms');
      }},
      // 3:35 "stage manager one room" — filter to first room via dropdown
      { at: 215, fn: async (page) => {
        const sel = page.locator('#fb-room').first();
        const box = await sel.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(300);
        await page.locator('#fb-room').selectOption({ index: 1 }).catch(() => {});
        await page.waitForTimeout(600);
        console.log('    📍 Stage manager: filter to their room');
      }},
      // 4:00 "broadcast cross-room cascade" — narration gap
      { at: 240, fn: async (page) => {
        const el = page.locator('#filter-bar').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Director broadcasts cross-room, handles delay cascades');
      }},
      // 4:25 "anchor sessions" — narration gap, hover session with anchor
      { at: 265, fn: async (page) => {
        // Reset room filter to All Rooms first
        await page.locator('#fb-room').selectOption({ index: 0 }).catch(() => {});
        await page.waitForTimeout(400);
        await smoothScroll(page, 200);
        await page.waitForTimeout(900);
        console.log('    📍 Anchor sessions — stop cascade at plenary moments');
      }},
      // 4:40 "anchor plenary moments" — hover anchor card
      { at: 280, fn: async (page) => {
        const el = page.locator('.sc[data-anchor], .sc .anchor-badge').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else {
          const sc = page.locator('.sc').nth(3);
          const scBox = await sc.boundingBox().catch(() => null);
          if (scBox) await smoothMoveTo(page, scBox.x + scBox.width / 2, scBox.y + scBox.height / 2);
        }
        await page.waitForTimeout(900);
        console.log('    📍 Anchor: lunch, networking, closing keynote');
      }},
      // 4:55 "apply delay Workshop B" — scroll back, click session, apply delay
      { at: 295, fn: async (page) => {
        await smoothScroll(page, -200);
        await clickSession(page, 0);
        await smoothClick(page, 'button[onclick*="applyDelay"][onclick*=",5)"]', 'Apply +5m delay');
        console.log('    📍 Apply 5-minute delay to Workshop B session');
      }},
      // 5:15 "but stops at next anchor" — scroll to show cascade stopping
      { at: 315, fn: async (page) => {
        await smoothScroll(page, 300);
        await page.waitForTimeout(1500);
        console.log('    📍 Cascade stops at anchor session');
      }},
      // 5:30 "apply five-minute delay" narration — scroll back
      { at: 330, fn: async (page) => {
        await smoothScroll(page, -300);
        await page.waitForTimeout(600);
      }},
      // 6:00 "look what happens" — apply second delay and scroll
      { at: 360, fn: async (page) => {
        await smoothClick(page, 'button[onclick*="applyDelay"][onclick*=",5)"]', 'Apply +5m again');
        await smoothScroll(page, 300);
        await page.waitForTimeout(1500);
        console.log('    📍 Downstream sessions shift, anchor holds');
      }},
      // 6:35 "practical sessions not shift" — hover anchor card
      { at: 395, fn: async (page) => {
        const sc = page.locator('.sc').nth(3);
        const box = await sc.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        await smoothScroll(page, -300);
        console.log('    📍 Anchor holds — non-anchor sessions compress');
      }},
      // 7:10 "Programme display master view" — switch to signage, open programme display
      { at: 430, fn: async (page) => {
        await switchRole(page, 'signage');
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Programme display — master view for multi-track');
      }},
      // 7:35 "put it on large screen" — narration gap
      { at: 455, fn: async (page) => {
        const el = page.locator('.sp-panel, #signage-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 60);
        await page.waitForTimeout(900);
        console.log('    📍 Put on large screen in lobby/registration');
      }},
      // 8:00 "as sessions go live update" — narration gap
      { at: 480, fn: async (page) => {
        const el = page.locator('.sp-display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        console.log('    📍 Programme updates real-time as sessions go live');
      }},
    ],
  },

  // ── Episode 21: Full End-to-End Walkthrough ──────────────────────────────
  // Synchronized to ep21-captions.srt (~647s)
  21: {
    name: 'Full Walkthrough',
    doLogin: false,
    hideGuides: true,
    cues: [
      // 0:05 "eight forty-five morning" — hover session list
      { at: 5, fn: async (page) => {
        await switchRole(page, 'director');
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Full Walkthrough episode — 8:45am');
      }},
      // 0:13 "ten sessions two rooms" — scroll to show all sessions
      { at: 13, fn: async (page) => {
        await smoothScroll(page, 400);
        await page.waitForTimeout(1200);
        await smoothScroll(page, -400);
        console.log('    📍 Ten sessions across two rooms');
      }},
      // 0:22 "this is full event run" — narration gap, hover console
      { at: 22, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Full event run — Tech Summit 2026');
      }},
      // 0:35 "programme check" — scroll through all sessions
      { at: 35, fn: async (page) => {
        await smoothScroll(page, 500);
        await page.waitForTimeout(1500);
        await smoothScroll(page, -500);
        console.log('    📍 Programme check — all sessions in place');
      }},
      // 0:52 "ten sessions" — hover first session
      { at: 52, fn: async (page) => {
        await clickSession(page, 0);
        console.log('    📍 Ten sessions confirmed');
      }},
      // 1:06 "anchor sessions in place" — scroll to anchor session
      { at: 66, fn: async (page) => {
        await smoothScroll(page, 300);
        await page.waitForTimeout(1200);
        const el = page.locator('.sc[data-anchor], .sc .anchor-badge').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(900);
        await smoothScroll(page, -300);
        console.log('    📍 Anchor sessions in place');
      }},
      // 1:35 "displays running" — switch to signage
      { at: 95, fn: async (page) => {
        await switchRole(page, 'signage');
        const el = page.locator('.sp-display-card, .display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Displays running — lobby and stage screens');
      }},
      // 1:58 "Emma stage manager online" — switch to stage role briefly
      { at: 118, fn: async (page) => {
        await switchRole(page, 'stage');
        await page.waitForTimeout(1000);
        await switchRole(page, 'director');
        console.log('    📍 Stage manager Emma online');
      }},
      // 2:25 "programme confirmed" — hover all sessions
      { at: 145, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Programme confirmed — ready to run');
      }},
      // 2:43 "registration goes READY" — SET READY on first session
      { at: 163, fn: async (page) => {
        await clickSession(page, 0);
        await clickCardBtn(page, 'SET READY');
        console.log('    📍 Session 1 → READY (Registration/Welcome)');
      }},
      // 3:01 "nine oh-one doors open" — narration gap
      { at: 181, fn: async (page) => {
        const el = page.locator('.sc').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + 70, box.y + 16);
        await page.waitForTimeout(900);
        console.log('    📍 9:01 — Doors open');
      }},
      // 3:14 "session 1 LIVE" — CALL SPEAKER then CONFIRM ON STAGE
      { at: 194, fn: async (page) => {
        await clickCtxBtn(page, 'CALL SPEAKER');
        await page.waitForTimeout(800);
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
        console.log('    📍 Session 1 LIVE — Opening Registration');
      }},
      // 3:40 "session 2 READY" — hover second session, SET READY
      { at: 220, fn: async (page) => {
        await clickSession(page, 1);
        await clickCardBtn(page, 'SET READY');
        console.log('    📍 Session 2 → READY');
      }},
      // 3:58 "call speaker CALLING" — CALL SPEAKER on session 2
      { at: 238, fn: async (page) => {
        await clickCtxBtn(page, 'CALL SPEAKER');
        console.log('    📍 Session 2 → CALLING');
      }},
      // 4:30 "broadcast sent" — END session 1, open broadcast bar
      { at: 270, fn: async (page) => {
        await clickSession(page, 0);
        await clickCtxBtn(page, 'END SESSION');
        await page.waitForTimeout(600);
        await pressKey(page, 'b', 'Broadcast bar');
        const el = page.locator('#bc-input, .bc-input').first();
        if (await el.isVisible().catch(() => false)) {
          for (const char of 'Opening keynote starting now — Main Stage') {
            await page.keyboard.type(char, { delay: 55 + Math.random() * 22 });
            await page.waitForTimeout(30);
          }
          const sendBtn = page.locator('button[onclick="sendBroadcast()"]').first();
          const box = await sendBtn.boundingBox().catch(() => null);
          if (box) {
            await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
            await page.waitForTimeout(600);
            await smoothClick(page, 'button[onclick="sendBroadcast()"]', 'Send broadcast');
          }
        }
        console.log('    📍 Broadcast: Opening keynote starting now');
      }},
      // 4:40 "nine thirty-two LIVE" — session 2 → CONFIRM ON STAGE
      { at: 280, fn: async (page) => {
        await clickSession(page, 1);
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
        console.log('    📍 9:32 — Session 2 LIVE — Opening Keynote');
      }},
      // 5:00 "cue engine fires" — hover AI agents panel
      { at: 300, fn: async (page) => {
        const el = page.locator('.ai-agents-panel, #agents-panel').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 40);
        else await smoothMoveTo(page, 1700, 400);
        await page.waitForTimeout(900);
        console.log('    📍 Cue Engine fires 8 min before next session');
      }},
      // 5:15 "Sarah running a minute long nudge" — apply +1m delay
      { at: 315, fn: async (page) => {
        await smoothClick(page, '.abtn:has-text("+1m")', 'Nudge +1m');
        await page.waitForTimeout(800);
        console.log('    📍 Sarah running 1 min over — nudge applied');
      }},
      // 5:55 "keynote ENDED" — END SESSION on keynote
      { at: 355, fn: async (page) => {
        await clickCtxBtn(page, 'END SESSION');
        console.log('    📍 Opening Keynote ENDED');
      }},
      // 6:20 "session 3 READY Workshop B READY" — SET READY on sessions 2 and 3
      { at: 380, fn: async (page) => {
        await clickSession(page, 2);
        await clickCardBtn(page, 'SET READY');
        await page.waitForTimeout(600);
        await clickSession(page, 3);
        await clickCardBtn(page, 'SET READY');
        console.log('    📍 Session 3 (Main Stage) + Workshop B session → READY');
      }},
      // 6:55 "session 3 LIVE" — CALL SPEAKER then LIVE on session 3
      { at: 415, fn: async (page) => {
        await clickSession(page, 2);
        await clickCtxBtn(page, 'CALL SPEAKER');
        await page.waitForTimeout(600);
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
        console.log('    📍 Session 3 LIVE — Main Stage panel');
      }},
      // 7:10 "both tracks running" — click Workshop B session, go live
      { at: 430, fn: async (page) => {
        await clickSession(page, 3);
        await clickCtxBtn(page, 'CALL SPEAKER');
        await page.waitForTimeout(600);
        await clickCtxBtn(page, 'CONFIRM ON STAGE');
        console.log('    📍 Both tracks running simultaneously');
      }},
      // 7:35 "programme signage showing both" — switch to signage
      { at: 455, fn: async (page) => {
        await switchRole(page, 'signage');
        const el = page.locator('.sp-display-card').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        await page.waitForTimeout(1200);
        console.log('    📍 Programme signage — both tracks visible');
      }},
      // 8:00 "Workshop B OVERRUN" — switch to director, trigger OVERRUN via DB
      { at: 480, fn: async (page) => {
        await switchRole(page, 'director');
        await clickSession(page, 3);
        // OVERRUN has no manual button — trigger via DB update
        await page.evaluate(async () => {
          const cards = [...document.querySelectorAll('.sc')];
          const ids = cards.map(c => (c.id || '').startsWith('card-') ? c.id.slice(5) : null).filter(x => x?.length === 36);
          const targetId = ids[3] || ids[ids.length - 1]; // 4th session (Workshop B)
          if (targetId) {
            await sb.from('leod_sessions').update({ status: 'OVERRUN' }).eq('id', targetId);
            if (typeof loadSnapshot === 'function' && S.event) await loadSnapshot(S.event.id);
          }
        });
        await page.waitForTimeout(800);
        console.log('    📍 Workshop B session → OVERRUN');
      }},
      // 8:30 "apply delay cascade" — apply +5m delay
      { at: 510, fn: async (page) => {
        await smoothClick(page, 'button[onclick*="applyDelay"][onclick*=",5)"]', 'Apply +5m delay');
        await smoothScroll(page, 300);
        await page.waitForTimeout(1200);
        await smoothScroll(page, -300);
        console.log('    📍 Delay cascade applied — downstream Workshop B sessions shift');
      }},
      // 8:55 "broadcasting" — open broadcast bar, send update
      { at: 535, fn: async (page) => {
        await pressKey(page, 'b', 'Broadcast bar');
        const el = page.locator('#bc-input').first();
        if (await el.isVisible().catch(() => false)) {
          for (const char of 'Workshop B sessions running 5 min late') {
            await page.keyboard.type(char, { delay: 55 + Math.random() * 22 });
            await page.waitForTimeout(30);
          }
          await smoothClick(page, 'button[onclick="sendBroadcast()"]', 'Send delay broadcast');
        }
        console.log('    📍 Broadcasting: Workshop B running 5 min late');
      }},
      // 9:15 "afternoon runs cleanly" — narration gap
      { at: 555, fn: async (page) => {
        const el = page.locator('#sessions-list').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + 80);
        await page.waitForTimeout(900);
        console.log('    📍 Afternoon programme runs cleanly');
      }},
      // 9:35 "all sessions ENDED" — scroll to show all ended sessions
      { at: 575, fn: async (page) => {
        await smoothScroll(page, 400);
        await page.waitForTimeout(1200);
        await smoothScroll(page, -400);
        console.log('    📍 All sessions ENDED — event complete');
      }},
      // 10:00 "generate report" — click Report Generator
      { at: 600, fn: async (page) => {
        await smoothClick(page, '#ai-report-btn, button:has-text("Report Generator"), button:has-text("Report")', 'Open Report Generator');
        await page.waitForTimeout(3000);
        console.log('    📍 Report Generator — generating post-event report');
      }},
      // 10:25 "summary tab" — hover summary tab
      { at: 625, fn: async (page) => {
        const el = page.locator('#ra-tabs .ra-tab, #cuedeck-report-modal .ra-tab').first();
        const box = await el.boundingBox().catch(() => null);
        if (box) await smoothMoveTo(page, box.x + box.width / 2, box.y + box.height / 2);
        else await smoothMoveTo(page, 960, 350);
        await page.waitForTimeout(900);
        console.log('    📍 Summary tab — stat cards');
      }},
      // 10:35 "sessions tab" — click sessions tab
      { at: 635, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'sessions\')"]', 'Sessions tab');
        await page.waitForTimeout(600);
        console.log('    📍 Sessions tab — variance table');
      }},
      // 10:45 "recommendations" — click AI/narrative tab
      { at: 645, fn: async (page) => {
        await smoothClick(page, 'div[onclick*="switchTab(\'recommendations\')"]', 'Recommendations tab');
        await page.waitForTimeout(600);
        console.log('    📍 Recommendations — full event narrative');
      }},
    ],
  },
};

// ─── Main Recording Loop ────────────────────────────────────────────────────
async function recordEpisode(epNum) {
  const pad = String(epNum).padStart(2, '0');
  const ep = EPISODES[epNum];
  if (!ep) {
    console.error(`No cues defined for episode ${epNum}`);
    process.exit(1);
  }

  const { totalDuration } = parseSRT(epNum);
  const outFile = resolve(OUT_DIR, `ep${pad}-raw.webm`);

  console.log(`\n📹 Recording Episode ${pad}: ${ep.name}`);
  console.log(`   Duration: ${Math.round(totalDuration)}s (~${(totalDuration / 60).toFixed(1)} min)`);
  console.log(`   Output:   ${outFile}\n`);

  // Run pre-recording cleanup if requested (deletes DB state for a clean slate)
  if (ep.preCleanup) {
    await cleanupForEp02();
  }

  // Browser launch
  // showLogin:true = episode needs a fresh browser (no storageState) so the login form appears.
  // Otherwise use saved auth-state for ep02+ so login is skipped.
  const hasAuth = !ep.showLogin && epNum > 1 && existsSync(AUTH_STATE);
  const launchOpts = { headless: true };
  const contextOpts = {
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: OUT_DIR, size: { width: 1920, height: 1080 } },
    ...(hasAuth ? { storageState: AUTH_STATE } : {}),
  };

  const browser = await chromium.launch(launchOpts);
  const context = await browser.newContext(contextOpts);
  const page = await context.newPage();

  const startTime = Date.now();

  try {
    // Load console with appropriate options
    await loadConsole(page, {
      doLogin: ep.doLogin || false,
      hideGuides: ep.hideGuides !== false,
      showLogin: ep.showLogin || false,
    });

    // Save auth state after ep01 login
    if (epNum === 1) {
      await context.storageState({ path: AUTH_STATE });
      console.log('    💾 Auth state saved for future episodes');
    }

    // Execute cues in chronological order
    const sortedCues = [...ep.cues].sort((a, b) => a.at - b.at);
    for (const cue of sortedCues) {
      await waitUntilSec(page, startTime, cue.at);
      try {
        await cue.fn(page, context);
      } catch (err) {
        console.error(`    ⚠ Cue at ${cue.at}s failed: ${err.message}`);
      }
    }

    // Wait for remaining recording time — use effective duration that accounts for late cues
    const lastCueSec = sortedCues.length > 0 ? sortedCues[sortedCues.length - 1].at : 0;
    const effectiveDuration = Math.max(totalDuration, lastCueSec + 8);
    console.log(`    ⏳ Waiting for remaining ${Math.round(effectiveDuration - (Date.now() - startTime) / 1000)}s (effective: ${Math.round(effectiveDuration)}s)...`);
    await waitUntilSec(page, startTime, effectiveDuration);
  } catch (err) {
    console.error(`  ⚠ Recording error: ${err.message}`);
  }

  // Safety cap: force-close if recording ran too long
  const elapsedBeforeClose = (Date.now() - startTime) / 1000;
  const lastCueSecFinal = [...(EPISODES[epNum]?.cues || [])].sort((a, b) => b.at - a.at)[0]?.at || 0;
  const safetyCap = Math.max(totalDuration, lastCueSecFinal + 8) + 30;
  if (elapsedBeforeClose > safetyCap) {
    console.warn(`  ⚠ Recording exceeded safety cap (${Math.round(safetyCap)}s). Force-closing.`);
  }

  // Close page and save video with encoding timeout
  await page.close();
  const video = page.video();
  if (video) {
    try {
      const videoPromise = video.path();
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Video encoding timeout (60s)')), 60000)
      );
      const videoPath = await Promise.race([videoPromise, timeoutPromise]);
      renameSync(videoPath, outFile);
      console.log(`\n  ✓ Recording saved: ${outFile}`);
    } catch (encErr) {
      console.error(`  ⚠ Video save failed: ${encErr.message}`);
    }
  }

  await context.close();
  await browser.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`  ⏱ Total recording time: ${elapsed}s`);
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────
async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const args = process.argv.slice(2);

  if (args.includes('--all')) {
    // Record all 21 episodes in order
    console.log('Recording all 21 episodes...\n');
    for (let i = 1; i <= 21; i++) {
      await recordEpisode(i);
    }
    console.log('\n✓ All episodes recorded!');
  } else {
    const epNum = parseInt(args[0]);
    if (!epNum || epNum < 1 || epNum > 21) {
      console.error('Usage: node record-demo.mjs <episode-number>');
      console.error('       node record-demo.mjs --all');
      process.exit(1);
    }
    await recordEpisode(epNum);
  }

  console.log('Done!');
}

main().catch((err) => {
  console.error('Recording failed:', err.message);
  process.exit(1);
});
