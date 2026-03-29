# YouTube Playlist Population & Hashtag SEO Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate the existing YouTube playlist with EP01–EP19 and add SEO hashtags to all uploaded video descriptions.

**Architecture:** Two independent tasks. Task 1 uses the already-built `add-all` command. Task 2 adds a new `update-hashtags` command to `manage-playlist.mjs` that fetches each video's current snippet via the YouTube API and patches the description with series + per-episode hashtags.

**Tech Stack:** Node.js ESM, YouTube Data API v3, OAuth2 (tokens already in `yt-tokens.json`)

**Spec:** `docs/superpowers/specs/2026-03-16-youtube-playlist-hashtags-design.md`

---

## Chunk 1: Populate the Playlist

### Task 1: Add all uploaded episodes to the playlist

**Files:**
- Run: `scripts/youtube-pipeline/manage-playlist.mjs` (no code changes)

- [ ] **Step 1: Verify the playlist ID exists**

```bash
cat scripts/youtube-pipeline/playlist-id.json
```
Expected output: JSON with `playlistId` field set (not empty).

- [ ] **Step 2: Run add-all**

```bash
cd /Users/sheriff/Downloads/AVE\ Production\ Console
node scripts/youtube-pipeline/manage-playlist.mjs add-all
```

Expected output: 19 lines of `✓ Ep NN added to playlist`, then `✓ All 19 videos added to playlist.`

- [ ] **Step 3: Verify playlist contents**

```bash
node scripts/youtube-pipeline/manage-playlist.mjs list
```

Expected: 19 videos listed in order EP01–EP19.

- [ ] **Step 4: Commit**

```bash
git add scripts/youtube-pipeline/playlist-id.json
git commit -m "chore: populate youtube playlist with EP01-EP19"
```

---

## Chunk 2: Hashtag Update Command

### Task 2: Add `update-hashtags` command to `manage-playlist.mjs`

**Files:**
- Modify: `scripts/youtube-pipeline/manage-playlist.mjs`

#### Per-episode hashtag map

This map must be added near the top of the file (after the `PLAYLIST_TITLE` const):

```js
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
```

- [ ] **Step 1: Add the hashtag constants**

Open `scripts/youtube-pipeline/manage-playlist.mjs`.

After line `const PLAYLIST_DESC = \`...\`;` (around line 32), add the two constants above.

- [ ] **Step 2: Add the `updateHashtags` function**

Add this function before `// Main`:

```js
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
```

- [ ] **Step 3: Wire up the new command in `main()`**

In the `switch (cmd)` block, add before `default:`:

```js
case 'update-hashtags':
  await updateHashtags();
  break;
```

Also add to the `default:` help text:

```js
console.error('  manage-playlist.mjs update-hashtags  Add SEO hashtags to all video descriptions');
```

- [ ] **Step 4: Dry-run verify (read-only check)**

Before running the update, verify the fetch works by temporarily logging the first video's current description:

```bash
node -e "
import('./scripts/youtube-pipeline/manage-playlist.mjs').catch(() => {});
" 2>&1 | head -5
```

Actually, just run the command — it's idempotent. If it fails, the error will be clear.

- [ ] **Step 5: Run update-hashtags**

```bash
cd /Users/sheriff/Downloads/AVE\ Production\ Console
node scripts/youtube-pipeline/manage-playlist.mjs update-hashtags
```

Expected output:
```
Updating hashtags on 19 video(s)...

  ✓ Ep 01: hashtags added
  ✓ Ep 02: hashtags added
  ...
  ✓ Ep 19: hashtags added

Done. 19 updated, 0 skipped.
```

- [ ] **Step 6: Re-run to verify idempotency**

```bash
node scripts/youtube-pipeline/manage-playlist.mjs update-hashtags
```

Expected: all 19 show `already has hashtags, skipping`. Done: 0 updated, 19 skipped.

- [ ] **Step 7: Spot-check one video in YouTube Studio**

Open `https://studio.youtube.com` → Content → any episode → Details → scroll to bottom of description. Confirm hashtags appear as `#CueDeck #EventManagement #ConferenceProduction #LiveEvents #EventTech` (or episode-specific tags).

- [ ] **Step 8: Commit**

```bash
git add scripts/youtube-pipeline/manage-playlist.mjs
git commit -m "feat: add update-hashtags command for YouTube SEO"
```

---

## Notes

- EP20 and EP21 are not yet uploaded. Once uploaded, run `update-hashtags` again — it will only patch the new videos (idempotent).
- The `videos.update` API requires the full `snippet` object to be sent (not just the changed fields) — the implementation handles this by spreading `...snippet` and overriding only `description`.
- YouTube shows the last 3 hashtags in the video chips above the title. With 5 hashtags per video, YouTube will pick the most relevant 3.
