# Hypermobility MD / Bendy Bodies Podcast

Eleventy static site for Dr. Linda Bluestein's medical practice and the Bendy
Bodies Podcast. Deployed to GitHub Pages.

## Deploy & automation

GitHub Actions, all on `master`:

- **`deploy.yml`** — builds and deploys to GitHub Pages on every push.
- **`sync-podcast.yml`** — cron every 6 hours: runs `scripts/sync-rss.mjs`,
  commits new episodes as `github-actions[bot]`, pushes, and deploys. New
  episodes publish ~weekly, so this is effectively the weekly content update.
- **`transcribe-podcast.yml`**, **`sync-guest-profile-images.yml`** — further
  scheduled jobs that commit transcripts / guest images.

**Consequence: `master` moves on its own.** Bot commits land between sessions.
Always `git fetch` before committing, and expect to rebase. When asked to
"commit and push," check `git rev-list --count master...origin/master` first.

GitHub Pages has no server-side redirects (no real 301s) — see Episode URLs.

## Content pipeline

Episodes are markdown in `src/episodes/` (`{num}.md`, body = transcript).
They arrive two ways:

- **Sveltia CMS** at `/admin/` — commits straight to `master` (commit messages
  like `Update Podcast Episodes "196"`).
- **`scripts/sync-rss.mjs`** — pulls from the Megaphone RSS feed, extracts
  guests via Haiku, and backfills YouTube video URLs by matching the podcast
  publish date to the video upload date (titles often lack episode numbers, so
  date is the primary key; number is a fallback).

Other `scripts/*.mjs` handle transcription, speaker labeling, transcript
formatting, OG images, taxonomy, etc.

## Episode URLs

Permalink is computed in `src/episodes/episodes.11tydata.js`:
`/episodes/{num}-{title-slug}/` for numbered episodes, file slug for bonus
episodes. Filenames stay `{num}.md` — the CMS and sync script never need to
know about URLs.

`src/episode-redirects.11ty.js` emits a meta-refresh + canonical stub at every
old `/episodes/{num}/` path, generated from the episodes collection at build
time (so new episodes get one automatically). All internal links use the
canonical slug URL — the stubs are only for old external/inbound links.

## Forms

Native HTML forms (`contact`, `ask`, `book`, `guest-form`, `feedback-form`)
POST JSON to a Google Apps Script that appends rows to a Google Sheet. The
script auto-detects columns from the payload, so adding/removing a form field
usually needs no script change — only the form's inline JS.

`google-apps-script-v2.js` is **gitignored**. It can't be committed; changes
to it must be pasted into the Apps Script editor manually.

## Local development

```
npm start            # eleventy --serve
npm run build        # production build
npm run sync-rss     # pull new episodes (needs .env)
npm run sync-rss:dry # preview without writing
```

`.env` (gitignored) holds `ANTHROPIC_API_KEY` and `ASSEMBLY_AI_API_KEY`.
Scripts load it via `node --env-file=.env`. Note: `--env-file` does not
override a variable already set in the shell, so if `ANTHROPIC_API_KEY` is
empty in your environment it will shadow the `.env` value — unset it first.
