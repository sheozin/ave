# CueDeck YouTube Tutorial Pipeline

Automated production pipeline for the 21-episode CueDeck tutorial series.

## Pipeline Steps

```
Scripts → Thumbnails → Voiceover → Demo Recording → Video Assembly → Upload → Playlist → Link Sync
```

| # | Script | What it does | Requires |
|---|--------|-------------|----------|
| 1 | `generate-thumbnails.mjs` | Renders 1280×720 branded thumbnails | Playwright |
| 2 | `generate-voiceover.mjs` | Converts scripts to narration audio | OpenAI API key |
| 3 | `record-demo.mjs` | Automates CueDeck UI + screen records | Playwright, CueDeck running |
| 4 | `assemble-video.mjs` | Combines video + audio into MP4 | ffmpeg |
| 5 | `upload-youtube.mjs` | Uploads to YouTube with metadata | Google OAuth |
| 6 | `manage-playlist.mjs` | Creates/manages series playlist | Google OAuth |
| 7 | `sync-links.mjs` | Updates marketing site + metadata | — |

## Quick Start

```bash
# Generate all thumbnails (no setup needed)
node scripts/youtube-pipeline/generate-thumbnails.mjs

# Full pipeline for one episode
node scripts/youtube-pipeline/produce-tutorial.mjs 1

# Check status of all episodes
node scripts/youtube-pipeline/produce-tutorial.mjs status
```

## Setup

### Thumbnails (ready to use)
No setup needed — uses Playwright (already installed).

### Voiceover
```bash
export OPENAI_API_KEY=sk-...
node scripts/youtube-pipeline/generate-voiceover.mjs 1
```

### YouTube Upload
1. Create Google Cloud project → enable YouTube Data API v3
2. Create OAuth 2.0 credentials (Desktop App)
3. Download `client_secret.json` → `scripts/youtube-pipeline/`
4. Run: `node scripts/youtube-pipeline/upload-youtube.mjs --auth`

### Demo Recording
```bash
# Ensure CueDeck is running
open http://127.0.0.1:7230/cuedeck-console.html
node scripts/youtube-pipeline/record-demo.mjs 1
```

## Output Structure

```
youtube-branding/
  thumbnails/     ep01-thumbnail.png ... ep21-thumbnail.png
  voiceovers/     ep01-voiceover.mp3 ... (+ narration .txt files)
  recordings/     ep01-raw.webm ...
  final/          ep01-final.mp4 ...
```

## Data Files

- `thumbnail-data.json` — colours, text, badges for all 21 thumbnails
- `video-ids.json` — YouTube video IDs (created after upload)
- `playlist-id.json` — playlist ID (created after playlist creation)
