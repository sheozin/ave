#!/usr/bin/env node
/**
 * CueDeck Per-Episode Title Card Generator
 * Creates branded 4-second title cards with episode number and title.
 *
 * Usage:
 *   node scripts/youtube-pipeline/generate-title-cards.mjs           # all episodes
 *   node scripts/youtube-pipeline/generate-title-cards.mjs 3         # episode 3 only
 *   node scripts/youtube-pipeline/generate-title-cards.mjs 3 --preview  # just screenshot, no video
 */

import { chromium } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BRAND_DIR = resolve(ROOT, 'youtube-branding');
const TITLE_DIR = resolve(BRAND_DIR, 'title-cards');
const LOGO_PATH = resolve(ROOT, 'cuedeck-marketing/public/brand/logo-mark-400-transparent.png');

let logoBase64 = '';
if (existsSync(LOGO_PATH)) {
  logoBase64 = `data:image/png;base64,${readFileSync(LOGO_PATH).toString('base64')}`;
}

// All 21 episode titles
const EPISODES = {
  1:  'The Production Console for Live Events',
  2:  'Create Your First Event & Add Sessions',
  3:  'Running a Live Event: The Full Session State Machine',
  4:  'Roles & Team Invites: Right Access for Every Person',
  5:  'Broadcast Bar: Send Messages to Your Entire Crew',
  6:  'Delay Cascade: Handle Overruns Without Losing Your Programme',
  7:  'Digital Signage: Set Up Your First Display in 5 Minutes',
  8:  'All 11 Signage Display Modes Explained',
  9:  'Stage Confidence Monitor: Never Lose Track of What\'s Live',
  10: 'Stage Timer: A Speaker-Facing Countdown That Runs Itself',
  11: 'AI Incident Advisor: Your Crisis Co-Pilot',
  12: 'AI Cue Engine: Automatic Pre-Session Checklists',
  13: 'AI Post-Event Report: From Raw Data to Polished Debrief',
  14: 'Timeline & Programme Displays: Attendee-Facing Screens',
  15: 'Sponsor Logos: Rotating Branding on Your Venue Screens',
  16: 'Event Log & Post-Event Report: Full Accountability',
  17: 'Keyboard Shortcuts & Command Palette: Power User Mode',
  18: 'Mobile & Tablet: Run Your Event from Any Device',
  19: 'Plans & Billing: Free, Pro, Per-Event & Enterprise',
  20: 'Multi-Room Events: Running a 3-Track Conference',
  21: 'Full Event Walkthrough: From Blank Screen to Post-Event Report',
};

