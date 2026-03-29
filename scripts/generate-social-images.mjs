#!/usr/bin/env node
/**
 * generate-social-images.mjs
 *
 * Generates DALL-E 3 images for the current week's social posts and optionally
 * for a blog post featured image.
 *
 * Usage:
 *   node scripts/generate-social-images.mjs
 *   node scripts/generate-social-images.mjs --blog introducing-cuedeck
 *
 * Output:
 *   cuedeck-marketing/content/social/images/{week}/{day}-twitter.png    (1792x1024)
 *   cuedeck-marketing/content/social/images/{week}/{day}-linkedin.png   (1792x1024)
 *   cuedeck-marketing/content/posts/{slug}/featuredImage.png             (1792x1024)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MARKETING = join(ROOT, 'cuedeck-marketing');
const CALENDAR_PATH = join(MARKETING, 'content/social/content-calendar.md');

// --- Load .env -----------------------------------------------------------------

function loadEnv() {
  const envPath = join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const match = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const val = match[2].trim().replace(/^["']|["']$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  }
}

loadEnv();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error('OPENAI_API_KEY not set in .env or environment');
  process.exit(1);
}

// --- Parse content calendar ----------------------------------------------------

function parseCalendar() {
  if (!existsSync(CALENDAR_PATH)) {
    console.error('Content calendar not found:', CALENDAR_PATH);
    process.exit(1);
  }

  const content = readFileSync(CALENDAR_PATH, 'utf-8');

  const weekMatches = [...content.matchAll(/## Week of ([^\n]+)/g)];
  if (!weekMatches.length) {
    console.error('No week found in content calendar');
    process.exit(1);
  }
  const weekDate = weekMatches[weekMatches.length - 1][1].trim();

  const days = [];
  const dayRegex = /### ((?:Mon|Tue|Wed|Thu|Fri)[^\n]*)\n([\s\S]*?)(?=\n### |\n---|\n## |$)/g;
  let m;
  while ((m = dayRegex.exec(content)) !== null) {
    const dayName = m[1].replace(/\(.*\)/, '').trim();
    const body = m[2];

    const anglesMatch = body.match(/\*\*Angles used:\*\*\s*([^\n]+)/);
    const twitterMatch = body.match(/\*\*Twitter:\*\*\s*([^\n]+)/);
    const linkedinMatch = body.match(/\*\*LinkedIn(?:[^:*]*):\*\*\s*([^\n]+)/);

    if (anglesMatch) {
      days.push({
        day: dayName,
        slug: dayName.split(/\s/)[0].toLowerCase(),
        angles: anglesMatch[1].trim(),
        hasTwitter: !!twitterMatch,
        hasLinkedIn: !!linkedinMatch,
        blogSlug: extractBlogSlug(anglesMatch[1]),
      });
    }
  }

  return { weekDate, days };
}

function extractBlogSlug(angles) {
  const m = angles.match(/blog promo \(([^)]+)\)/);
  return m ? m[1] : null;
}

// --- Build DALL-E prompt -------------------------------------------------------

const TOPIC_MAP = [
  ['comms chaos', 'a chaotic conference backstage, multiple people on phones and radios, urgent atmosphere, dramatic shadows'],
  ['whatsapp', 'a cluttered desk with multiple glowing phone screens showing chat notifications, dark moody office environment'],
  ['spreadsheet', 'a frustrated person surrounded by multiple monitors showing spreadsheets late at night, dramatic side lighting'],
  ['delay cascade', 'a large illuminated conference schedule board with clock hands blurred, domino effect, dark atmospheric venue'],
  ['overrun', 'a conference stage bathed in deep red emergency lighting, speaker at podium, audience silhouettes, intense cinematic shot'],
  ['stage timer', 'a close-up of a large digital countdown clock on a dark stage, dramatic lighting, tension'],
  ['registration', 'a professional conference registration desk at a modern venue, warm welcoming light, organized and efficient'],
  ['onboarding', 'a wide shot of a sleek modern conference venue lobby being prepared, calm before the event, architectural lighting'],
  ['multi-role sync', 'a dark professional event production control room, multiple operators with headsets, glowing screens, cinematic wide shot'],
  ['introducing-cuedeck', 'a state-of-the-art live event production control room, multiple monitors glowing, professional operators, dramatic lighting'],
  ['director', 'a conference director with a headset studying a large screen in a dark control room, focused and authoritative'],
  ['stage manager', 'a stage manager backstage with a clipboard and headset, theatrical lighting from wings, dramatic shadows'],
  ['signage', 'a modern conference venue hallway with large glowing digital display screens, wide architectural shot, dark atmosphere'],
  ['digital signage', 'a row of large professional digital signage screens in a conference venue lobby, warm ambient lighting'],
];

const STYLE = 'cinematic photography, dark moody atmospheric, editorial quality, professional, no text, no logos, no UI elements, photorealistic, shallow depth of field';

function buildPrompt(angles) {
  const lower = angles.toLowerCase();
  for (const [keyword, description] of TOPIC_MAP) {
    if (lower.includes(keyword)) {
      return `${STYLE}, ${description}`;
    }
  }
  return `${STYLE}, a professional live conference event in a large modern venue, wide establishing shot, dramatic atmospheric lighting`;
}

// --- DALL-E 3 API call ---------------------------------------------------------

async function generateImage(prompt, outputPath) {
  const label = outputPath.split('/content/').pop() || outputPath;
  console.log(`\nGenerating: ${label}`);

  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'dall-e-3',
      prompt,
      n: 1,
      size: '1792x1024',
      response_format: 'url',
      quality: 'standard',
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI API error (${res.status}): ${err}`);
  }

  const data = await res.json();
  const url = data.data[0].url;

  const imgRes = await fetch(url);
  if (!imgRes.ok) throw new Error('Failed to download image from OpenAI');

  const buffer = await imgRes.arrayBuffer();
  writeFileSync(outputPath, Buffer.from(buffer));
  console.log('  Saved');
}

// --- Blog image mode -----------------------------------------------------------

async function generateBlogImage(slug) {
  const postDir = join(MARKETING, 'content/posts', slug);
  if (!existsSync(postDir)) {
    console.error(`Blog post directory not found: ${postDir}`);
    process.exit(1);
  }

  const outputPath = join(postDir, 'featuredImage.png');
  if (existsSync(outputPath)) {
    console.log(`Featured image already exists for "${slug}" — delete it to regenerate.`);
    return;
  }

  const prompt = buildPrompt(slug.replace(/-/g, ' '));
  await generateImage(prompt, outputPath);
  console.log(`\nDone: content/posts/${slug}/featuredImage.png`);
}

// --- Social images for the week ------------------------------------------------

async function generateWeekImages() {
  const { weekDate, days } = parseCalendar();

  const weekSlug = weekDate.replace(/,/g, '').replace(/\s+/g, '-').toLowerCase();
  const outDir = join(MARKETING, 'content/social/images', weekSlug);
  mkdirSync(outDir, { recursive: true });

  console.log(`Generating images for week: ${weekDate}`);
  console.log(`Output: content/social/images/${weekSlug}/`);

  for (const day of days) {
    const prompt = buildPrompt(day.angles);

    if (day.hasTwitter) {
      const p = join(outDir, `${day.slug}-twitter.png`);
      if (!existsSync(p)) {
        await generateImage(prompt, p);
      } else {
        console.log(`\nSkipping ${day.slug}-twitter.png (already exists)`);
      }
    }

    if (day.hasLinkedIn) {
      const p = join(outDir, `${day.slug}-linkedin.png`);
      if (!existsSync(p)) {
        await generateImage(prompt, p);
      } else {
        console.log(`\nSkipping ${day.slug}-linkedin.png (already exists)`);
      }
    }

    // Auto-generate missing blog featured images
    if (day.blogSlug) {
      const blogImgPath = join(MARKETING, 'content/posts', day.blogSlug, 'featuredImage.png');
      if (!existsSync(blogImgPath)) {
        console.log(`\nGenerating missing featured image for blog: ${day.blogSlug}`);
        await generateImage(buildPrompt(day.blogSlug.replace(/-/g, ' ')), blogImgPath);
      }
    }
  }

  console.log(`\nDone. Images saved to content/social/images/${weekSlug}/`);
}

// --- Entry point ---------------------------------------------------------------

const args = process.argv.slice(2);
const blogIdx = args.indexOf('--blog');

if (blogIdx !== -1) {
  const slug = args[blogIdx + 1];
  if (!slug) {
    console.error('Usage: node scripts/generate-social-images.mjs --blog <post-slug>');
    process.exit(1);
  }
  generateBlogImage(slug).catch((e) => { console.error(e.message); process.exit(1); });
} else {
  generateWeekImages().catch((e) => { console.error(e.message); process.exit(1); });
}
