#!/usr/bin/env node
/**
 * CueDeck YouTube Thumbnail Generator
 * Renders 1280×720 branded thumbnails for all 21 episodes using Playwright.
 *
 * Usage:
 *   node scripts/youtube-pipeline/generate-thumbnails.mjs          # all episodes
 *   node scripts/youtube-pipeline/generate-thumbnails.mjs 1        # single episode
 *   node scripts/youtube-pipeline/generate-thumbnails.mjs 3 7 12   # specific episodes
 */

import { chromium } from '@playwright/test';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const OUT_DIR = resolve(ROOT, 'youtube-branding/thumbnails');
const DATA_FILE = resolve(__dirname, 'thumbnail-data.json');
const LOGO_PATH = resolve(ROOT, 'cuedeck-marketing/public/brand/logo-mark-400-transparent.png');

// Parse CLI args for specific episodes
const args = process.argv.slice(2).map(Number).filter(n => n > 0 && n <= 21);
const episodes = JSON.parse(readFileSync(DATA_FILE, 'utf8'));
const targets = args.length ? episodes.filter(e => args.includes(e.ep)) : episodes;

// Read logo as base64 for embedding in HTML
let logoBase64 = '';
if (existsSync(LOGO_PATH)) {
  logoBase64 = `data:image/png;base64,${readFileSync(LOGO_PATH).toString('base64')}`;
}

function buildHTML(ep) {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;700;900&display=swap');
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: 1280px; height: 720px;
    font-family: 'Inter', -apple-system, sans-serif;
    background: ${ep.bg};
    color: #fff;
    display: flex;
    overflow: hidden;
    position: relative;
  }
  .content {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 60px 70px;
    position: relative;
    z-index: 2;
  }
  .ep-label {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 3px;
    text-transform: uppercase;
    color: ${ep.accent};
    margin-bottom: 16px;
  }
  .main-text {
    font-size: 72px;
    font-weight: 900;
    line-height: 1.05;
    letter-spacing: -1.5px;
    margin-bottom: 16px;
    max-width: 800px;
  }
  .divider {
    width: 80px;
    height: 5px;
    background: ${ep.accent};
    border-radius: 3px;
    margin-bottom: 18px;
  }
  .subtitle {
    font-size: 30px;
    font-weight: 700;
    color: rgba(255,255,255,0.75);
    letter-spacing: 0.5px;
  }
  .badge {
    position: absolute;
    top: 50px;
    right: 70px;
    background: ${ep.badgeColor || ep.accent};
    color: #fff;
    font-size: 28px;
    font-weight: 900;
    padding: 10px 24px;
    border-radius: 10px;
    letter-spacing: 1px;
    z-index: 10;
    box-shadow: 0 4px 20px ${ep.badgeColor || ep.accent}66;
  }
  .logo-area {
    position: absolute;
    bottom: 40px;
    right: 60px;
    display: flex;
    align-items: center;
    gap: 14px;
    z-index: 5;
  }
  .logo-img {
    width: 48px;
    height: 48px;
    border-radius: 10px;
  }
  .logo-text {
    font-size: 24px;
    font-weight: 800;
    letter-spacing: -0.3px;
  }
  .logo-text .blue { color: #3b82f6; }
  /* Decorative accent circles */
  .deco-1 {
    position: absolute;
    width: 400px; height: 400px;
    border-radius: 50%;
    background: ${ep.accent}15;
    top: -100px; right: -50px;
    z-index: 1;
  }
  .deco-2 {
    position: absolute;
    width: 250px; height: 250px;
    border-radius: 50%;
    background: ${ep.accent}10;
    bottom: -50px; right: 200px;
    z-index: 1;
  }
  /* Bottom accent bar */
  .bottom-bar {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 6px;
    background: ${ep.accent};
    z-index: 10;
  }
</style>
</head>
<body>
  <div class="deco-1"></div>
  <div class="deco-2"></div>
  ${ep.badge ? `<div class="badge">${ep.badge}</div>` : ''}
  <div class="content">
    <div class="ep-label">CueDeck Tutorial #${String(ep.ep).padStart(2, '0')}</div>
    <div class="main-text">${ep.text}</div>
    <div class="divider"></div>
    <div class="subtitle">${ep.subtitle}</div>
  </div>
  <div class="logo-area">
    ${logoBase64 ? `<img class="logo-img" src="${logoBase64}" alt="">` : ''}
    <div class="logo-text">Cue<span class="blue">Deck</span></div>
  </div>
  <div class="bottom-bar"></div>
</body>
</html>`;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`Generating ${targets.length} thumbnail(s)...\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });

  for (const ep of targets) {
    const page = await context.newPage();
    const html = buildHTML(ep);
    await page.setContent(html, { waitUntil: 'networkidle' });
    // Wait for font load
    await page.waitForTimeout(500);

    const outFile = resolve(OUT_DIR, `ep${String(ep.ep).padStart(2, '0')}-thumbnail.png`);
    await page.screenshot({ path: outFile, type: 'png' });
    await page.close();

    const pad = String(ep.ep).padStart(2, '0');
    console.log(`  ✓ Ep ${pad} — ${ep.text} | ${ep.subtitle}`);
  }

  await browser.close();
  console.log(`\nDone! Thumbnails saved to: ${OUT_DIR}`);
}

main().catch(err => {
  console.error('Thumbnail generation failed:', err);
  process.exit(1);
});
