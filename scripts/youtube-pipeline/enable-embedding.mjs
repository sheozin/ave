#!/usr/bin/env node
/**
 * Enables embedding for all uploaded CueDeck tutorial videos.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLIENT_SECRET = resolve(__dirname, 'client_secret.json');
const TOKENS_FILE = resolve(__dirname, 'yt-tokens.json');
const VIDEO_IDS_FILE = resolve(__dirname, 'video-ids.json');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VIDEOS_URL = 'https://www.googleapis.com/youtube/v3/videos';

async function getAccessToken() {
  const tokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  const { client_id, client_secret, refresh_token } = tokens;

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token, client_id, client_secret }),
  });
  const data = await resp.json();
  if (data.error) throw new Error(`Token refresh failed: ${data.error_description}`);

  // Save updated token
  writeFileSync(TOKENS_FILE, JSON.stringify({ ...tokens, ...data, obtained_at: new Date().toISOString() }, null, 2));
  return data.access_token;
}

async function enableEmbedding(videoId, epKey, accessToken) {
  const resp = await fetch(`${VIDEOS_URL}?part=status`, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      id: videoId,
      status: {
        embeddable: true,
      },
    }),
  });
  const data = await resp.json();
  if (data.error) {
    console.error(`  ✗ ${epKey} failed: ${data.error.message}`);
    return false;
  }
  console.log(`  ✓ ${epKey} (${videoId}) — embedding enabled`);
  return true;
}

(async () => {
  console.log('Enabling embedding for all CueDeck tutorial videos...\n');

  const accessToken = await getAccessToken();
  console.log('  Token refreshed\n');

  const videoIds = JSON.parse(readFileSync(VIDEO_IDS_FILE, 'utf8'));
  let ok = 0, fail = 0;

  for (const [epKey, info] of Object.entries(videoIds)) {
    const success = await enableEmbedding(info.videoId, epKey, accessToken);
    success ? ok++ : fail++;
  }

  console.log(`\nDone: ${ok} enabled, ${fail} failed`);
})();
