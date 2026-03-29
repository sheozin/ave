#!/usr/bin/env node
/**
 * CueDeck Intro & Outro Bumper Generator
 * Creates branded 3-second intro and 5-second outro videos.
 *
 * Usage:
 *   node scripts/youtube-pipeline/generate-bumpers.mjs
 */

import { chromium } from '@playwright/test';
import { execFileSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BRAND_DIR = resolve(ROOT, 'youtube-branding');
const TEMP_DIR = resolve(BRAND_DIR, 'temp');
const LOGO_PATH = resolve(ROOT, 'cuedeck-marketing/public/brand/logo-mark-400-transparent.png');

let logoBase64 = '';
if (existsSync(LOGO_PATH)) {
  logoBase64 = `data:image/png;base64,${readFileSync(LOGO_PATH).toString('base64')}`;
}

const INTRO_HTML = `<!DOCTYPE html>
<html>
<head>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1920px; height: 1080px;
    background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 50%, #1e293b 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Inter', sans-serif;
    overflow: hidden;
  }
  .container {
    text-align: center;
    animation: fadeIn 0.8s ease-out;
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(20px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .logo-img {
    width: 120px; height: 120px;
    border-radius: 24px;
    margin-bottom: 30px;
    box-shadow: 0 8px 40px rgba(59,130,246,0.3);
  }
  .logo-text {
    font-size: 72px;
    font-weight: 900;
    color: #fff;
    letter-spacing: -1px;
  }
  .logo-text .blue { color: #3b82f6; }
  .tagline {
    font-size: 24px;
    color: rgba(255,255,255,0.5);
    margin-top: 16px;
    font-weight: 400;
    letter-spacing: 4px;
    text-transform: uppercase;
  }
  /* Decorative elements */
  .ring {
    position: absolute;
    border: 2px solid rgba(59,130,246,0.15);
    border-radius: 50%;
  }
  .ring-1 { width: 600px; height: 600px; top: 50%; left: 50%; transform: translate(-50%,-50%); }
  .ring-2 { width: 800px; height: 800px; top: 50%; left: 50%; transform: translate(-50%,-50%); }
  .ring-3 { width: 1000px; height: 1000px; top: 50%; left: 50%; transform: translate(-50%,-50%); }
  .bottom-bar {
    position: absolute; bottom: 0; left: 0; right: 0; height: 4px;
    background: linear-gradient(90deg, transparent, #3b82f6, transparent);
  }
</style>
</head>
<body>
  <div class="ring ring-1"></div>
  <div class="ring ring-2"></div>
  <div class="ring ring-3"></div>
  <div class="container">
    ${logoBase64 ? `<img class="logo-img" src="${logoBase64}" alt="">` : ''}
    <div class="logo-text">Cue<span class="blue">Deck</span></div>
    <div class="tagline">Tutorial Series</div>
  </div>
  <div class="bottom-bar"></div>
</body>
</html>`;

const OUTRO_HTML = `<!DOCTYPE html>
<html>
<head>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1920px; height: 1080px;
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: 'Inter', sans-serif;
    overflow: hidden;
  }
  .container { text-align: center; }
  .logo-row {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 20px;
    margin-bottom: 40px;
  }
  .logo-img {
    width: 80px; height: 80px;
    border-radius: 18px;
    box-shadow: 0 4px 20px rgba(59,130,246,0.3);
  }
  .logo-text {
    font-size: 48px;
    font-weight: 900;
    color: #fff;
    letter-spacing: -0.5px;
  }
  .logo-text .blue { color: #3b82f6; }
  .cta {
    font-size: 32px;
    font-weight: 700;
    color: #fff;
    margin-bottom: 20px;
  }
  .url {
    display: inline-block;
    background: #3b82f6;
    color: #fff;
    font-size: 28px;
    font-weight: 700;
    padding: 16px 48px;
    border-radius: 14px;
    margin-bottom: 40px;
    box-shadow: 0 4px 20px rgba(59,130,246,0.4);
  }
  .sub-text {
    font-size: 22px;
    color: rgba(255,255,255,0.5);
    font-weight: 400;
  }
  .sub-text .highlight { color: #ef4444; font-weight: 700; }
  .bottom-bar {
    position: absolute; bottom: 0; left: 0; right: 0; height: 4px;
    background: #3b82f6;
  }
</style>
</head>
<body>
  <div class="container">
    <div class="logo-row">
      ${logoBase64 ? `<img class="logo-img" src="${logoBase64}" alt="">` : ''}
      <div class="logo-text">Cue<span class="blue">Deck</span></div>
    </div>
    <div class="cta">Try CueDeck free today</div>
    <div class="url">app.cuedeck.io</div>
    <div class="sub-text"><span class="highlight">Subscribe</span> for the next episode — new tutorial every week</div>
  </div>
  <div class="bottom-bar"></div>
</body>
</html>`;

async function main() {
  mkdirSync(TEMP_DIR, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  // Generate intro frames (30fps × 3 seconds = 90 frames)
  console.log('Generating intro bumper (3 seconds)...');
  const introPage = await context.newPage();
  await introPage.setContent(INTRO_HTML, { waitUntil: 'networkidle' });
  await introPage.waitForTimeout(500);

  const introFrameDir = resolve(TEMP_DIR, 'intro-frames');
  mkdirSync(introFrameDir, { recursive: true });

  // Static frame — repeat for 3 seconds
  const introFrame = resolve(introFrameDir, 'frame.png');
  await introPage.screenshot({ path: introFrame, type: 'png' });
  await introPage.close();

  // Use ffmpeg to create 3-second video from static image
  const introOut = resolve(BRAND_DIR, 'intro.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loop', '1', '-i', introFrame,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264', '-t', '3', '-pix_fmt', 'yuv420p',
    '-r', '30', '-s', '1920x1080', '-c:a', 'aac', '-shortest',
    introOut,
  ], { stdio: 'pipe' });
  console.log(`  ✓ Intro: ${introOut}`);

  // Generate outro frames (5 seconds)
  console.log('Generating outro bumper (5 seconds)...');
  const outroPage = await context.newPage();
  await outroPage.setContent(OUTRO_HTML, { waitUntil: 'networkidle' });
  await outroPage.waitForTimeout(500);

  const outroFrameDir = resolve(TEMP_DIR, 'outro-frames');
  mkdirSync(outroFrameDir, { recursive: true });

  const outroFrame = resolve(outroFrameDir, 'frame.png');
  await outroPage.screenshot({ path: outroFrame, type: 'png' });
  await outroPage.close();

  const outroOut = resolve(BRAND_DIR, 'outro.mp4');
  execFileSync('ffmpeg', [
    '-y', '-loop', '1', '-i', outroFrame,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-c:v', 'libx264', '-t', '5', '-pix_fmt', 'yuv420p',
    '-r', '30', '-s', '1920x1080', '-c:a', 'aac', '-shortest',
    outroOut,
  ], { stdio: 'pipe' });
  console.log(`  ✓ Outro: ${outroOut}`);

  await browser.close();

  // Cleanup temp frames
  for (const dir of [introFrameDir, outroFrameDir]) {
    for (const f of readdirSync(dir)) unlinkSync(resolve(dir, f));
  }

  console.log('\nDone! Bumpers saved to youtube-branding/');
}

main().catch(err => {
  console.error('Bumper generation failed:', err.message);
  process.exit(1);
});
