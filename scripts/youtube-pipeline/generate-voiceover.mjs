#!/usr/bin/env node
/**
 * CueDeck YouTube Voiceover Generator
 * Converts episode scripts to spoken audio using OpenAI TTS API.
 *
 * Requires: OPENAI_API_KEY env var or in .env file
 *
 * Usage:
 *   node scripts/youtube-pipeline/generate-voiceover.mjs 1          # single episode
 *   node scripts/youtube-pipeline/generate-voiceover.mjs 1 2 3      # specific episodes
 *   node scripts/youtube-pipeline/generate-voiceover.mjs             # all episodes
 *
 * Options:
 *   --voice=onyx       TTS voice (alloy|echo|fable|nova|onyx|shimmer) default: onyx
 *   --model=tts-1-hd   TTS model (tts-1|tts-1-hd) default: tts-1-hd
 *   --speed=1.0        Speed multiplier (0.25–4.0) default: 1.0
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const SCRIPTS_DIR = resolve(ROOT, 'scripts/youtube-scripts');
const OUT_DIR = resolve(ROOT, 'youtube-branding/voiceovers');

// Parse args
const allArgs = process.argv.slice(2);
const flags = {};
const epNums = [];
for (const a of allArgs) {
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    flags[k] = v;
  } else {
    const n = Number(a);
    if (n > 0 && n <= 21) epNums.push(n);
  }
}

const VOICE = flags.voice || 'onyx';
const MODEL = flags.model || 'tts-1-hd';
const SPEED = parseFloat(flags.speed || '1.0');

// Load API key from env or .env
let API_KEY = process.env.OPENAI_API_KEY;
if (!API_KEY) {
  const envPath = resolve(ROOT, '.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf8');
    const match = envContent.match(/OPENAI_API_KEY=(.+)/);
    if (match) API_KEY = match[1].trim();
  }
}

if (!API_KEY) {
  console.error('Error: OPENAI_API_KEY not found.');
  console.error('Set it as an environment variable or add to .env file:');
  console.error('  export OPENAI_API_KEY=sk-...');
  console.error('  echo "OPENAI_API_KEY=sk-..." > .env');
  process.exit(1);
}

// Find episode scripts (ep01-*.md, ep02-*.md, etc.)
function getScriptFiles() {
  return readdirSync(SCRIPTS_DIR)
    .filter(f => /^ep\d{2}.*\.md$/.test(f) && !f.startsWith('metadata'))
    .sort();
}

// Extract narration text from a script markdown file
// Only pulls text from blockquotes (> lines) which contain the spoken narration
function extractNarration(scriptPath) {
  const raw = readFileSync(scriptPath, 'utf8');
  const lines = raw.split('\n');
  const narration = [];

  for (const line of lines) {
    // Only extract blockquote lines (the actual narration)
    if (line.startsWith('>')) {
      let text = line.replace(/^>\s?/, ''); // strip > prefix
      text = text.replace(/^"|"$/g, '');    // strip wrapping quotes
      text = text.replace(/\[.*?\]/g, '');  // strip inline stage directions
      text = text.replace(/\*\*/g, '');     // strip bold markdown
      text = text.replace(/\*/g, '');       // strip italic markdown
      if (text.trim()) {
        narration.push(text.trim());
      } else {
        narration.push(''); // preserve paragraph breaks between blockquotes
      }
    }
  }

  return narration.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Call OpenAI TTS API
async function generateSpeech(text, outputPath) {
  // Split long text into chunks (max ~4096 chars per API call)
  const MAX_CHUNK = 4000;
  const chunks = [];

  if (text.length <= MAX_CHUNK) {
    chunks.push(text);
  } else {
    // Split on paragraph boundaries
    const paragraphs = text.split('\n\n');
    let current = '';
    for (const p of paragraphs) {
      if ((current + '\n\n' + p).length > MAX_CHUNK && current) {
        chunks.push(current.trim());
        current = p;
      } else {
        current = current ? current + '\n\n' + p : p;
      }
    }
    if (current.trim()) chunks.push(current.trim());
  }

  console.log(`    Generating ${chunks.length} audio chunk(s)...`);

  const audioBuffers = [];
  for (let i = 0; i < chunks.length; i++) {
    const resp = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        input: chunks[i],
        voice: VOICE,
        speed: SPEED,
        response_format: 'mp3',
      }),
    });

    if (!resp.ok) {
      const err = await resp.text();
      throw new Error(`OpenAI TTS API error (chunk ${i + 1}): ${resp.status} — ${err}`);
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    audioBuffers.push(buffer);
    console.log(`    ✓ Chunk ${i + 1}/${chunks.length} (${(buffer.length / 1024).toFixed(0)} KB)`);
  }

  if (audioBuffers.length === 1) {
    writeFileSync(outputPath, audioBuffers[0]);
  } else {
    // Concatenate MP3 chunks (simple concatenation works for MP3)
    writeFileSync(outputPath, Buffer.concat(audioBuffers));
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const scripts = getScriptFiles();
  const targets = epNums.length
    ? scripts.filter(f => epNums.includes(parseInt(f.match(/\d+/)[0])))
    : scripts;

  console.log(`Voice: ${VOICE} | Model: ${MODEL} | Speed: ${SPEED}x`);
  console.log(`Generating voiceovers for ${targets.length} episode(s)...\n`);

  for (const file of targets) {
    const epNum = parseInt(file.match(/\d+/)[0]);
    const pad = String(epNum).padStart(2, '0');
    const scriptPath = resolve(SCRIPTS_DIR, file);
    const outPath = resolve(OUT_DIR, `ep${pad}-voiceover.mp3`);

    console.log(`  Ep ${pad}:`);

    // Extract narration
    const narration = extractNarration(scriptPath);
    const wordCount = narration.split(/\s+/).length;
    console.log(`    Script: ${wordCount} words`);

    if (wordCount < 10) {
      console.log(`    ⚠ Script too short, skipping.`);
      continue;
    }

    // Save narration text for review
    const txtPath = resolve(OUT_DIR, `ep${pad}-narration.txt`);
    writeFileSync(txtPath, narration);

    // Generate audio
    await generateSpeech(narration, outPath);
    console.log(`    ✓ Saved: ${outPath}\n`);
  }

  console.log('Done! Voiceovers saved to:', OUT_DIR);
}

main().catch(err => {
  console.error('Voiceover generation failed:', err.message);
  process.exit(1);
});
