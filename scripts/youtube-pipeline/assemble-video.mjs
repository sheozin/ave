#!/usr/bin/env node
/**
 * CueDeck Video Assembler
 * Combines screen recording + burned-in captions + background music into a final MP4.
 * Optionally adds an intro bumper and outro card.
 *
 * Usage:
 *   node scripts/youtube-pipeline/assemble-video.mjs 1       # assemble episode 1
 *   node scripts/youtube-pipeline/assemble-video.mjs 3       # assemble episode 3
 *   node scripts/youtube-pipeline/assemble-video.mjs 1 --no-intro --no-outro
 *   node scripts/youtube-pipeline/assemble-video.mjs 1 --no-music
 *   node scripts/youtube-pipeline/assemble-video.mjs 1 --no-captions
 *
 * Inputs (from youtube-branding/):
 *   recordings/ep{NN}-raw.webm      — screen recording
 *   captions/ep{NN}-captions.srt    — timed subtitle file
 *   music/background.mp3            — looping background music
 *   intro.mp4                       — (optional) branded intro bumper
 *   outro.mp4                       — (optional) branded outro card
 *
 * Output:
 *   youtube-branding/final/ep{NN}-final.mp4
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, unlinkSync, statSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Parse SRT to get the last caption end timestamp (seconds)
function getSRTDuration(srtPath) {
  if (!existsSync(srtPath)) return null;
  const text = readFileSync(srtPath, 'utf8');
  let maxEnd = 0;
  for (const match of text.matchAll(/(\d{2}):(\d{2}):(\d{2})[,.](\d+)\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d+)/g)) {
    const end = parseInt(match[5]) * 3600 + parseInt(match[6]) * 60 + parseInt(match[7]) + parseInt(match[8]) / 1000;
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd > 0 ? maxEnd + 3 : null; // +3s buffer after last caption
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BRAND_DIR = resolve(ROOT, 'youtube-branding');
const OUT_DIR = resolve(BRAND_DIR, 'final');

// Parse args
const args = process.argv.slice(2);
const allMode = args.includes('--all');
const epArg = args.find(a => /^\d+$/.test(a));
const epNum = epArg ? parseInt(epArg) : null;
const noIntro = args.includes('--no-intro');
const noOutro = args.includes('--no-outro');
const noMusic = args.includes('--no-music');
const noCaptions = args.includes('--no-captions');

if (!allMode && (!epNum || epNum < 1 || epNum > 21)) {
  console.error('Usage: node assemble-video.mjs <episode-number|--all> [--no-intro] [--no-outro] [--no-music] [--no-captions]');
  process.exit(1);
}

const TEMP_DIR = resolve(BRAND_DIR, 'temp');

// Music volume (relative to full, 0.0–1.0).
const MUSIC_VOLUME = 0.25;

function run(ffmpegArgs, label) {
  console.log(`  ${label}...`);
  try {
    execFileSync('ffmpeg', ffmpegArgs, { stdio: 'pipe', timeout: 600000 });
    console.log(`  ✓ ${label}`);
  } catch (err) {
    console.error(`  ✗ ${label}: ${err.stderr?.toString().slice(0, 300)}`);
    throw err;
  }
}

function cpFile(src, dst, label) {
  console.log(`  ${label}...`);
  execFileSync('cp', [src, dst], { stdio: 'pipe' });
  console.log(`  ✓ ${label}`);
}

async function assembleEpisode(num) {
  const pad = String(num).padStart(2, '0');
  const RECORDING = resolve(BRAND_DIR, `recordings/ep${pad}-raw.webm`);
  const CAPTIONS_FILE = resolve(BRAND_DIR, `captions/ep${pad}-captions.srt`);
  const MUSIC = resolve(BRAND_DIR, 'music/background.mp3');
  const TITLE_CARD = resolve(BRAND_DIR, `title-cards/ep${pad}-title.mp4`);
  const INTRO = existsSync(TITLE_CARD) ? TITLE_CARD : resolve(BRAND_DIR, 'intro.mp4');
  const OUTRO = resolve(BRAND_DIR, 'outro.mp4');
  const FINAL = resolve(OUT_DIR, `ep${pad}-final.mp4`);

  console.log(`\nAssembling Episode ${pad}...\n`);

  // Check inputs
  const hasRecording = existsSync(RECORDING);
  const hasCaptions = !noCaptions && existsSync(CAPTIONS_FILE);
  const hasMusic = !noMusic && existsSync(MUSIC);
  const hasIntro = !noIntro && existsSync(INTRO);
  const hasOutro = !noOutro && existsSync(OUTRO);

  if (!hasRecording) {
    console.error(`  ✗ Missing screen recording: ${RECORDING}`);
    return false;
  }

  console.log(`  Inputs:`);
  console.log(`    Recording: ✓`);
  console.log(`    Captions:  ${hasCaptions ? '✓' : '— skipped'}`);
  console.log(`    Music:     ${hasMusic ? '✓' : '— skipped'}`);
  console.log(`    Intro:     ${hasIntro ? '✓' : '— skipped'}`);
  console.log(`    Outro:     ${hasOutro ? '✓' : '— skipped'}\n`);

  // Step 1: Normalize raw recording to MP4/H.264 1080p, trimmed to SRT duration
  const srtTrimDuration = hasCaptions ? getSRTDuration(CAPTIONS_FILE) : null;
  if (srtTrimDuration) {
    console.log(`  Trim: recording cut to ${srtTrimDuration.toFixed(1)}s (SRT end + 3s buffer)`);
  }
  const normalizedVideo = resolve(TEMP_DIR, `ep${pad}-normalized.mp4`);
  run(
    ['-y', '-i', RECORDING,
     ...(srtTrimDuration ? ['-t', String(srtTrimDuration)] : []),
     '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
     '-r', '30', '-s', '1920x1080', '-an',
     normalizedVideo],
    'Normalize video to MP4/H.264'
  );

  // Step 2: Burn in captions (if available)
  let captionedVideo = normalizedVideo;
  if (hasCaptions) {
    captionedVideo = resolve(TEMP_DIR, `ep${pad}-captioned.mp4`);
    // Escape path for ffmpeg subtitles filter (colons and backslashes)
    const srtEscaped = CAPTIONS_FILE.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "'\\''");

    run(
      ['-y', '-i', normalizedVideo,
       '-vf', `subtitles='${srtEscaped}':force_style='FontName=Arial,FontSize=15,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=4,Outline=1,Shadow=0,MarginV=45,Alignment=2'`,
       '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
       '-an',
       captionedVideo],
      'Burn in captions'
    );
  }

  // Step 3: Add background music (loop to match video length, low volume)
  let mainVideo;
  if (hasMusic) {
    mainVideo = resolve(TEMP_DIR, `ep${pad}-with-music.mp4`);
    run(
      ['-y',
       '-i', captionedVideo,
       '-stream_loop', '-1', '-i', MUSIC,
       '-c:v', 'copy',
       '-c:a', 'aac', '-b:a', '128k',
       '-filter:a', `volume=${MUSIC_VOLUME}`,
       '-map', '0:v:0', '-map', '1:a:0',
       '-shortest',
       mainVideo],
      'Add background music'
    );
  } else {
    // Silent audio track (YouTube requires audio)
    mainVideo = resolve(TEMP_DIR, `ep${pad}-silent.mp4`);
    run(
      ['-y', '-i', captionedVideo,
       '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
       '-c:v', 'copy', '-c:a', 'aac', '-shortest',
       mainVideo],
      'Add silent audio track'
    );
  }

  // Step 4: Concatenate intro + main + outro
  if (hasIntro || hasOutro) {
    const concatList = resolve(TEMP_DIR, `ep${pad}-concat.txt`);
    const parts = [];
    if (hasIntro) parts.push(`file '${INTRO}'`);
    parts.push(`file '${mainVideo}'`);
    if (hasOutro) parts.push(`file '${OUTRO}'`);

    writeFileSync(concatList, parts.join('\n'));

    run(
      ['-y', '-f', 'concat', '-safe', '0', '-i', concatList,
       '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
       '-c:a', 'aac', '-b:a', '128k',
       FINAL],
      'Concatenate intro + main + outro'
    );
  } else {
    cpFile(mainVideo, FINAL, 'Copy to final output');
  }

  // Cleanup temp files
  const tempFiles = [normalizedVideo, captionedVideo, mainVideo].filter(f => f !== FINAL);
  for (const f of new Set(tempFiles)) {
    if (existsSync(f)) {
      try { unlinkSync(f); } catch {}
    }
  }

  const size = statSync(FINAL).size;
  const sizeMB = (size / 1024 / 1024).toFixed(1);

  console.log(`\n  ✓ Final video: ${FINAL}`);
  console.log(`    Size: ${sizeMB} MB`);
  return true;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(TEMP_DIR, { recursive: true });

  const episodes = allMode ? Array.from({ length: 21 }, (_, i) => i + 1) : [epNum];
  let ok = 0, fail = 0;

  for (const ep of episodes) {
    try {
      const success = await assembleEpisode(ep);
      if (success) ok++; else fail++;
    } catch (err) {
      console.error(`  ✗ Episode ${ep} failed: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nAssembly complete: ${ok} succeeded, ${fail} failed`);
}

main().catch(err => {
  console.error('Assembly failed:', err.message);
  process.exit(1);
});
