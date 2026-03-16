#!/usr/bin/env node
/**
 * CueDeck YouTube Playlist Manager
 * Creates and manages the tutorial series playlist on YouTube.
 *
 * Usage:
 *   node scripts/youtube-pipeline/manage-playlist.mjs create         # create playlist
 *   node scripts/youtube-pipeline/manage-playlist.mjs add 1          # add ep 1 to playlist
 *   node scripts/youtube-pipeline/manage-playlist.mjs add-all        # add all uploaded eps
 *   node scripts/youtube-pipeline/manage-playlist.mjs list           # show playlist contents
 *
 * Requires: yt-tokens.json (from upload-youtube.mjs --auth)
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const TOKENS_FILE = resolve(__dirname, 'yt-tokens.json');
const IDS_FILE = resolve(__dirname, 'video-ids.json');
const PLAYLIST_FILE = resolve(__dirname, 'playlist-id.json');
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_BASE = 'https://www.googleapis.com/youtube/v3';

const PLAYLIST_TITLE = 'CueDeck Complete Tutorial Series';
const PLAYLIST_DESC = `The complete walkthrough of CueDeck — the realtime production console for live conferences and events. From creating your first event to running AI-assisted production, every feature covered in depth.

New episode every week.

🚀 Try CueDeck free → https://app.cuedeck.io`;

const SERIES_HASHTAGS = '#CueDeck #EventManagement #ConferenceProduction';

const EP_HASHTAGS = {
  1:  '#LiveEvents #EventTech',
  2:  '#LiveEvents #EventPlanning',
  3:  '#LiveEvents #StageManagement',
  4:  '#EventTeam #LiveEvents',
  5:  '#LiveEvents #EventCommunication',
  6:  '#EventScheduling #LiveEvents',
  7:  '#DigitalSignage #EventSignage',
  8:  '#DigitalSignage #EventSignage',
  9:  '#StageManagement #EventTech',
  10: '#StageManagement #SpeakerTimer',
  11: '#ArtificialIntelligence #EventAI',
  12: '#ArtificialIntelligence #EventAI',
  13: '#ArtificialIntelligence #EventAI',
  14: '#DigitalSignage #EventScheduling',
  15: '#EventSponsors #DigitalSignage',
  16: '#EventAnalytics #EventPlanning',
  17: '#ProductivityTips #PowerUser',
  18: '#iPadApp #MobileApp',
  19: '#EventTech #SaaS',
  20: '#LiveEvents #EventPlanning',
  21: '#LiveEvents #EventTech',
};

// Get valid access token
async function getAccessToken() {
  if (!existsSync(TOKENS_FILE)) {
    console.error('Not authenticated. Run upload-youtube.mjs --auth first.');
    process.exit(1);
  }

  const tokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  const obtained = new Date(tokens.obtained_at).getTime();
  const expiresIn = (tokens.expires_in || 3600) * 1000;

  if (Date.now() > obtained + expiresIn - 300000) {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: tokens.refresh_token,
        client_id: tokens.client_id,
        client_secret: tokens.client_secret,
        grant_type: 'refresh_token',
      }),
    });
    const newTokens = await resp.json();
    if (newTokens.error) {
      console.error('Token refresh failed. Re-run upload-youtube.mjs --auth');
      process.exit(1);
    }
    tokens.access_token = newTokens.access_token;
    tokens.expires_in = newTokens.expires_in;
    tokens.obtained_at = new Date().toISOString();
    writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  }

  return tokens.access_token;
}

// API helper
async function ytApi(path, method, body) {
  const token = await getAccessToken();
  const opts = {
    method: method || 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const resp = await fetch(`${API_BASE}${path}`, opts);
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`YouTube API error ${resp.status}: ${err}`);
  }
  return resp.json();
}

// Create playlist
async function createPlaylist() {
  console.log('Creating playlist...');
  const result = await ytApi('/playlists?part=snippet,status', 'POST', {
    snippet: {
      title: PLAYLIST_TITLE,
      description: PLAYLIST_DESC,
      defaultLanguage: 'en',
    },
    status: {
      privacyStatus: 'public',
    },
  });

  const playlistId = result.id;
  writeFileSync(PLAYLIST_FILE, JSON.stringify({
    playlistId,
    url: `https://www.youtube.com/playlist?list=${playlistId}`,
    createdAt: new Date().toISOString(),
  }, null, 2));

  console.log(`✓ Playlist created: ${PLAYLIST_TITLE}`);
  console.log(`  ID: ${playlistId}`);
  console.log(`  URL: https://www.youtube.com/playlist?list=${playlistId}`);
  return playlistId;
}

// Add video to playlist
async function addToPlaylist(epNumber) {
  if (!existsSync(IDS_FILE)) {
    console.error('No video IDs found. Upload videos first.');
    process.exit(1);
  }

  let playlistId;
  if (existsSync(PLAYLIST_FILE)) {
    playlistId = JSON.parse(readFileSync(PLAYLIST_FILE, 'utf8')).playlistId;
  } else {
    console.log('No playlist found. Creating one first...');
    playlistId = await createPlaylist();
  }

  const ids = JSON.parse(readFileSync(IDS_FILE, 'utf8'));
  const pad = String(epNumber).padStart(2, '0');
  const entry = ids[`ep${pad}`];

  if (!entry) {
    console.error(`No video ID for episode ${epNumber}. Upload it first.`);
    return;
  }

  console.log(`Adding Ep ${pad} to playlist...`);
  await ytApi('/playlistItems?part=snippet', 'POST', {
    snippet: {
      playlistId,
      resourceId: {
        kind: 'youtube#video',
        videoId: entry.videoId,
      },
    },
  });

  console.log(`✓ Ep ${pad} added to playlist (position ${epNumber})`);
}

// Add all uploaded videos to playlist
async function addAllToPlaylist() {
  if (!existsSync(IDS_FILE)) {
    console.error('No video IDs found. Upload videos first.');
    process.exit(1);
  }

  const ids = JSON.parse(readFileSync(IDS_FILE, 'utf8'));
  const episodes = Object.keys(ids)
    .map(k => parseInt(k.replace('ep', '')))
    .sort((a, b) => a - b);

  console.log(`Adding ${episodes.length} video(s) to playlist...\n`);

  for (const ep of episodes) {
    await addToPlaylist(ep);
  }

  console.log(`\n✓ All ${episodes.length} videos added to playlist.`);
}

// List playlist contents
async function listPlaylist() {
  if (!existsSync(PLAYLIST_FILE)) {
    console.error('No playlist found. Run: manage-playlist.mjs create');
    process.exit(1);
  }

  const { playlistId } = JSON.parse(readFileSync(PLAYLIST_FILE, 'utf8'));
  console.log(`Playlist: ${PLAYLIST_TITLE}`);
  console.log(`URL: https://www.youtube.com/playlist?list=${playlistId}\n`);

  let pageToken = '';
  let position = 0;

  do {
    const result = await ytApi(
      `/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=50${pageToken ? `&pageToken=${pageToken}` : ''}`
    );

    for (const item of result.items || []) {
      position++;
      const title = item.snippet.title;
      const videoId = item.snippet.resourceId.videoId;
      console.log(`  ${String(position).padStart(2)}. ${title}`);
      console.log(`      https://www.youtube.com/watch?v=${videoId}`);
    }

    pageToken = result.nextPageToken || '';
  } while (pageToken);

  if (position === 0) console.log('  (empty playlist)');
  console.log(`\nTotal: ${position} video(s)`);
}

// Add/update hashtags on all uploaded videos
async function updateHashtags() {
  if (!existsSync(IDS_FILE)) {
    console.error('No video IDs found. Upload videos first.');
    process.exit(1);
  }

  const ids = JSON.parse(readFileSync(IDS_FILE, 'utf8'));
  const episodes = Object.keys(ids)
    .map(k => ({ num: parseInt(k.replace('ep', '')), key: k }))
    .sort((a, b) => a.num - b.num);

  console.log(`Updating hashtags on ${episodes.length} video(s)...\n`);

  let updated = 0;
  let skipped = 0;

  for (const { num, key } of episodes) {
    const videoId = ids[key].videoId;

    // Fetch current snippet
    const result = await ytApi(`/videos?part=snippet&id=${videoId}`);
    const item = result.items && result.items[0];
    if (!item) {
      console.log(`  Ep ${String(num).padStart(2, '0')}: video not found, skipping`);
      skipped++;
      continue;
    }

    const snippet = item.snippet;
    const currentDesc = snippet.description || '';

    // Idempotency: skip if already has hashtags
    if (currentDesc.includes('#CueDeck')) {
      console.log(`  Ep ${String(num).padStart(2, '0')}: already has hashtags, skipping`);
      skipped++;
      continue;
    }

    // Build hashtag line
    const epTags = EP_HASHTAGS[num] || '';
    const hashtagLine = `${SERIES_HASHTAGS} ${epTags}`.trim();
    const newDesc = currentDesc + '\n\n' + hashtagLine;

    // Patch video
    await ytApi('/videos?part=snippet', 'PUT', {
      id: videoId,
      snippet: {
        ...snippet,
        description: newDesc,
      },
    });

    console.log(`  ✓ Ep ${String(num).padStart(2, '0')}: hashtags added`);
    updated++;
  }

  console.log(`\nDone. ${updated} updated, ${skipped} skipped.`);
}

// Main
async function main() {
  const cmd = process.argv[2];

  switch (cmd) {
    case 'create':
      await createPlaylist();
      break;
    case 'add':
      const ep = parseInt(process.argv[3]);
      if (!ep || ep < 1 || ep > 21) {
        console.error('Usage: manage-playlist.mjs add <episode-number>');
        process.exit(1);
      }
      await addToPlaylist(ep);
      break;
    case 'add-all':
      await addAllToPlaylist();
      break;
    case 'list':
      await listPlaylist();
      break;
    case 'update-hashtags':
      await updateHashtags();
      break;
    default:
      console.error('Usage:');
      console.error('  manage-playlist.mjs create           Create the series playlist');
      console.error('  manage-playlist.mjs add <ep>         Add episode to playlist');
      console.error('  manage-playlist.mjs add-all          Add all uploaded episodes');
      console.error('  manage-playlist.mjs list             Show playlist contents');
      console.error('  manage-playlist.mjs update-hashtags  Add SEO hashtags to all video descriptions');
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Playlist operation failed:', err.message);
  process.exit(1);
});