function titleCardHTML(epNum, title) {
  const pad = String(epNum).padStart(2, '0');
  return `<!DOCTYPE html>
<html>
<head>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1920px; height: 1080px;
    background: linear-gradient(135deg, #0a0f1e 0%, #111d35 40%, #0d1526 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Inter', sans-serif;
    overflow: hidden;
    position: relative;
  }

  /* Subtle grid pattern overlay */
  body::before {
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(59,130,246,0.03) 1px, transparent 1px),
      linear-gradient(90deg, rgba(59,130,246,0.03) 1px, transparent 1px);
    background-size: 60px 60px;
  }

  /* Glow orb behind content */
  .glow {
    position: absolute;
    width: 700px; height: 700px;
    top: 50%; left: 50%;
    transform: translate(-50%, -50%);
    background: radial-gradient(circle, rgba(59,130,246,0.08) 0%, transparent 70%);
    border-radius: 50%;
  }

  .container {
    position: relative;
    z-index: 1;
    text-align: center;
    max-width: 1400px;
    padding: 0 80px;
  }

  /* Top: logo + CueDeck */
  .brand-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    margin-bottom: 60px;
    opacity: 0.7;
  }
  .brand-logo {
    width: 44px; height: 44px;
    border-radius: 10px;
  }
  .brand-name {
    font-size: 28px;
    font-weight: 700;
    color: #fff;
    letter-spacing: -0.3px;
  }
  .brand-name .blue { color: #3b82f6; }

  /* Episode number badge */
  .ep-badge {
    display: inline-block;
    background: linear-gradient(135deg, #3b82f6, #2563eb);
    color: #fff;
    font-size: 18px;
    font-weight: 700;
    padding: 8px 28px;
    border-radius: 100px;
    letter-spacing: 3px;
    text-transform: uppercase;
    margin-bottom: 32px;
    box-shadow: 0 4px 24px rgba(59,130,246,0.3);
  }

  /* Title */
  .title {
    font-size: 56px;
    font-weight: 900;
    color: #fff;
    line-height: 1.2;
    letter-spacing: -1.5px;
    margin-bottom: 32px;
  }

  /* Divider line */
  .divider {
    width: 80px;
    height: 3px;
    background: #3b82f6;
    margin: 0 auto 28px;
    border-radius: 2px;
  }

  /* Subtitle */
  .subtitle {
    font-size: 22px;
    color: rgba(255,255,255,0.4);
    font-weight: 400;
    letter-spacing: 2px;
    text-transform: uppercase;
  }

  /* Bottom accent bar */
  .bottom-bar {
    position: absolute;
    bottom: 0; left: 0; right: 0;
    height: 4px;
    background: linear-gradient(90deg, transparent, #3b82f6, transparent);
  }

  /* Corner accents */
  .corner {
    position: absolute;
    width: 40px; height: 40px;
    border: 2px solid rgba(59,130,246,0.15);
  }
  .corner-tl { top: 40px; left: 40px; border-right: none; border-bottom: none; }
  .corner-tr { top: 40px; right: 40px; border-left: none; border-bottom: none; }
  .corner-bl { bottom: 40px; left: 40px; border-right: none; border-top: none; }
  .corner-br { bottom: 40px; right: 40px; border-left: none; border-top: none; }
</style>
</head>
<body>
  <div class="glow"></div>
  <div class="corner corner-tl"></div>
  <div class="corner corner-tr"></div>
  <div class="corner corner-bl"></div>
  <div class="corner corner-br"></div>

  <div class="container">
    <div class="brand-row">
      ${logoBase64 ? `<img class="brand-logo" src="${logoBase64}" alt="">` : ''}
      <div class="brand-name">Cue<span class="blue">Deck</span></div>
    </div>
    <div class="ep-badge">Episode ${pad}</div>
    <div class="title">${title}</div>
    <div class="divider"></div>
    <div class="subtitle">Tutorial Series</div>
  </div>

  <div class="bottom-bar"></div>
</body>
</html>`;
}

async function generateTitleCard(browser, epNum, previewOnly = false) {
  const pad = String(epNum).padStart(2, '0');
  const title = EPISODES[epNum];
  if (!title) {
    console.error(`  ✗ No title for episode ${epNum}`);
    return;
  }

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  const page = await context.newPage();
  await page.setContent(titleCardHTML(epNum, title), { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);

  // Save PNG screenshot
  const pngPath = resolve(TITLE_DIR, `ep${pad}-title.png`);
  await page.screenshot({ path: pngPath, type: 'png' });
  console.log(`  ✓ PNG: ${pngPath}`);

  if (!previewOnly) {
    // Generate 4-second mp4 from static image
    const mp4Path = resolve(TITLE_DIR, `ep${pad}-title.mp4`);
    execFileSync('ffmpeg', [
      '-y', '-loop', '1', '-i', pngPath,
      '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-c:v', 'libx264', '-t', '4', '-pix_fmt', 'yuv420p',
      '-r', '30', '-s', '1920x1080', '-c:a', 'aac', '-shortest',
      mp4Path,
    ], { stdio: 'pipe' });
    console.log(`  ✓ MP4: ${mp4Path}`);
  }

  await page.close();
  await context.close();
}

async function main() {
  mkdirSync(TITLE_DIR, { recursive: true });

  const args = process.argv.slice(2);
  const previewOnly = args.includes('--preview');
  const epArg = args.find(a => /^\d+$/.test(a));

  const browser = await chromium.launch();

  if (epArg) {
    const num = parseInt(epArg);
    console.log(`\nGenerating title card for Episode ${num}${previewOnly ? ' (preview only)' : ''}...`);
    await generateTitleCard(browser, num, previewOnly);
  } else {
    console.log(`\nGenerating title cards for all 21 episodes...`);
    for (let i = 1; i <= 21; i++) {
      console.log(`\nEpisode ${i}:`);
      await generateTitleCard(browser, i, previewOnly);
    }
  }

  await browser.close();
  console.log('\nDone!');
}

main().catch(err => {
  console.error('Title card generation failed:', err.message);
  process.exit(1);
});
