#!/usr/bin/env node
/**
 * CueDeck YouTube Publisher
 * Uploads a finished video to YouTube with metadata from the episode data files.
 * Uses YouTube Data API v3 with OAuth2.
 *
 * Setup (one-time):
 *   1. Create a Google Cloud project at https://console.cloud.google.com
 *   2. Enable "YouTube Data API v3"
 *   3. Create OAuth 2.0 credentials (Desktop App)
 *   4. Download client_secret.json → scripts/youtube-pipeline/client_secret.json
 *   5. Run: node scripts/youtube-pipeline/upload-youtube.mjs --auth
 *      This opens a browser for consent and saves tokens to yt-tokens.json
 *
 * Usage:
 *   node scripts/youtube-pipeline/upload-youtube.mjs --auth          # one-time auth
 *   node scripts/youtube-pipeline/upload-youtube.mjs 1               # upload episode 1
 *   node scripts/youtube-pipeline/upload-youtube.mjs 3 --public      # upload as public
 *   node scripts/youtube-pipeline/upload-youtube.mjs 1 --thumbnail   # also set thumbnail
 *
 * Inputs:
 *   youtube-branding/final/ep{NN}-final.mp4        — video file
 *   youtube-branding/thumbnails/ep{NN}-thumbnail.png — thumbnail
 *   scripts/youtube-scripts/metadata.md             — titles, descriptions, tags
 *   scripts/youtube-scripts/metadata-ep06-21.md
 */

import { readFileSync, writeFileSync, existsSync, createReadStream, statSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createServer } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const BRAND_DIR = resolve(ROOT, 'youtube-branding');
const SCRIPTS_DIR = resolve(ROOT, 'scripts/youtube-scripts');
const CLIENT_SECRET = resolve(__dirname, 'client_secret.json');
const TOKENS_FILE = resolve(__dirname, 'yt-tokens.json');

// Parse args
const args = process.argv.slice(2);
const doAuth = args.includes('--auth');
const isPublic = args.includes('--public');
const setThumb = args.includes('--thumbnail');
const allMode = args.includes('--all');
const startArg = args.find(a => a.startsWith('--start='));
const startFrom = startArg ? parseInt(startArg.split('=')[1]) : 1;
const epArg = args.find(a => !a.startsWith('--') && /^\d+$/.test(a));
const epNum = epArg ? parseInt(epArg) : null;

// YouTube API endpoints
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const THUMB_URL = 'https://www.googleapis.com/youtube/v3/thumbnails/set';
const SCOPES = 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube';

// Load episode metadata from markdown files
function loadMetadata(ep) {
  const files = [
    resolve(SCRIPTS_DIR, 'metadata.md'),
    resolve(SCRIPTS_DIR, 'metadata-ep06-21.md'),
  ];

  for (const file of files) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, 'utf8');

    // Find the episode section
    const epPad = String(ep).padStart(2, '0');
    const regex = new RegExp(`## Episode ${epPad}[^]*?(?=## Episode \\d|## SERIES|$)`, 's');
    const match = content.match(regex);
    if (!match) continue;

    const section = match[0];

    // Extract title
    const titleMatch = section.match(/\*\*Title:\*\*\s*\n`([^`]+)`/);
    const title = titleMatch ? titleMatch[1] : `CueDeck Tutorial #${ep}`;

    // Extract description
    const descMatch = section.match(/\*\*Description:\*\*\s*\n```\n([\s\S]*?)\n```/);
    const description = descMatch ? descMatch[1].trim() : '';

    // Extract tags
    const tagMatch = section.match(/\*\*Tags:\*\*\s*\n`([^`]+)`/);
    const tags = tagMatch ? tagMatch[1].split(',').map(t => t.trim()) : [];

    return { title, description, tags };
  }

  return {
    title: `CueDeck Tutorial #${ep}`,
    description: 'CueDeck tutorial episode',
    tags: ['cuedeck', 'tutorial'],
  };
}

// OAuth2 flow
async function authenticate() {
  if (!existsSync(CLIENT_SECRET)) {
    console.error('Missing client_secret.json');
    console.error('Download OAuth 2.0 credentials from Google Cloud Console');
    console.error(`Expected at: ${CLIENT_SECRET}`);
    process.exit(1);
  }

  const creds = JSON.parse(readFileSync(CLIENT_SECRET, 'utf8'));
  const { client_id, client_secret } = creds.installed || creds.web;
  const redirect_uri = 'http://localhost:9876/callback';

  // Build auth URL
  const authUrl = `${AUTH_URL}?client_id=${client_id}&redirect_uri=${encodeURIComponent(redirect_uri)}&response_type=code&scope=${encodeURIComponent(SCOPES)}&access_type=offline&prompt=consent`;

  console.log('\nOpen this URL in your browser to authorize:\n');
  console.log(authUrl);
  console.log('\nWaiting for callback...');

  // Start local server to receive callback
  const code = await new Promise((res, rej) => {
    const server = createServer((req, resp) => {
      const url = new URL(req.url, `http://localhost:9876`);
      const code = url.searchParams.get('code');
      if (code) {
        resp.writeHead(200, { 'Content-Type': 'text/html' });
        resp.end('<h1>Authorized! You can close this tab.</h1>');
        server.close();
        res(code);
      } else {
        resp.writeHead(400);
        resp.end('Missing code parameter');
      }
    });
    server.listen(9876);
    server.on('error', rej);

    // Open browser
    import('child_process').then(({ execFileSync }) => {
      try { execFileSync('open', [authUrl]); } catch {}
    });
  });

  // Exchange code for tokens
  const tokenResp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenResp.json();
  if (tokens.error) {
    console.error('Token exchange failed:', tokens.error_description);
    process.exit(1);
  }

  // Save tokens
  writeFileSync(TOKENS_FILE, JSON.stringify({
    ...tokens,
    client_id,
    client_secret,
    obtained_at: new Date().toISOString(),
  }, null, 2));

  console.log('\n✓ Tokens saved to yt-tokens.json');
  console.log('You can now upload videos.');
}

