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
  W, H, loadFont, measure, lineToPath, textBlock, svgLayer, zebraBackground,
} from './og-card-lib.mjs';

const ROOT = join(import.meta.dirname, '..');
const ASSETS = join(ROOT, 'src', 'assets');
const BG = join(ASSETS, 'zebra-wide.png');
const FONT = join(ASSETS, 'fonts', 'Fraunces-SemiBold.ttf');
const PORTRAIT = join(ASSETS, 'Linda_Main_opt.jpg');
const LOGO = join(ASSETS, 'BBLogo.svg');
const QUESTIONS_DIR = join(ROOT, 'src', 'hypermobility-questions');
const RESOURCES_DIR = join(ROOT, 'src', 'resource-articles');
const OUT_DIR = join(ASSETS, 'og-pages');

const TEAL = '#3dc9b8'; // brand green highlight (podcast --teal-light)
const WHITE = '#ffffff';

const FORCE = process.argv.includes('--force');

let font;
let bg;

// ── Brand lockup (shared by both templates) ─────────────────────────────────
// The BB monogram + "Hypermobility MD" wordmark, both in the brand green,
// replacing the old eyebrow label and footer URL/byline.
const LOGO_H = 80;
const WORDMARK = 'Hypermobility MD';
const WORDMARK_FS = 44;
const LOCKUP_GAP = 22;
const LOCKUP_TOP = 72;
let cachedLogo;
let cachedLogoW;

async function buildLogo() {
  // The logo paths carry no fill, so fill is inherited — tint it by setting
  // fill on the root <svg> before rasterizing.
  const svg = readFileSync(LOGO, 'utf8').replace('<svg ', `<svg fill="${TEAL}" `);
  cachedLogo = await sharp(Buffer.from(svg)).resize({ height: LOGO_H }).png().toBuffer();
  cachedLogoW = (await sharp(cachedLogo).metadata()).width;
}

// Where to composite the logo + the wordmark <path>. align 'center' treats
// originX as the lockup centre; 'left' treats it as the left edge.
function lockup(originX, top, align) {
  const total = cachedLogoW + LOCKUP_GAP + measure(font, WORDMARK, WORDMARK_FS);
  const startX = align === 'center' ? originX - total / 2 : originX;
  const wmBaseline = top + LOGO_H / 2 + WORDMARK_FS * 0.34;
  return {
    logoLeft: Math.round(startX),
    logoTop: top,
    wordmark: lineToPath(font, WORDMARK, startX + cachedLogoW + LOCKUP_GAP, wmBaseline, WORDMARK_FS, TEAL),
  };
}

// ── Template: portrait ──────────────────────────────────────────────────────
// Dr. Bluestein feathered into the right; lockup + big title on the left.
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

async function generatePortraitCard(outPath, content) {
  const lk = lockup(PORTRAIT_TEXT_X, LOCKUP_TOP, 'left');
  const titleBlock = textBlock(font, content.title, {
    x: PORTRAIT_TEXT_X, width: PORTRAIT_TEXT_W, top: 185, height: 320, color: WHITE, maxFs: 90, minFs: 44,
  });
  await sharp(bg)
    .composite([
      { input: cachedPortrait, left: W - PHOTO_W, top: 0 },
      { input: cachedLogo, left: lk.logoLeft, top: lk.logoTop },
      { input: svgLayer(lk.wordmark + titleBlock.paths), left: 0, top: 0 },
    ])
    .jpeg({ quality: 86 })
    .toFile(outPath);
}

// ── Template: title ─────────────────────────────────────────────────────────
async function generateTitleCard(outPath, content) {
  const lk = lockup(W / 2, LOCKUP_TOP, 'center');
  const titleBlock = textBlock(font, content.title, {
    x: 100, width: W - 200, top: 205, height: 315, align: 'center', color: WHITE, maxFs: 104, minFs: 46,
  });
  await sharp(bg)
    .composite([
      { input: cachedLogo, left: lk.logoLeft, top: lk.logoTop },
      { input: svgLayer(lk.wordmark + titleBlock.paths), left: 0, top: 0 },
    ])
    .jpeg({ quality: 86 })
    .toFile(outPath);
}

// ── Manifest: one entry per standalone page ─────────────────────────────────
const PAGES = [
  { out: 'home', template: 'portrait', title: 'Dr. Linda Bluestein' },
  { out: 'about', template: 'portrait', title: 'Meet Dr. Bluestein' },
  { out: 'services', template: 'portrait', title: 'Services' },
  { out: 'contact', template: 'portrait', title: 'Contact' },
  { out: 'book', template: 'portrait', title: 'Schedule a First Appointment' },

  { out: 'faq', template: 'title', title: 'FAQ' },
  { out: 'resources', template: 'title', title: 'Resources' },
  { out: 'projects', template: 'title', title: 'Products We Love' },
  { out: 'podcast-episodes', template: 'title', title: 'All Episodes' },
  { out: 'podcast-guests', template: 'title', title: 'Guest Index' },
  { out: 'podcast-appearances', template: 'title', title: 'Guest Appearances' },
  { out: 'privacy', template: 'title', title: 'Privacy Policy' },
  { out: '404', template: 'title', title: '404: Page Not Found' },

  { out: 'ask', template: 'title', title: 'Ask the Podcast a Question' },
  { out: 'feedback-form', template: 'title', title: 'Session Feedback' },
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
  await buildLogo();

  const inputMtime = Math.max(
    statSync(BG).mtimeMs,
    statSync(FONT).mtimeMs,
    statSync(PORTRAIT).mtimeMs,
    statSync(LOGO).mtimeMs,
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

  // Article collections — one title card each, keyed by {prefix}-{file slug}.
  // The generators loop the source dir, so new CMS articles get cards too.
  async function articleCards(dir, prefix) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
      const srcPath = join(dir, f);
      const { data } = matter(readFileSync(srcPath, 'utf-8'));
      const title = cleanTitle(data.title);
      if (!title) continue;
      const outPath = join(OUT_DIR, `${prefix}-${basename(f, '.md')}.jpg`);
      if (!FORCE && existsSync(outPath) && statSync(outPath).mtimeMs > Math.max(statSync(srcPath).mtimeMs, inputMtime)) {
        skipped++;
        continue;
      }
      await generateTitleCard(outPath, { title });
      generated++;
    }
  }

  await articleCards(QUESTIONS_DIR, 'faq');
  await articleCards(RESOURCES_DIR, 'resource');

  console.log(`Page OG cards: ${generated} generated, ${skipped} up-to-date`);
}

main();
