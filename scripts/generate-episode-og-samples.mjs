#!/usr/bin/env node

/**
 * Generate 5 sample social-share cards for podcast episodes.
 *
 * Layout (1200x630, matches OG / Twitter summary_large_image):
 *   - Background: blurred + darkened version of the podcast cover
 *   - Left:  clean podcast cover thumbnail (480x480) with subtle border
 *   - Right: episode title in white, wrapped to fit
 *
 * Reads 5 hard-coded sample episodes from src/episodes/ and writes
 * preview cards to /tmp/og-samples/. Once a design is approved we'll
 * promote this to a prebuild step and emit a per-episode og:image.
 */

import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const EPISODES_DIR = join(ROOT, 'src', 'episodes');
const COVER = join(ROOT, 'src', 'assets', 'podcast-hero-warm.png');
const BG = join(ROOT, 'Ignore', 'zebra-wide.png');
const OUT_DIR = join(ROOT, 'og-samples-preview');

const W = 1200;
const H = 630;
const COVER_SIZE = 480;
const COVER_X = 60;
const COVER_Y = Math.round((H - COVER_SIZE) / 2);
const TEXT_X = COVER_X + COVER_SIZE + 30;
const TEXT_RIGHT_MARGIN = 40;
const TEXT_WIDTH = W - TEXT_X - TEXT_RIGHT_MARGIN;

const SAMPLES = ['196', '192', '186', '175', '165'];

/** Read an episode markdown and return its cleaned title (no "(Ep N)" suffix). */
function readEpisode(num) {
  const file = join(EPISODES_DIR, `${num}.md`);
  const { data } = matter(readFileSync(file, 'utf-8'));
  const raw = (data.title || '').replace(/\s+/g, ' ').trim();
  const clean = raw.replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/i, '').trim();
  return { num, title: clean };
}

/** Naive word-wrap: returns an array of lines that each fit within `maxChars`. */
function wrapTitle(text, maxChars) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const candidate = current ? current + ' ' + w : w;
    if (candidate.length <= maxChars) {
      current = candidate;
    } else {
      if (current) lines.push(current);
      current = w;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** Build an SVG with the wrapped title positioned in the right column. */
function titleSvg(title) {
  // Larger font for short titles; shrink as the title grows.
  const len = title.length;
  let fontSize = 56;
  let maxChars = 18;
  if (len > 60) { fontSize = 48; maxChars = 22; }
  if (len > 90) { fontSize = 42; maxChars = 26; }
  if (len > 120) { fontSize = 38; maxChars = 28; }

  const lines = wrapTitle(title, maxChars);
  const lineHeight = Math.round(fontSize * 1.15);
  const totalHeight = lines.length * lineHeight;
  const startY = Math.round((H - totalHeight) / 2) + fontSize;

  const tspans = lines
    .map((l, i) => {
      const escaped = l
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<tspan x="${TEXT_X}" y="${startY + i * lineHeight}">${escaped}</tspan>`;
    })
    .join('');

  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <style>
    .title { font-family: Georgia, "Times New Roman", serif; font-weight: 700; fill: #ffffff; }
  </style>
  <text class="title" font-size="${fontSize}">${tspans}</text>
</svg>`);
}

async function generateCard({ num, title }) {
  const cover = await sharp(COVER).png().toBuffer();

  // Slightly-blurred wide-zebra background — the gradient + wave pattern shows
  // through softly, soft enough not to compete with the title.
  const background = await sharp(BG)
    .resize(W, H, { fit: 'cover' })
    .blur(6)
    .toBuffer();

  // Foreground cover thumbnail, sharp + subtle white outline.
  const thumb = await sharp(cover)
    .resize(COVER_SIZE, COVER_SIZE, { fit: 'cover' })
    .toBuffer();

  const outline = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_SIZE}" height="${COVER_SIZE}">
  <rect x="0" y="0" width="${COVER_SIZE}" height="${COVER_SIZE}" rx="14" ry="14" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
</svg>`);

  const outPath = join(OUT_DIR, `ep-${num}.jpg`);
  await sharp(background)
    .composite([
      { input: thumb, left: COVER_X, top: COVER_Y },
      { input: outline, left: COVER_X, top: COVER_Y },
      { input: titleSvg(title), left: 0, top: 0 },
    ])
    .jpeg({ quality: 88 })
    .toFile(outPath);

  console.log(`  ✓ ${outPath}  — "${title}"`);
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  for (const num of SAMPLES) {
    const ep = readEpisode(num);
    await generateCard(ep);
  }
  console.log(`\nWrote ${SAMPLES.length} samples to ${OUT_DIR}/`);
}

main();
