#!/usr/bin/env node
/**
 * sync-blog-posts.mjs
 *
 * Syncs MDX blog posts from cuedeck-marketing/content/posts/ to the
 * Supabase blog_posts table. Only inserts posts that don't exist yet
 * (by slug). Never overwrites existing posts.
 *
 * Usage:
 *   node scripts/sync-blog-posts.mjs
 *   node scripts/sync-blog-posts.mjs --dry-run   (preview without inserting)
 *   node scripts/sync-blog-posts.mjs --force      (update body even if slug exists)
 *
 * Requires in .env:
 *   SUPABASE_URL=https://...supabase.co
 *   SUPABASE_SECRET_KEY=sb_secret_...
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const POSTS_DIR = join(ROOT, 'cuedeck-marketing/content/posts');

// --- Load .env -----------------------------------------------------------

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

const SUPABASE_URL = process.env.SUPABASE_URL;
const SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

if (!SUPABASE_URL || !SECRET_KEY) {
  console.error('\nMissing required env vars. Add to .env:\n');
  if (!SUPABASE_URL) console.error('  SUPABASE_URL=https://sawekpguemzvuvvulfbc.supabase.co');
  if (!SECRET_KEY) console.error('  SUPABASE_SECRET_KEY=sb_secret_...');
  console.error('\nGet your secret key from: Supabase Dashboard → Settings → API Keys → Secret keys\n');
  process.exit(1);
}

// --- Parse MDX frontmatter -----------------------------------------------

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return null;

  const fm = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) fm[m[1].trim()] = m[2].trim();
  }

  const body = match[2].trim();
  return { fm, body };
}

function parseArrayField(val) {
  // Handles: tag1, tag2 or [tag1, tag2]
  return val
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function estimateReadTime(text) {
  const words = text.split(/\s+/).length;
  return Math.max(1, Math.round(words / 200));
}

// --- Discover posts -------------------------------------------------------

function discoverPosts() {
  if (!existsSync(POSTS_DIR)) {
    console.error('Posts directory not found:', POSTS_DIR);
    process.exit(1);
  }

  const posts = [];
  for (const slug of readdirSync(POSTS_DIR)) {
    const mdxPath = join(POSTS_DIR, slug, 'index.mdx');
    if (!existsSync(mdxPath)) continue;

    const raw = readFileSync(mdxPath, 'utf-8');
    const parsed = parseFrontmatter(raw);
    if (!parsed) {
      console.warn(`  Skipping ${slug}: could not parse frontmatter`);
      continue;
    }

    const { fm, body } = parsed;
    const tags = fm.tags ? parseArrayField(fm.tags) : [];
    const readTime = fm.readTime
      ? parseInt(fm.readTime)
      : estimateReadTime(body);

    posts.push({
      slug,
      title: fm.title || slug,
      excerpt: fm.excerpt || '',
      body,
      tags,
      status: 'published',
      read_time_minutes: readTime,
      published_at: fm.date ? new Date(fm.date).toISOString() : new Date().toISOString(),
    });
  }

  return posts;
}

// --- Supabase REST API calls ---------------------------------------------

const HEADERS = {
  Authorization: `Bearer ${SECRET_KEY}`,
  apikey: SECRET_KEY,
  'Content-Type': 'application/json',
};

async function getExistingSlugs() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/blog_posts?select=slug&status=eq.published`,
    { headers: HEADERS }
  );
  if (!res.ok) throw new Error(`Failed to fetch slugs: ${res.status} ${await res.text()}`);
  const rows = await res.json();
  return new Set(rows.map(r => r.slug));
}

async function upsertPost(post, force = false) {
  const payload = {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt,
    content_json: { type: 'markdown', content: post.body },
    cover_image: `/api/content-image/${post.slug}/featuredImage.png`,
    tags: post.tags,
    status: post.status,
    read_time_minutes: post.read_time_minutes,
    published_at: post.published_at,
  };

  const prefer = force
    ? 'resolution=merge-duplicates'
    : 'resolution=ignore-duplicates';

  const res = await fetch(`${SUPABASE_URL}/rest/v1/blog_posts`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: prefer },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Insert failed for ${post.slug}: ${res.status} ${err}`);
  }
  return true;
}

// --- Main ----------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

console.log('\n📝 CueDeck Blog Sync');
console.log('===================');
if (dryRun) console.log('DRY RUN — no changes will be made\n');

const posts = discoverPosts();
console.log(`Found ${posts.length} MDX post(s) in content/posts/\n`);

let existingSlugs;
try {
  existingSlugs = await getExistingSlugs();
} catch (e) {
  console.error('Failed to query Supabase:', e.message);
  process.exit(1);
}

let inserted = 0;
let skipped = 0;
let updated = 0;

for (const post of posts) {
  const exists = existingSlugs.has(post.slug);

  if (exists && !force) {
    console.log(`  ⏭  ${post.slug} — already exists (use --force to update)`);
    skipped++;
    continue;
  }

  const action = exists ? 'Updating' : 'Inserting';
  console.log(`  ${exists ? '✏️ ' : '➕'} ${post.slug} — ${action}...`);

  if (!dryRun) {
    try {
      await upsertPost(post, force);
      exists ? updated++ : inserted++;
      console.log(`     ✅ ${post.title}`);
    } catch (e) {
      console.error(`     ❌ ${e.message}`);
    }
  } else {
    console.log(`     Would ${action.toLowerCase()}: "${post.title}"`);
    exists ? updated++ : inserted++;
  }
}

console.log(`\nDone: ${inserted} inserted, ${updated} updated, ${skipped} skipped`);
if (!dryRun && (inserted + updated) > 0) {
  console.log(`\nPosts live at: https://www.cuedeck.io/blog`);
}
