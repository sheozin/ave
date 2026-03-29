#!/usr/bin/env node
/**
 * CueDeck Caption Generator
 * Extracts narration text from episode scripts and creates timed SRT subtitle files.
 * These SRT files are burned into the video by assemble-video.mjs using ffmpeg drawtext.
 *
 * Usage:
 *   node scripts/youtube-pipeline/generate-captions.mjs 1          # single episode
 *   node scripts/youtube-pipeline/generate-captions.mjs 1 2 3      # specific episodes
 *   node scripts/youtube-pipeline/generate-captions.mjs             # all episodes
 *
 * Output: youtube-branding/captions/ep{NN}-captions.srt
 *
 * The SRT timing is estimated from word count (avg reading speed ~160 wpm for on-screen text).
 * Captions are chunked into 6–10 word phrases for comfortable reading.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SCRIPTS_DIR = resolve(ROOT, 'scripts/youtube-scripts');
const OUT_DIR = resolve(ROOT, 'youtube-branding/captions');

// Words per minute for on-screen caption pacing
const WPM = 160;
// Extra padding between captions (seconds)
const GAP = 0.3;
// Max words per caption line
const MAX_WORDS_PER_CAPTION = 10;
// Min words per caption (avoid tiny fragments)
const MIN_WORDS_PER_CAPTION = 4;
// Intro bumper offset (seconds) — captions start after intro
const INTRO_OFFSET = 5;

// Parse args
const epNums = process.argv.slice(2).map(Number).filter(n => n > 0 && n <= 21);

function getScriptFiles() {
  return readdirSync(SCRIPTS_DIR)
    .filter(f => /^ep\d{2}.*\.md$/.test(f) && !f.startsWith('metadata'))
    .sort();
}

/**
 * Extract narration blocks from a script file.
 * Returns array of { section, text } where text is the spoken narration.
 */
function extractSections(scriptPath) {
  const raw = readFileSync(scriptPath, 'utf8');
  const lines = raw.split('\n');
  const sections = [];
  let currentSection = 'INTRO';
  let currentText = [];

  for (const line of lines) {
    // Detect section headers (## SECTION NAME)
    const sectionMatch = line.match(/^##\s+(.+?)(?:\s+\([\d:–-]+\))?$/);
    if (sectionMatch) {
      // Save previous section if it has text
      if (currentText.length > 0) {
        sections.push({ section: currentSection, text: currentText.join(' ').trim() });
        currentText = [];
      }
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Extract blockquote narration lines
    if (line.startsWith('>')) {
      let text = line.replace(/^>\s?/, '');
      text = text.replace(/^"|"$/g, '');      // strip wrapping quotes
      text = text.replace(/\[.*?\]/g, '');     // strip inline stage directions
      text = text.replace(/\*\*/g, '');        // strip bold
      text = text.replace(/\*/g, '');          // strip italic
      text = text.trim();
      if (text) currentText.push(text);
    }
  }

  // Don't forget the last section
  if (currentText.length > 0) {
    sections.push({ section: currentSection, text: currentText.join(' ').trim() });
  }

  // Filter out non-narration sections
  return sections.filter(s =>
    !s.section.startsWith('ON-SCREEN') &&
    !s.section.startsWith('CHECKLIST') &&
    s.text.length > 0
  );
}

/**
 * Split text into caption-sized chunks (6–10 words each).
 * Tries to break at natural punctuation boundaries.
 */
function chunkText(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks = [];

  for (const sentence of sentences) {
    const words = sentence.split(/\s+/).filter(Boolean);

    if (words.length <= MAX_WORDS_PER_CAPTION) {
      chunks.push(words.join(' '));
      continue;
    }

    // Split long sentences into chunks
    let buf = [];
    for (const word of words) {
      buf.push(word);

      // Break at natural points (comma, dash, conjunction) if we have enough words
      const isBreakpoint = /[,;:—–-]$/.test(word) ||
        ['and', 'but', 'or', 'then', 'when', 'where', 'which', 'that'].includes(buf[buf.length - 1]?.toLowerCase());

      if (buf.length >= MIN_WORDS_PER_CAPTION && (buf.length >= MAX_WORDS_PER_CAPTION || (isBreakpoint && buf.length >= 6))) {
        chunks.push(buf.join(' '));
        buf = [];
      }
    }
    if (buf.length > 0) {
      // Merge tiny remainder with previous chunk
      if (buf.length < MIN_WORDS_PER_CAPTION && chunks.length > 0) {
        chunks[chunks.length - 1] += ' ' + buf.join(' ');
      } else {
        chunks.push(buf.join(' '));
      }
    }
  }

  return chunks;
}

/**
 * Format seconds to SRT timestamp: HH:MM:SS,mmm
 */
function formatSRT(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/**
 * Generate timed SRT captions from sections.
 */
function generateSRT(sections) {
  const allChunks = [];

  for (const section of sections) {
    const chunks = chunkText(section.text);
    for (const chunk of chunks) {
      allChunks.push(chunk);
    }
  }

  let currentTime = INTRO_OFFSET;
  const entries = [];

  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const wordCount = chunk.split(/\s+/).length;
    const duration = (wordCount / WPM) * 60; // seconds per chunk

    // Minimum display time of 2 seconds
    const displayTime = Math.max(2, duration);

    const start = currentTime;
    const end = start + displayTime;

    entries.push({
      index: i + 1,
      start: formatSRT(start),
      end: formatSRT(end),
      text: chunk,
    });

    currentTime = end + GAP;
  }

  // Build SRT string
  return entries.map(e =>
    `${e.index}\n${e.start} --> ${e.end}\n${e.text}\n`
  ).join('\n');
}

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const scripts = getScriptFiles();
  const targets = epNums.length
    ? scripts.filter(f => epNums.includes(parseInt(f.match(/\d+/)[0])))
    : scripts;

  console.log(`Generating captions for ${targets.length} episode(s)...\n`);

  for (const file of targets) {
    const num = parseInt(file.match(/\d+/)[0]);
    const pad = String(num).padStart(2, '0');
    const scriptPath = resolve(SCRIPTS_DIR, file);
    const outPath = resolve(OUT_DIR, `ep${pad}-captions.srt`);

    console.log(`  Ep ${pad}:`);

    const sections = extractSections(scriptPath);
    const totalWords = sections.reduce((sum, s) => sum + s.text.split(/\s+/).length, 0);
    console.log(`    Sections: ${sections.length} | Words: ${totalWords}`);

    if (totalWords < 10) {
      console.log(`    ⚠ Script too short, skipping.`);
      continue;
    }

    const srt = generateSRT(sections);
    const captionCount = (srt.match(/^\d+$/gm) || []).length;
    writeFileSync(outPath, srt);
    console.log(`    ✓ ${captionCount} captions → ${outPath}`);
  }

  console.log('\nDone! Captions saved to:', OUT_DIR);
}

main();
