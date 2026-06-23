#!/usr/bin/env node

/**
 * Generate 1200x630 social-share (OG) cards for guest-appearance pages.
 *
 * Each appearance in src/appearances/*.md carries an `imageUrl` (the show's
 * cover art, usually square/portrait and not 1200x630). Sharing the raw image
 * gives a cropped, off-size preview — and brand-new appearances added via the
 * CMS had no branded card at all. This mirrors the guest-OG treatment
 * (generate-og-images.mjs): the cover image is centered, at full aspect ratio,
 * over a blurred + darkened copy of itself.
 *
 * Reads frontmatter from src/appearances/, writes one JPG per appearance to
 * src/assets/og-appearances/{file slug}.jpg — the slug the appearance page is
 * published under, so open-graph.njk can point at it directly. The loop covers
 * the source dir, so appearances saved in the CMS get a card on the next build
 * (prebuild → deploy). Idempotent: skips cards newer than both their source
 * image and this script.
 *
 * Run automatically before each Eleventy build via the `prebuild` script.
 */

import { readdirSync, readFileSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import matter from 'gray-matter';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const APPEARANCES_DIR = join(ROOT, 'src', 'appearances');
const SRC_ROOT = join(ROOT, 'src');
const OUT_DIR = join(ROOT, 'src', 'assets', 'og-appearances');

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const BLUR_SIGMA = 25;
const IMAGE_MAX_HEIGHT = 530; // leave padding above/below
const FORCE = process.argv.includes('--force');

// Resolve a frontmatter imageUrl ("/assets/appearances/foo.avif") to its path
// under src/. Returns null for absolute/remote URLs we can't read locally.
function resolveLocal(imageUrl) {
  if (!imageUrl || /^https?:\/\//i.test(imageUrl)) return null;
  return join(SRC_ROOT, imageUrl.replace(/^\//, ''));
}

async function generateOgImage(inputPath, outputPath) {
  // 1. Blurred, darkened background covering the full frame.
  const blurred = await sharp(inputPath)
    .resize(OG_WIDTH, OG_HEIGHT, { fit: 'cover' })
    .blur(BLUR_SIGMA)
    .modulate({ brightness: 0.7 })
    .toBuffer();

  // 2. The cover image at full aspect ratio, sized to fit the frame height.
  const cover = await sharp(inputPath)
    .resize(null, IMAGE_MAX_HEIGHT, { fit: 'inside', withoutEnlargement: false })
    .toBuffer();
  const coverMeta = await sharp(cover).metadata();

  // 3. Composite the cover centered on the blurred background.
  await sharp(blurred)
    .composite([
      {
        input: cover,
        left: Math.round((OG_WIDTH - coverMeta.width) / 2),
        top: Math.round((OG_HEIGHT - coverMeta.height) / 2),
      },
    ])
    .jpeg({ quality: 85 })
    .toFile(outputPath);
}

async function main() {
  if (!existsSync(APPEARANCES_DIR)) {
    console.log('[appearance-og] no src/appearances/ dir — nothing to do');
    return;
  }
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

  const selfMtime = statSync(new URL(import.meta.url)).mtimeMs;
  const files = readdirSync(APPEARANCES_DIR).filter((f) => f.endsWith('.md'));

  let generated = 0;
  let skipped = 0;
  let missing = 0;

  for (const file of files) {
    const { data } = matter(readFileSync(join(APPEARANCES_DIR, file), 'utf-8'));
    const inputPath = resolveLocal(data.imageUrl);
    if (!inputPath || !existsSync(inputPath)) {
      missing++;
      continue;
    }

    const outputPath = join(OUT_DIR, basename(file, '.md') + '.jpg');
    if (!FORCE && existsSync(outputPath)) {
      const newestInput = Math.max(statSync(inputPath).mtimeMs, selfMtime);
      if (statSync(outputPath).mtimeMs > newestInput) {
        skipped++;
        continue;
      }
    }

    try {
      await generateOgImage(inputPath, outputPath);
      generated++;
    } catch (err) {
      process.stderr.write(`  ✗ ${file}: ${err.message}\n`);
    }
  }

  console.log(
    `Appearance OG cards: ${generated} generated, ${skipped} up-to-date` +
      (missing ? `, ${missing} without a local image` : '')
  );
}

main();
