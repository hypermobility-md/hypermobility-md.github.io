#!/usr/bin/env node

/**
 * Generate 1200x630 social-share (OG) cards for the standalone site pages and
 * the long-form FAQ articles, so each shares with its own branded image rather
 * than the generic fallback.
 *
 * Two templates (see the page mockups discussed in 2026-06):
 *   - 'portrait' — personal/clinical pages (home, about, services, contact,
 *     book): zebra background + eyebrow/title/subtitle on the left, Dr.
 *     Bluestein's portrait feathered into the right edge.
 *   - 'title' — content, podcast-hub, utility pages and FAQ articles: centered
 *     eyebrow + title + subtitle on the zebra background.
 *
 * Titles auto-fit by real glyph metrics (Fraunces, rendered to vector paths —
 * see og-card-lib.mjs). Output → src/assets/og-pages/{slug}.jpg.
 *
 * Run automatically before each Eleventy build via the `prebuild` script.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import sharp from 'sharp';
import {
  W, H, loadFont, lineToPath, trackedLine, trackedWidth, textBlock, svgLayer, zebraBackground,
} from './og-card-lib.mjs';

const ROOT = join(import.meta.dirname, '..');
const ASSETS = join(ROOT, 'src', 'assets');
const BG = join(ASSETS, 'zebra-wide.png');
const FONT = join(ASSETS, 'fonts', 'Fraunces-SemiBold.ttf');
const PORTRAIT = join(ASSETS, 'Linda_Main_opt.jpg');
const QUESTIONS_DIR = join(ROOT, 'src', 'hypermobility-questions');
const OUT_DIR = join(ASSETS, 'og-pages');

const ACCENT = '#e57398'; // brand pink (purple theme --accent-light)
const WHITE = '#ffffff';

const FORCE = process.argv.includes('--force');

let font;
let bg;

// ── Template: portrait ──────────────────────────────────────────────────────
const PHOTO_W = 560;
const PORTRAIT_TEXT_X = 64;
const PORTRAIT_TEXT_W = W - PHOTO_W - PORTRAIT_TEXT_X - 24;

let cachedPortrait;
async function buildPortraitPanel() {
  // Cover-crop the portrait to the right panel, then feather its left edge to
  // transparent so it melts into the zebra rather than butting a hard seam.
  const photo = await sharp(PORTRAIT)
    .resize(PHOTO_W, H, { fit: 'cover', position: 'top' })
    .toBuffer();
  const fade = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PHOTO_W}" height="${H}">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#fff" stop-opacity="0"/>
        <stop offset="0.32" stop-color="#fff" stop-opacity="1"/>
      </linearGradient></defs>
      <rect width="100%" height="100%" fill="url(#g)"/>
    </svg>`
  );
  cachedPortrait = await sharp(photo)
    .composite([{ input: fade, blend: 'dest-in' }])
    .png()
    .toBuffer();
}

function portraitText({ eyebrow, title }) {
  const x = PORTRAIT_TEXT_X;
  const w = PORTRAIT_TEXT_W;
  const parts = [];
  parts.push(trackedLine(font, eyebrow.toUpperCase(), x, 172, 26, ACCENT, 3));
  // Title is the focus: big, filling the space between eyebrow and footer.
  const titleBlock = textBlock(font, title, {
    x, width: w, top: 200, height: 300, color: WHITE, maxFs: 92, minFs: 46,
  });
  parts.push(titleBlock.paths);
  parts.push(lineToPath(font, 'Dr. Linda Bluestein, MD', x, 575, 23, WHITE, 0.6));
  return svgLayer(parts.join(''));
}

async function generatePortraitCard(outPath, content) {
  await sharp(bg)
    .composite([
      { input: cachedPortrait, left: W - PHOTO_W, top: 0 },
      { input: portraitText(content), left: 0, top: 0 },
    ])
    .jpeg({ quality: 86 })
    .toFile(outPath);
}

// ── Template: title ─────────────────────────────────────────────────────────
function titleText({ eyebrow, title }) {
  const cx = W / 2;
  const parts = [];
  // accent rule above the eyebrow
  parts.push(`<rect x="${cx - 40}" y="178" width="80" height="4" rx="2" fill="${ACCENT}"/>`);
  const eb = eyebrow.toUpperCase();
  const ebW = trackedWidth(font, eb, 27, 4);
  parts.push(trackedLine(font, eb, cx - ebW / 2, 236, 27, ACCENT, 4));
  // Title is the focus: big, centered, filling the body of the card.
  const titleBlock = textBlock(font, title, {
    x: 110, width: W - 220, top: 262, height: 240, align: 'center', color: WHITE, maxFs: 100, minFs: 46,
  });
  parts.push(titleBlock.paths);
  const url = 'hypermobility-md.github.io';
  const urlW = trackedWidth(font, url, 22, 1);
  parts.push(trackedLine(font, url, cx - urlW / 2, 580, 22, WHITE, 1, 0.55));
  return svgLayer(parts.join(''));
}

async function generateTitleCard(outPath, content) {
  await sharp(bg)
    .composite([{ input: titleText(content), left: 0, top: 0 }])
    .jpeg({ quality: 86 })
    .toFile(outPath);
}

// ── Manifest: one entry per standalone page ─────────────────────────────────
// (subtitle is retained as data but not currently rendered — the cards are
// title-focused, matching the episode cards.)
const PAGES = [
  { out: 'home', template: 'portrait', eyebrow: 'Hypermobility MD', title: 'Dr. Linda Bluestein', subtitle: 'Integrative pain medicine for hypermobility, EDS & complex chronic conditions.' },
  { out: 'about', template: 'portrait', eyebrow: 'About', title: 'Meet Dr. Bluestein', subtitle: 'Board-certified physician and host of the Bendy Bodies podcast, with lived experience of hEDS.' },
  { out: 'services', template: 'portrait', eyebrow: 'Services', title: 'Find the Right Support', subtitle: 'EduCoaching, medical consultations & professional mentorship for EDS, POTS, MCAS & chronic pain.' },
  { out: 'contact', template: 'portrait', eyebrow: 'Contact', title: 'Get in Touch', subtitle: 'Questions about EduCoaching, medical services, or the Bendy Bodies podcast.' },
  { out: 'book', template: 'portrait', eyebrow: 'New Patients', title: 'Schedule a First Appointment', subtitle: 'Join the waiting list for a first appointment with Dr. Bluestein.' },

  { out: 'faq', template: 'title', eyebrow: 'Frequently Asked', title: 'Questions', subtitle: 'EDS, hypermobility, POTS, MCAS, services & payment options.' },
  { out: 'resources', template: 'title', eyebrow: 'Resources', title: 'Guides & Tools', subtitle: 'Curated guides on EDS and hypermobility — red flags, diagnostics, LDN & more.' },
  { out: 'projects', template: 'title', eyebrow: 'Recommended', title: 'Products We Love', subtitle: 'Tools and products recommended for the hypermobility & EDS community.' },
  { out: 'podcast-episodes', template: 'title', eyebrow: 'Bendy Bodies Podcast', title: 'All Episodes', subtitle: 'Conversations about EDS, hypermobility, POTS, MCAS & chronic pain.' },
  { out: 'podcast-guests', template: 'title', eyebrow: 'Bendy Bodies Podcast', title: 'Guest Index', subtitle: 'Every guest who has joined Dr. Bluestein on the show.' },
  { out: 'podcast-appearances', template: 'title', eyebrow: 'Bendy Bodies', title: 'Guest Appearances', subtitle: "Dr. Bluestein's appearances on other podcasts and shows." },
  { out: 'privacy', template: 'title', eyebrow: 'Legal', title: 'Privacy Policy', subtitle: 'How we handle data, cookies, and analytics.' },
  { out: '404', template: 'title', eyebrow: 'Error 404', title: 'Page Not Found', subtitle: "Sorry, we couldn't find that page." },

  { out: 'ask', template: 'title', eyebrow: 'Bendy Bodies Podcast', title: 'Ask the Podcast a Question', subtitle: 'Submit a question for a future episode.' },
  { out: 'feedback-form', template: 'title', eyebrow: 'EduCoaching', title: 'Session Feedback', subtitle: 'Share feedback on your session.' },
];

async function render(entry, outPath) {
  if (entry.template === 'portrait') await generatePortraitCard(outPath, entry);
  else await generateTitleCard(outPath, entry);
}

function cleanTitle(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim();
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  font = loadFont(FONT);
  bg = await zebraBackground(BG);
  await buildPortraitPanel();

  const inputMtime = Math.max(
    statSync(BG).mtimeMs,
    statSync(FONT).mtimeMs,
    statSync(PORTRAIT).mtimeMs,
    statSync(new URL(import.meta.url)).mtimeMs
  );

  let generated = 0;
  let skipped = 0;

  // Fixed pages — regenerate whenever an input (script/font/bg/portrait) changes.
  for (const entry of PAGES) {
    const outPath = join(OUT_DIR, `${entry.out}.jpg`);
    if (!FORCE && existsSync(outPath) && statSync(outPath).mtimeMs > inputMtime) {
      skipped++;
      continue;
    }
    await render(entry, outPath);
    generated++;
  }

  // FAQ articles — one title card each, keyed by file slug.
  if (existsSync(QUESTIONS_DIR)) {
    const files = readdirSync(QUESTIONS_DIR).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const srcPath = join(QUESTIONS_DIR, f);
      const { data } = matter(readFileSync(srcPath, 'utf-8'));
      const title = cleanTitle(data.title);
      if (!title) continue;
      const slug = basename(f, '.md');
      const outPath = join(OUT_DIR, `faq-${slug}.jpg`);
      if (!FORCE && existsSync(outPath)) {
        const newest = Math.max(statSync(srcPath).mtimeMs, inputMtime);
        if (statSync(outPath).mtimeMs > newest) {
          skipped++;
          continue;
        }
      }
      await generateTitleCard(outPath, { eyebrow: 'Hypermobility Q&A', title, subtitle: '' });
      generated++;
    }
  }

  console.log(`Page OG cards: ${generated} generated, ${skipped} up-to-date`);
}

main();
