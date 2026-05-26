# Hypermobility MD / Bendy Bodies Podcast

Eleventy static site for Dr. Linda Bluestein's medical practice and the Bendy
Bodies Podcast. Deployed to GitHub Pages.

## Start of session: pull first

`master` moves on its own between sessions (cron syncs new episodes,
transcripts, and guest photos every few hours — see Deploy & automation).
**Run `git pull --ff-only` at the start of every session before doing any
work**, so you don't make edits on a stale tree and run into rebase pain
later. If the fast-forward fails, `git fetch && git status` to see what
diverged before deciding next steps.

## Deploy & automation

GitHub Actions, all on `master`:

- **`deploy.yml`** — builds and deploys to GitHub Pages on every push.
- **`sync-podcast.yml`** — cron every 6 hours: runs `scripts/sync-rss.mjs`,
  then `scripts/backfill-episode-display-fields.mjs` (sets `guestImage` etc.
  for CMS thumbnails), commits new episodes as `github-actions[bot]`,
  pushes, and deploys. New episodes publish ~weekly, so this is effectively
  the weekly content update.
- **`transcribe-podcast.yml`**, **`sync-guest-profile-images.yml`** — further
  scheduled jobs that commit transcripts / guest images.

**Consequence: `master` moves on its own.** Bot commits land between sessions.
Always `git fetch` before committing, and expect to rebase. When asked to
"commit and push," check `git rev-list --count master...origin/master` first.

GitHub Pages has no server-side redirects (no real 301s) — see Episode URLs.

## Site structure (where things live)

```
src/
├── _data/
│   ├── faqCategories.js           # ordered FAQ accordion categories
│   ├── guestImages.json           # guest key → photo path (canonical lookup)
│   └── site.js                    # site-wide config (name, URL, etc.)
├── _includes/
│   ├── base.njk                   # main page layout (head, nav, footer)
│   ├── episode.njk                # episode page layout
│   ├── appearance.njk             # guest-appearance page layout
│   ├── hypermobility-question.njk # FAQ article layout w/ optional embed
│   ├── nav.njk, footer.njk        # global chrome
│   └── seo/                       # OG, JSON-LD partials
├── admin/                         # Sveltia CMS — config.yml drives all collections
│   ├── config.yml
│   └── index.html
├── episodes/                      # podcast episodes (md, body = transcript)
│   ├── {num}.md
│   ├── bonus-*.md
│   └── episodes.11tydata.js       # computes /episodes/{num}-{slug}/ URLs
├── guest-profiles/                # one JSON per guest (key, bio, socials, photo)
├── faq-items/                     # CMS FAQ Q&A (markdown, accordion items)
├── hypermobility-questions/       # CMS long-form FAQ articles → /faq/<slug>/
├── appearances/                   # Linda's external podcast/show appearances
├── Guests/                        # guest headshots (note: capital G; CMS uploads land here)
├── assets/                        # everything else (images, og cards, fonts)
├── css/styles.css                 # single stylesheet
├── js/                            # form-submit.js + small page scripts
├── about.njk, faq.njk, services.njk, contact.njk, …
├── guest-form/a8f3x9k2.njk        # unlisted guest-info form (obfuscated path)
├── ask.njk, book.njk, feedback-form.njk
├── episode-redirects.11ty.js      # emits meta-refresh stubs at /episodes/{num}/
└── cms-data/                      # build-time JSON for the CMS to read
scripts/                           # node ESM tools (see Content pipeline)
google-apps-script-v2.js           # gitignored; form handler (see Forms)
```

## Content pipeline

Episodes are markdown in `src/episodes/` (`{num}.md`, body = transcript).
They arrive two ways:

- **Sveltia CMS** at `/admin/` — commits straight to `master` (commit messages
  like `Update Podcast Episodes "196"`).
- **`scripts/sync-rss.mjs`** — pulls from the Megaphone RSS feed, extracts
  guests via Haiku, and backfills YouTube video URLs by matching the podcast
  publish date to the video upload date (titles often lack episode numbers, so
  date is the primary key; number is a fallback). Sets both `guestImages`
  (list) and `guestImage` (singular, first match — used as the CMS list
  thumbnail).

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

## FAQ page

Two CMS-driven sources feed `src/faq.njk`:

- **`src/faq-items/*.md`** — short Q&A items rendered as a vertical accordion,
  grouped by `category` (defined in `src/_data/faqCategories.js`). Sveltia
  collection: "FAQ Items".
- **`src/hypermobility-questions/*.md`** — long-form articles published at
  `/faq/<file-slug>/` via the layout `_includes/hypermobility-question.njk`
  + per-folder data file. Each article has an optional top-of-page
  embed (image / YouTube / external link), wrapped in `<div class="faq-article-embed">`.
  Sveltia collection: "Hypermobility Questions". Old `/faq/<slug>/` URLs
  stay intact for SEO — these markdown files replaced standalone .njk pages
  in 2026-05.

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