// Get valid access token (refresh if expired)
async function getAccessToken() {
  if (!existsSync(TOKENS_FILE)) {
    console.error('Not authenticated. Run with --auth first.');
    process.exit(1);
  }

  const tokens = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
  const obtained = new Date(tokens.obtained_at).getTime();
  const expiresIn = (tokens.expires_in || 3600) * 1000;
  const now = Date.now();

  // Refresh if token is expired or about to expire (5 min buffer)
  if (now > obtained + expiresIn - 300000) {
    console.log('  Refreshing access token...');
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
      console.error('Token refresh failed:', newTokens.error_description);
      console.error('Re-run with --auth to re-authenticate.');
      process.exit(1);
    }

    tokens.access_token = newTokens.access_token;
    tokens.expires_in = newTokens.expires_in;
    tokens.obtained_at = new Date().toISOString();
    writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
  }

  return tokens.access_token;
}

// Upload video
async function uploadVideo(epNumber) {
  const pad = String(epNumber).padStart(2, '0');
  const videoPath = resolve(BRAND_DIR, `final/ep${pad}-final.mp4`);
  const thumbPath = resolve(BRAND_DIR, `thumbnails/ep${pad}-thumbnail.png`);

  if (!existsSync(videoPath)) {
    throw new Error(`Missing video: ${videoPath}`);
  }

  const meta = loadMetadata(epNumber);
  const accessToken = await getAccessToken();
  const fileSize = statSync(videoPath).size;
  const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);

  console.log(`\nUploading Episode ${pad}...`);
  console.log(`  Title: ${meta.title}`);
  console.log(`  Tags: ${meta.tags.slice(0, 5).join(', ')}...`);
  console.log(`  File: ${fileSizeMB} MB`);
  console.log(`  Privacy: ${isPublic ? 'public' : 'unlisted'}\n`);

  // Step 1: Initiate resumable upload
  const initResp = await fetch(`${UPLOAD_URL}?uploadType=resumable&part=snippet,status`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'X-Upload-Content-Length': String(fileSize),
      'X-Upload-Content-Type': 'video/mp4',
    },
    body: JSON.stringify({
      snippet: {
        title: meta.title,
        description: meta.description,
        tags: meta.tags,
        categoryId: '28', // Science & Technology
        defaultLanguage: 'en',
      },
      status: {
        privacyStatus: isPublic ? 'public' : 'unlisted',
        selfDeclaredMadeForKids: false,
      },
    }),
  });

  if (!initResp.ok) {
    const err = await initResp.text();
    throw new Error(`Upload init failed: ${err}`);
  }

  const uploadUrl = initResp.headers.get('location');
  console.log('  ✓ Upload session initiated');

  // Step 2: Upload the file
  console.log('  Uploading video...');
  const videoBuffer = readFileSync(videoPath);
  const uploadResp = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileSize),
    },
    body: videoBuffer,
  });

  if (!uploadResp.ok) {
    const err = await uploadResp.text();
    throw new Error(`Upload failed: ${err}`);
  }

  const result = await uploadResp.json();
  const videoId = result.id;
  console.log(`  ✓ Video uploaded! ID: ${videoId}`);
  console.log(`  URL: https://www.youtube.com/watch?v=${videoId}`);

  // Step 3: Set thumbnail if requested
  if (setThumb && existsSync(thumbPath)) {
    console.log('  Setting custom thumbnail...');
    const thumbBuffer = readFileSync(thumbPath);
    const thumbResp = await fetch(`${THUMB_URL}?videoId=${videoId}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'image/png',
      },
      body: thumbBuffer,
    });

    if (thumbResp.ok) {
      console.log('  ✓ Thumbnail set');
    } else {
      console.log('  ⚠ Thumbnail upload failed (may need channel verification)');
    }
  }

  // Save video ID for later reference
  const idsFile = resolve(__dirname, 'video-ids.json');
  let ids = {};
  if (existsSync(idsFile)) {
    ids = JSON.parse(readFileSync(idsFile, 'utf8'));
  }
  ids[`ep${pad}`] = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    uploadedAt: new Date().toISOString(),
  };
  writeFileSync(idsFile, JSON.stringify(ids, null, 2));

  return videoId;
}

// Main
async function main() {
  if (doAuth) {
    await authenticate();
    return;
  }

  if (!allMode && (!epNum || epNum < 1 || epNum > 21)) {
    console.error('Usage:');
    console.error('  node upload-youtube.mjs --auth           # one-time auth setup');
    console.error('  node upload-youtube.mjs <ep> [options]   # upload episode');
    console.error('  node upload-youtube.mjs --all [options]  # upload all 21 episodes');
    console.error('');
    console.error('Options:');
    console.error('  --public       Upload as public (default: unlisted)');
    console.error('  --thumbnail    Also set custom thumbnail');
    console.error('  --all          Upload all episodes 1-21');
    console.error('  --start=N      Start from episode N (with --all)');
    process.exit(1);
  }

  const episodes = allMode ? Array.from({ length: 21 - startFrom + 1 }, (_, i) => i + startFrom) : [epNum];
  let ok = 0, fail = 0;

  for (const ep of episodes) {
    try {
      await uploadVideo(ep);
      ok++;
    } catch (err) {
      console.error(`\n✗ Episode ${ep} failed: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nUpload complete: ${ok} succeeded, ${fail} failed`);
}

main().catch(err => {
  console.error('Upload failed:', err.message);
  process.exit(1);
});
