#!/usr/bin/env node
/**
 * CueDeck Tutorial Production Orchestrator
 * Master script that runs the full pipeline for one or more episodes.
 *
 * Usage:
 *   node scripts/youtube-pipeline/produce-tutorial.mjs 1                    # full pipeline for ep 1
 *   node scripts/youtube-pipeline/produce-tutorial.mjs 1 2 3                # batch: eps 1-3
 *   node scripts/youtube-pipeline/produce-tutorial.mjs 1 --step=thumbnail   # single step only
 *   node scripts/youtube-pipeline/produce-tutorial.mjs all                  # all 21 episodes
 *   node scripts/youtube-pipeline/produce-tutorial.mjs status               # show pipeline status
 *
 * Steps (in order):
 *   1. thumbnail   — Generate branded 1280×720 thumbnail
 *   2. captions    — Generate timed SRT captions from script
 *   3. record      — Automate CueDeck demo + screen record
 *   4. assemble    — Burn in captions + background music via ffmpeg
 *   5. upload      — Upload to YouTube with metadata
 *   6. playlist    — Add to series playlist
 *   7. sync        — Update marketing site + metadata links
 *
 * Options:
 *   --step=<name>   Run only a specific step
 *   --from=<name>   Start from a specific step
 *   --dry-run       Show what would be done without doing it
 *   --public        Upload as public (default: unlisted)
 */

import { execFileSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BRAND_DIR = resolve(ROOT, 'youtube-branding');
const NODE = process.execPath;

// Parse args
const rawArgs = process.argv.slice(2);
const flags = {};
const positional = [];
for (const a of rawArgs) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v || true;
  } else {
    positional.push(a);
  }
}

const dryRun = flags['dry-run'] || false;
const stepOnly = flags['step'] || null;
const startFrom = flags['from'] || null;
const isPublic = flags['public'] || false;

const STEPS = ['thumbnail', 'captions', 'record', 'assemble', 'upload', 'playlist', 'sync'];

function runScript(script, args, label) {
  const scriptPath = resolve(__dirname, script);
  console.log(`\n${'='.repeat(60)}`);
  console.log(`  STEP: ${label}`);
  console.log(`${'='.repeat(60)}\n`);

  if (dryRun) {
    console.log(`  [DRY RUN] Would run: node ${script} ${args.join(' ')}`);
    return true;
  }

  try {
    execFileSync(NODE, [scriptPath, ...args], {
      stdio: 'inherit',
      timeout: 600000, // 10 min max per step
      cwd: ROOT,
    });
    return true;
  } catch (err) {
    console.error(`\n  ✗ Step failed: ${label}`);
    console.error(`    ${err.message}`);
    return false;
  }
}

function getActiveSteps() {
  if (stepOnly) {
    if (!STEPS.includes(stepOnly)) {
      console.error(`Unknown step: ${stepOnly}`);
      console.error(`Valid steps: ${STEPS.join(', ')}`);
      process.exit(1);
    }
    return [stepOnly];
  }

  if (startFrom) {
    const idx = STEPS.indexOf(startFrom);
    if (idx === -1) {
      console.error(`Unknown step: ${startFrom}`);
      process.exit(1);
    }
    return STEPS.slice(idx);
  }

  return STEPS;
}

function showStatus() {
  console.log('\nCueDeck Tutorial Pipeline Status\n');

  for (let ep = 1; ep <= 21; ep++) {
    const pad = String(ep).padStart(2, '0');
    const thumb = existsSync(resolve(BRAND_DIR, `thumbnails/ep${pad}-thumbnail.png`)) ? '✓' : '·';
    const capts = existsSync(resolve(BRAND_DIR, `captions/ep${pad}-captions.srt`)) ? '✓' : '·';
    const recording = existsSync(resolve(BRAND_DIR, `recordings/ep${pad}-raw.webm`)) ? '✓' : '·';
    const final = existsSync(resolve(BRAND_DIR, `final/ep${pad}-final.mp4`)) ? '✓' : '·';

    let uploaded = '·';
    const idsFile = resolve(__dirname, 'video-ids.json');
    if (existsSync(idsFile)) {
      const ids = JSON.parse(require('fs').readFileSync(idsFile, 'utf8'));
      if (ids[`ep${pad}`]) uploaded = '✓';
    }

    console.log(`  Ep ${pad}: Thumb[${thumb}] Capts[${capts}] Record[${recording}] Final[${final}] Upload[${uploaded}]`);
  }

  // Playlist status
  const playlistFile = resolve(__dirname, 'playlist-id.json');
  if (existsSync(playlistFile)) {
    const pl = JSON.parse(require('fs').readFileSync(playlistFile, 'utf8'));
    console.log(`\n  Playlist: ✓ ${pl.url}`);
  } else {
    console.log('\n  Playlist: · (not created)');
  }

  console.log('\n  Legend: ✓ = done, · = pending\n');
}

