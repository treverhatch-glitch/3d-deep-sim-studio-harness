# Backups

`npm run learn -- backup` copies everything the studio has learned and decided to a folder you
choose. Point `STUDIO_BACKUP_DIR` at a folder that Google Drive for desktop, Dropbox or OneDrive syncs,
and the HUB backs up once a day.

## What goes in

| Kept | Where it comes from |
| --- | --- |
| Lessons, LEARNED.md, harness notes and the overseer's evaluations | `studio/memory/`, `studio/harness-notes/` |
| The Game Bible, NOT-DOING, storyboard, Director reviews, ideas | `studio/bible/` |
| Plan, vision, decisions, meetings, reviews, Producer log and inbox | `studio/` |
| Reference notes and the experiment registry (not the media) | `studio/references/`, `studio/experiments/` |
| The data-sharing answer | `studio/data-consent.json` |
| Event log, task briefs, last gate run (their only copy off the machine) | `.studio/` |
| The newest 50 playtest reports and 20 screenshots (5 MB cap each) | `qa/reports/` |

Not kept: game code and assets (that's what git is for), downloaded reference videos (point
`STUDIO_REFERENCE_DIR` at its own synced folder if you want them off the machine), keys and `.env`.

## How it saves space

```
<backup folder>/<game>/
  latest/                 plain copies of today's files, and STUDIO-MEMORY.md (everything in one file)
  history/<time>.json     which file had which content at each backup (a few KB)
  objects/ab/<sha256>.gz  each distinct file content once, gzipped
```

A file that didn't change costs nothing on the next backup. The HUB keeps the newest 60 daily
backups plus the first of each month (`STUDIO_BACKUP_KEEP`) and deletes content nothing points to.
Text compresses to roughly a tenth. The example studio's whole backup is about 230 KB; a busy
project with months of events and the screenshot cap stays in the tens of megabytes.

```bash
npm run learn -- backup [--to <folder>] [--no-media]
npm run learn -- restore --from <folder> --to <empty folder> [--at 2026-10-20]
npm run learn -- prune [--from <folder>] [--keep 30]
```

## Keep the folder private

Backups hold your game's plans and the studio's notes. Share the folder with no one: in Google
Drive, Share, then General access, then Restricted. A folder anyone with the link can edit lets
anyone read, delete or plant files in your backups. Keep the folder's link out of the public repo.

## Google Drive on macOS

Drive for desktop mounts at `~/Library/CloudStorage/GoogleDrive-<your account>/My Drive/`. In `.env`:
`STUDIO_BACKUP_DIR=/Users/<you>/Library/CloudStorage/GoogleDrive-<account>/My Drive/<folder name>`

## Google Drive on Windows

1. Install Google Drive for desktop and sign in. Your Drive appears as a drive letter (often `G:`).
2. Find the backup folder under `G:\My Drive\`. If it's in "Shared with me", add a shortcut to My
   Drive first.
3. In the private copy's `.env`: `STUDIO_BACKUP_DIR=G:\My Drive\<folder name>`
4. Run `npm run learn -- backup` once and check the folder appears in Drive.
