# YouTube Playlist Population & Hashtag SEO — Design Spec

**Date:** 2026-03-16
**Status:** Approved

## Summary

Two tasks:
1. Populate the existing YouTube playlist with all uploaded episodes (EP01–EP19)
2. Add SEO hashtags to every uploaded video's description (Option B: 3 fixed + 2 per-episode)

EP20 and EP21 are not yet uploaded and will be handled separately once quota allows.

---

## Task 1 — Playlist Population

The playlist already exists (`playlist-id.json`, created Mar 12):
- ID: `PLwpbeJtHyHMk8RH5MuSA4IkjVkSAhBoQu`
- URL: `https://www.youtube.com/playlist?list=PLwpbeJtHyHMk8RH5MuSA4IkjVkSAhBoQu`

**Action:** Run the existing `add-all` command — no code changes needed.

```bash
node scripts/youtube-pipeline/manage-playlist.mjs add-all
```

---

## Task 2 — Hashtag Update

### Approach
Add `update-hashtags` command to `manage-playlist.mjs`. For each video in `video-ids.json`:
1. Fetch current snippet via `GET /youtube/v3/videos?part=snippet`
2. Skip if hashtags already appended (idempotent check)
3. Append hashtag block to bottom of description
4. Save via `PATCH /youtube/v3/videos?part=snippet`

### Hashtag Schema (Option B)

**3 fixed series tags** on every episode:
```
#CueDeck #EventManagement #ConferenceProduction
```

**2 per-episode tags:**

| Episode | Topic | Extra Tags |
|---------|-------|-----------|
| EP01 | Welcome & Overview | `#LiveEvents #EventTech` |
| EP02 | Create Your First Event | `#LiveEvents #EventPlanning` |
| EP03 | Running a Live Event | `#LiveEvents #StageManagement` |
| EP04 | Roles & Team | `#EventTeam #LiveEvents` |
| EP05 | Broadcast Bar | `#LiveEvents #EventCommunication` |
| EP06 | Delay Cascade | `#EventScheduling #LiveEvents` |
| EP07 | Digital Signage Setup | `#DigitalSignage #EventSignage` |
| EP08 | All 11 Display Modes | `#DigitalSignage #EventSignage` |
| EP09 | Stage Confidence Monitor | `#StageManagement #EventTech` |
| EP10 | Stage Timer | `#StageManagement #SpeakerTimer` |
| EP11 | AI Incident Advisor | `#ArtificialIntelligence #EventAI` |
| EP12 | AI Cue Engine | `#ArtificialIntelligence #EventAI` |
| EP13 | AI Report Generator | `#ArtificialIntelligence #EventAI` |
| EP14 | Timeline & Programme | `#DigitalSignage #EventScheduling` |
| EP15 | Sponsor Logos | `#EventSponsors #DigitalSignage` |
| EP16 | Event Log & Report | `#EventAnalytics #EventPlanning` |
| EP17 | Keyboard Shortcuts | `#ProductivityTips #PowerUser` |
| EP18 | Mobile & Tablet | `#iPadApp #MobileApp` |
| EP19 | Billing & Plans | `#EventTech #SaaS` |
| EP20 | Multi-Room Events | `#LiveEvents #EventPlanning` |
| EP21 | Full Walkthrough | `#LiveEvents #EventTech` |

### Description append format
```
\n\n#CueDeck #EventManagement #ConferenceProduction #LiveEvents #EventTech
```
(blank line separator, all on one line — YouTube renders these as chips)

---

## Implementation Scope

- **File changed:** `scripts/youtube-pipeline/manage-playlist.mjs` only
- **New command:** `update-hashtags` — fetches + patches all uploaded videos
- **Idempotent:** checks for `#CueDeck` presence before appending

## Usage After Implementation

```bash
# Step 1: add all episodes to playlist
node scripts/youtube-pipeline/manage-playlist.mjs add-all

# Step 2: add hashtags to all video descriptions
node scripts/youtube-pipeline/manage-playlist.mjs update-hashtags
```
