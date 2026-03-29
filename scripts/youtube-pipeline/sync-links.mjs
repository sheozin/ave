#!/usr/bin/env node
/**
 * CueDeck Link Sync Agent
 * Updates the marketing site tutorials page and metadata files with actual YouTube URLs.
 *
 * Reads video IDs from video-ids.json and playlist ID from playlist-id.json,
 * then updates:
 *   1. cuedeck-marketing/app/tutorials/page.tsx — swap "Coming soon" → YouTube embed links
 *   2. scripts/youtube-scripts/metadata.md — replace [PLAYLIST LINK] and [EPn LINK] placeholders
 *   3. scripts/youtube-scripts/metadata-ep06-21.md — same placeholder replacement
 *
 * Usage:
 *   node scripts/youtube-pipeline/sync-links.mjs            # update all
 *   node scripts/youtube-pipeline/sync-links.mjs --dry-run   # preview changes only
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const IDS_FILE = resolve(__dirname, 'video-ids.json');
const PLAYLIST_FILE = resolve(__dirname, 'playlist-id.json');
const TUTORIALS_PAGE = resolve(ROOT, 'cuedeck-marketing/app/tutorials/page.tsx');
const METADATA_FILES = [
  resolve(ROOT, 'scripts/youtube-scripts/metadata.md'),
  resolve(ROOT, 'scripts/youtube-scripts/metadata-ep06-21.md'),
];

const dryRun = process.argv.includes('--dry-run');

function loadVideoIds() {
  if (!existsSync(IDS_FILE)) return {};
  return JSON.parse(readFileSync(IDS_FILE, 'utf8'));
}

function loadPlaylistId() {
  if (!existsSync(PLAYLIST_FILE)) return null;
  const data = JSON.parse(readFileSync(PLAYLIST_FILE, 'utf8'));
  return data.url || null;
}

// Update metadata markdown files — replace placeholder links
function updateMetadataFiles(videoIds, playlistUrl) {
  let totalReplacements = 0;

  for (const filePath of METADATA_FILES) {
    if (!existsSync(filePath)) continue;

    let content = readFileSync(filePath, 'utf8');
    let changes = 0;

    // Replace [PLAYLIST LINK]
    if (playlistUrl && content.includes('[PLAYLIST LINK]')) {
      const count = (content.match(/\[PLAYLIST LINK\]/g) || []).length;
      content = content.replace(/\[PLAYLIST LINK\]/g, playlistUrl);
      changes += count;
    }

    // Replace [EPn LINK] placeholders
    for (let ep = 1; ep <= 21; ep++) {
      const pad = String(ep).padStart(2, '0');
      const entry = videoIds[`ep${pad}`];
      if (!entry) continue;

      const patterns = [
        `[EP${ep} LINK]`,
        `[EP${pad} LINK]`,
      ];

      for (const pattern of patterns) {
        if (content.includes(pattern)) {
          content = content.split(pattern).join(entry.url);
          changes++;
        }
      }
    }

    if (changes > 0) {
      if (dryRun) {
        console.log(`  [DRY RUN] ${filePath}: ${changes} replacement(s)`);
      } else {
        writeFileSync(filePath, content);
        console.log(`  ✓ ${filePath}: ${changes} replacement(s)`);
      }
      totalReplacements += changes;
    }
  }

  return totalReplacements;
}

// Update tutorials page — replace "Coming soon" status with YouTube links
function updateTutorialsPage(videoIds) {
  if (!existsSync(TUTORIALS_PAGE)) {
    console.log('  ⚠ Tutorials page not found');
    return 0;
  }

  let content = readFileSync(TUTORIALS_PAGE, 'utf8');
  let changes = 0;

  // The tutorials page has episodes defined in a data array.
  // For each uploaded episode, we need to:
  // 1. Update the status from 'coming-soon' to 'published' or add a youtubeUrl
  // 2. Replace placeholder text

  for (const [key, entry] of Object.entries(videoIds)) {
    const epNum = parseInt(key.replace('ep', ''));
    const pad = String(epNum).padStart(2, '0');

    // Look for patterns like: status: 'coming-soon' near the episode number
    // or youtubeUrl: null/undefined

    // Pattern: Find the episode entry and add/update youtubeUrl
    // This is page-structure dependent, so we use a flexible regex
    const youtubeUrlPattern = new RegExp(
      `(ep:\\s*${epNum}[^}]*?)youtubeUrl:\\s*(?:null|undefined|'')`,
      's'
    );

    if (youtubeUrlPattern.test(content)) {
      content = content.replace(
        youtubeUrlPattern,
        `$1youtubeUrl: '${entry.url}'`
      );
      changes++;
    }

    // Also try: replace 'Coming soon' text near the episode
    // Pattern: status text shown for the episode
    const comingSoonPattern = new RegExp(
      `(ep${pad}[^]*?)'Coming soon'`,
      's'
    );
    // This is fragile — better to update the data structure directly
  }

  if (changes > 0) {
    if (dryRun) {
      console.log(`  [DRY RUN] ${TUTORIALS_PAGE}: ${changes} replacement(s)`);
    } else {
      writeFileSync(TUTORIALS_PAGE, content);
      console.log(`  ✓ ${TUTORIALS_PAGE}: ${changes} replacement(s)`);
    }
  } else {
    console.log('  ℹ Tutorials page: no automatic replacements (may need manual update)');
    console.log('    Video URLs for manual update:');
    for (const [key, entry] of Object.entries(videoIds)) {
      console.log(`    ${key}: ${entry.url}`);
    }
  }

  return changes;
}

// Generate a summary of all links
function printSummary(videoIds, playlistUrl) {
  console.log('\n--- Link Summary ---\n');

  if (playlistUrl) {
    console.log(`Playlist: ${playlistUrl}`);
  } else {
    console.log('Playlist: (not created yet)');
  }

  console.log('');

  const sorted = Object.entries(videoIds).sort(([a], [b]) => a.localeCompare(b));
  for (const [key, entry] of sorted) {
    const epNum = parseInt(key.replace('ep', ''));
    console.log(`  Ep ${String(epNum).padStart(2, '0')}: ${entry.url}`);
  }

  if (sorted.length === 0) {
    console.log('  (no videos uploaded yet)');
  }

  console.log('');
}

async function main() {
  console.log(`CueDeck Link Sync${dryRun ? ' [DRY RUN]' : ''}\n`);

  const videoIds = loadVideoIds();
  const playlistUrl = loadPlaylistId();
  const uploadedCount = Object.keys(videoIds).length;

  console.log(`Found ${uploadedCount} uploaded video(s)`);
  console.log(`Playlist: ${playlistUrl || '(not created)'}\n`);

  if (uploadedCount === 0 && !playlistUrl) {
    console.log('Nothing to sync. Upload videos and create a playlist first.');
    process.exit(0);
  }

  // Update metadata files
  console.log('Updating metadata files:');
  const metaChanges = updateMetadataFiles(videoIds, playlistUrl);

  // Update tutorials page
  console.log('\nUpdating tutorials page:');
  const pageChanges = updateTutorialsPage(videoIds);

  // Print summary
  printSummary(videoIds, playlistUrl);

  const total = metaChanges + pageChanges;
  if (dryRun) {
    console.log(`Would make ${total} replacement(s). Run without --dry-run to apply.`);
  } else {
    console.log(`✓ ${total} replacement(s) applied.`);
  }
}

main().catch(err => {
  console.error('Link sync failed:', err.message);
  process.exit(1);
});