async function produceEpisode(epNum) {
  const pad = String(epNum).padStart(2, '0');
  const steps = getActiveSteps();

  console.log(`\n${'#'.repeat(60)}`);
  console.log(`  PRODUCING EPISODE ${pad}`);
  console.log(`  Steps: ${steps.join(' → ')}`);
  console.log(`${'#'.repeat(60)}`);

  for (const step of steps) {
    let success = true;

    switch (step) {
      case 'thumbnail':
        success = runScript('generate-thumbnails.mjs', [String(epNum)], `Thumbnail — Ep ${pad}`);
        break;

      case 'captions':
        success = runScript('generate-captions.mjs', [String(epNum)], `Captions — Ep ${pad}`);
        break;

      case 'record':
        success = runScript('record-demo.mjs', [String(epNum)], `Demo Recording — Ep ${pad}`);
        break;

      case 'assemble':
        success = runScript('assemble-video.mjs', [String(epNum)], `Video Assembly — Ep ${pad}`);
        break;

      case 'upload': {
        const uploadArgs = [String(epNum), '--thumbnail'];
        if (isPublic) uploadArgs.push('--public');
        success = runScript('upload-youtube.mjs', uploadArgs, `YouTube Upload — Ep ${pad}`);
        break;
      }

      case 'playlist':
        success = runScript('manage-playlist.mjs', ['add', String(epNum)], `Playlist — Ep ${pad}`);
        break;

      case 'sync':
        success = runScript('sync-links.mjs', [], `Link Sync`);
        break;
    }

    if (!success) {
      console.error(`\n⚠ Pipeline stopped at step: ${step}`);
      console.error(`  Fix the issue and resume with: --from=${step}`);
      return false;
    }
  }

  return true;
}

async function main() {
  // Special command: status
  if (positional[0] === 'status') {
    showStatus();
    return;
  }

  // Determine episodes to produce
  let episodes;
  if (positional[0] === 'all') {
    episodes = Array.from({ length: 21 }, (_, i) => i + 1);
  } else {
    episodes = positional.map(Number).filter(n => n > 0 && n <= 21);
  }

  if (episodes.length === 0) {
    console.log('CueDeck Tutorial Production Orchestrator\n');
    console.log('Usage:');
    console.log('  produce-tutorial.mjs <ep> [<ep>...]   Produce specific episodes');
    console.log('  produce-tutorial.mjs all               Produce all 21 episodes');
    console.log('  produce-tutorial.mjs status             Show pipeline status');
    console.log('');
    console.log('Options:');
    console.log('  --step=<name>    Run only one step (thumbnail|voiceover|record|assemble|upload|playlist|sync)');
    console.log('  --from=<name>    Resume from a specific step');
    console.log('  --dry-run        Preview without executing');
    console.log('  --public         Upload as public (default: unlisted)');
    process.exit(0);
  }

  console.log(`\nCueDeck Tutorial Producer${dryRun ? ' [DRY RUN]' : ''}`);
  console.log(`Episodes: ${episodes.join(', ')}`);
  console.log(`Steps: ${getActiveSteps().join(' → ')}\n`);

  let produced = 0;
  let failed = 0;

  for (const ep of episodes) {
    const ok = await produceEpisode(ep);
    if (ok) produced++;
    else failed++;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`  PRODUCTION COMPLETE`);
  console.log(`  Produced: ${produced} | Failed: ${failed}`);
  console.log(`${'='.repeat(60)}\n`);
}

main().catch(err => {
  console.error('Production failed:', err.message);
  process.exit(1);
});
