#!/usr/bin/env node

/**
 * Generate 1200x630 social-share cards for every podcast episode.
 *
 * Layout (matches og-samples-preview/):
 *   - Background: blurred zebra-wide gradient (purple → teal)
 *   - Left:  the Bendy Bodies podcast cover (480x480)
 *   - Right: episode title in white serif
 *
 * Reads episode markdown frontmatter from src/episodes/, writes one JPG per
 * episode to src/assets/og-episodes/{num|fileSlug}.jpg. Skips files whose
 * source data and inputs haven't changed since the last build (size proxy).
 *
 * Run automatically before each Eleventy build via the `prebuild` script.
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const EPISODES_DIR = join(ROOT, 'src', 'episodes');
const ASSETS = join(ROOT, 'src', 'assets');
const COVER = join(ASSETS, 'podcast-hero-warm.png');
const BG = join(ASSETS, 'zebra-wide.png');
const OUT_DIR = join(ASSETS, 'og-episodes');

const W = 1200;
const H = 630;
const COVER_SIZE = 480;
const COVER_X = 60;
const COVER_Y = Math.round((H - COVER_SIZE) / 2);
const TEXT_X = COVER_X + COVER_SIZE + 30;
const TEXT_RIGHT_MARGIN = 40;

const FORCE = process.argv.includes('--force');

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

function titleSvg(title) {
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

let cachedBackground;
let cachedThumb;
let cachedOutline;

async function buildLayers() {
  cachedBackground = await sharp(BG)
    .resize(W, H, { fit: 'cover' })
    .blur(6)
    .toBuffer();
  cachedThumb = await sharp(COVER)
    .resize(COVER_SIZE, COVER_SIZE, { fit: 'cover' })
    .toBuffer();
  cachedOutline = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${COVER_SIZE}" height="${COVER_SIZE}">
  <rect x="0" y="0" width="${COVER_SIZE}" height="${COVER_SIZE}" rx="14" ry="14" fill="none" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
</svg>`);
}

async function generateCard(outPath, title) {
  await sharp(cachedBackground)
    .composite([
      { input: cachedThumb, left: COVER_X, top: COVER_Y },
      { input: cachedOutline, left: COVER_X, top: COVER_Y },
      { input: titleSvg(title), left: 0, top: 0 },
    ])
    .jpeg({ quality: 86 })
    .toFile(outPath);
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/i, '')
    .trim();
}

async function main() {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  await buildLayers();

  // Newest input mtime — if all outputs are newer, we can skip.
  const inputMtime = Math.max(
    statSync(COVER).mtimeMs,
    statSync(BG).mtimeMs,
    statSync(new URL(import.meta.url)).mtimeMs
  );

  const files = readdirSync(EPISODES_DIR).filter(f => f.endsWith('.md'));
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

  console.log(`Episode OG cards: ${generated} generated, ${skipped} up-to-date (${files.length} episodes)`);
}

main();
