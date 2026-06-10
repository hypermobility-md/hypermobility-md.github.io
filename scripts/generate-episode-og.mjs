#!/usr/bin/env node

/**
 * Generate 1200x630 social-share cards for every podcast episode, plus a
 * branded card for the /podcast/ landing page.
 *
 * Layout:
 *   - Background: the zebra texture, zoomed in (so the weave reads at preview
 *     size) and lightly blurred.
 *   - Left:  the Bendy Bodies podcast cover (large, rounded, subtly outlined).
 *   - Right: title set in Fraunces (the site heading font) in white.
 *
 * Fonts: Fraunces is a Google webfont and is NOT installed on macOS or the
 * ubuntu CI runner, and sharp's bundled fontconfig does not reliably pick up
 * ad-hoc font dirs. So instead of relying on font lookup, we parse the bundled
 * TTF with opentype.js and render each title as vector <path> data — identical
 * output everywhere, no system-font dependency.
 *
 * Title sizing is measure-based: we pick the largest font size at which the
 * title, wrapped on real glyph metrics, still fits the text box. Short titles
 * get big type; long ones shrink but stay as large as they can.
 *
 * Reads episode markdown frontmatter from src/episodes/, writes one JPG per
 * episode to src/assets/og-episodes/{num|fileSlug}.jpg, and the podcast card
 * to src/assets/og-podcast.jpg. Skips files whose source data and inputs
 * haven't changed since the last build (mtime proxy).
 *
 * Run automatically before each Eleventy build via the `prebuild` script.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import sharp from 'sharp';
import { W, H, loadFont, lineToPath, textBlock, svgLayer, zebraBackground } from './og-card-lib.mjs';

const ROOT = join(import.meta.dirname, '..');
const EPISODES_DIR = join(ROOT, 'src', 'episodes');
const ASSETS = join(ROOT, 'src', 'assets');
const COVER = join(ASSETS, 'podcast-hero-warm.png');
const BG = join(ASSETS, 'zebra-wide.png');
const FONT = join(ASSETS, 'fonts', 'Fraunces-SemiBold.ttf');
const OUT_DIR = join(ASSETS, 'og-episodes');
const PODCAST_OUT = join(ASSETS, 'og-podcast.jpg');

// Cover (left). The PNG carries its own internal padding, so it can run large
// and close to the edges without feeling cramped.
const COVER_SIZE = 600;
const COVER_X = 44;
const COVER_Y = Math.round((H - COVER_SIZE) / 2);

// Title box (right of the cover)
const TEXT_X = COVER_X + COVER_SIZE + 40;
const TEXT_RIGHT_MARGIN = 56;
const TEXT_W = W - TEXT_X - TEXT_RIGHT_MARGIN;
const TEXT_BOX_TOP = 72;
const TEXT_BOX_H = H - TEXT_BOX_TOP * 2;

// Zoom factor for the zebra background (>1 magnifies the weave).
const BG_ZOOM = 1.7;

// Title auto-fit bounds.
const MAX_FS = 72;
const MIN_FS = 34;
const LINE_RATIO = 1.18; // line height as a multiple of font size

const FORCE = process.argv.includes('--force');

let font;

// Render an auto-fit Fraunces title, vertically centered in the title box.
function titleSvg(text, { x = TEXT_X, width = TEXT_W, top = TEXT_BOX_TOP, height = TEXT_BOX_H, align = 'left', color = '#ffffff' } = {}) {
  const { paths } = textBlock(font, text, {
    x, width, top, height, align, color,
    maxFs: MAX_FS, minFs: MIN_FS, lineRatio: LINE_RATIO,
  });
  return svgLayer(paths);
}

let cachedBackground;
let cachedThumb;

async function buildLayers() {
  cachedBackground = await zebraBackground(BG, { zoom: BG_ZOOM });
  cachedThumb = await sharp(COVER)
    .resize(COVER_SIZE, COVER_SIZE, { fit: 'cover' })
    .toBuffer();
}

async function generateCard(outPath, title) {
  await sharp(cachedBackground)
    .composite([
      { input: cachedThumb, left: COVER_X, top: COVER_Y },
      { input: titleSvg(title), left: 0, top: 0 },
    ])
    .jpeg({ quality: 86 })
    .toFile(outPath);
}

// Podcast landing card: cover on the left, show name + tagline on the right.
async function generatePodcastCard(outPath) {
  const nameSvg = titleSvg('Bendy Bodies', { top: 150, height: 170 });
  const tagFs = 26;
  const tagline =
    lineToPath(font, 'Conversations about hypermobility,', TEXT_X, 396, tagFs, '#ffffff', 0.82) +
    lineToPath(font, 'EDS, POTS, MCAS & chronic pain.', TEXT_X, 432, tagFs, '#ffffff', 0.82);
  const taglineSvg = svgLayer(tagline);
  await sharp(cachedBackground)
    .composite([
      { input: cachedThumb, left: COVER_X, top: COVER_Y },
      { input: nameSvg, left: 0, top: 0 },
      { input: taglineSvg, left: 0, top: 0 },
    ])
    .jpeg({ quality: 86 })
    .toFile(outPath);
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    // strip a trailing episode tag like "(Ep. 199)", "(EP 12)", "(BEN 4)"
    .replace(/\s*\(\s*(?:Ep|EP|BEN)\.?\s*\d+\s*\)\s*$/i, '')
    .trim();
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  font = loadFont(FONT);
  await buildLayers();

  // Newest input mtime — if all outputs are newer, we can skip.
  const inputMtime = Math.max(
    statSync(COVER).mtimeMs,
    statSync(BG).mtimeMs,
    statSync(FONT).mtimeMs,
    statSync(new URL(import.meta.url)).mtimeMs
  );

  const files = readdirSync(EPISODES_DIR).filter((f) => f.endsWith('.md'));
  let generated = 0;
  let skipped = 0;

  for (const f of files) {
    const srcPath = join(EPISODES_DIR, f);
    const { data } = matter(readFileSync(srcPath, 'utf-8'));
    const title = cleanTitle(data.title);
    if (!title) continue;

    const base = (data.num != null && data.num !== '') ? String(data.num) : basename(f, '.md');
    const outPath = join(OUT_DIR, `${base}.jpg`);

    if (!FORCE && existsSync(outPath)) {
      const epMtime = statSync(srcPath).mtimeMs;
      const outMtime = statSync(outPath).mtimeMs;
      if (outMtime > Math.max(epMtime, inputMtime)) {
        skipped++;
        continue;
      }
    }

    await generateCard(outPath, title);
    generated++;
  }

  // Podcast landing card — regenerate when inputs change.
  if (FORCE || !existsSync(PODCAST_OUT) || statSync(PODCAST_OUT).mtimeMs < inputMtime) {
    await generatePodcastCard(PODCAST_OUT);
  }

  console.log(`Episode OG cards: ${generated} generated, ${skipped} up-to-date (${files.length} episodes) + podcast card`);
}

main();
