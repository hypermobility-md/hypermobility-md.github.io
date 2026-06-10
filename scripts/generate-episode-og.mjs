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

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import sharp from 'sharp';
import opentype from 'opentype.js';

const ROOT = join(import.meta.dirname, '..');
const EPISODES_DIR = join(ROOT, 'src', 'episodes');
const ASSETS = join(ROOT, 'src', 'assets');
const COVER = join(ASSETS, 'podcast-hero-warm.png');
const BG = join(ASSETS, 'zebra-wide.png');
const FONT = join(ASSETS, 'fonts', 'Fraunces-SemiBold.ttf');
const OUT_DIR = join(ASSETS, 'og-episodes');
const PODCAST_OUT = join(ASSETS, 'og-podcast.jpg');

const W = 1200;
const H = 630;

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
function loadFont() {
  const buf = readFileSync(FONT);
  font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

function measure(text, fontSize) {
  return font.getAdvanceWidth(text, fontSize);
}

// Build SVG path data straight from opentype's parsed commands. We deliberately
// avoid path.toPathData(): its number formatter emits a literal "NaN" token for
// some coordinate values in this font (the underlying command values are fine),
// which silently breaks glyphs. Formatting the clean command numbers ourselves
// sidesteps that bug entirely.
const round2 = (n) => Number(n.toFixed(2));
function pathToD(path) {
  let d = '';
  for (const c of path.commands) {
    if (c.type === 'M') d += `M${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'L') d += `L${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'C') d += `C${round2(c.x1)} ${round2(c.y1)} ${round2(c.x2)} ${round2(c.y2)} ${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'Q') d += `Q${round2(c.x1)} ${round2(c.y1)} ${round2(c.x)} ${round2(c.y)}`;
    else if (c.type === 'Z') d += 'Z';
  }
  return d;
}

// One <path> per text line. A single giant `d` attribute (all lines/glyphs
// concatenated) gets truncated by librsvg's XML parser, dropping later lines;
// per-line paths keep each attribute small and render reliably.
function lineToPath(text, x, baseline, fontSize, color, opacity = 1) {
  const d = pathToD(font.getPath(text, x, baseline, fontSize));
  const op = opacity === 1 ? '' : ` fill-opacity="${opacity}"`;
  return `<path d="${d}" fill="${color}"${op}/>`;
}

function wrapToWidth(text, fontSize, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (!current || measure(candidate, fontSize) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// Largest font size at which the wrapped title fits the box (width + height).
function fitTitle(text, maxWidth, maxHeight) {
  for (let fs = MAX_FS; fs >= MIN_FS; fs -= 1) {
    const lines = wrapToWidth(text, fs, maxWidth);
    const totalH = lines.length * fs * LINE_RATIO;
    const overflow = lines.some((l) => measure(l, fs) > maxWidth);
    if (totalH <= maxHeight && !overflow) return { fs, lines };
  }
  return { fs: MIN_FS, lines: wrapToWidth(text, MIN_FS, maxWidth) };
}

// Render wrapped lines as vector paths, vertically centered in the box.
function titleSvg(text, { x = TEXT_X, width = TEXT_W, top = TEXT_BOX_TOP, height = TEXT_BOX_H, align = 'left', color = '#ffffff' } = {}) {
  const { fs, lines } = fitTitle(text, width, height);
  const lineHeight = fs * LINE_RATIO;
  const ascent = (font.ascender / font.unitsPerEm) * fs;
  const totalH = lines.length * lineHeight;
  const startBaseline = top + (height - totalH) / 2 + ascent;

  const paths = lines
    .map((line, i) => {
      const lineX = align === 'center' ? x + (width - measure(line, fs)) / 2 : x;
      return lineToPath(line, lineX, startBaseline + i * lineHeight, fs, color);
    })
    .join('');

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${paths}</svg>`
  );
}

let cachedBackground;
let cachedThumb;

async function buildLayers() {
  // Zoom the zebra: cover-resize to a larger canvas, then crop the centre back
  // to 1200x630 so the weave is magnified rather than fit edge-to-edge.
  const zw = Math.round(W * BG_ZOOM);
  const zh = Math.round(H * BG_ZOOM);
  const zoomed = await sharp(BG)
    .resize(zw, zh, { fit: 'cover' })
    .blur(5)
    .modulate({ brightness: 0.92 })
    .toBuffer();
  cachedBackground = await sharp(zoomed)
    .extract({
      left: Math.round((zw - W) / 2),
      top: Math.round((zh - H) / 2),
      width: W,
      height: H,
    })
    .toBuffer();

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
    lineToPath('Conversations about hypermobility,', TEXT_X, 396, tagFs, '#ffffff', 0.82) +
    lineToPath('EDS, POTS, MCAS & chronic pain.', TEXT_X, 432, tagFs, '#ffffff', 0.82);
  const taglineSvg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${tagline}</svg>`
  );
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
  loadFont();
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
