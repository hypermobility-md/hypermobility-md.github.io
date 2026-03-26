#!/usr/bin/env node

/**
 * Generate 1200x630 OG images for guest photos.
 *
 * For each guest photo in src/Guests/, creates a social-sharing-optimized
 * image with the portrait centered on a blurred version of itself.
 * Skips images that already have an up-to-date OG version.
 *
 * Usage:
 *   node scripts/generate-og-images.mjs            # Generate missing/stale OG images
 *   node scripts/generate-og-images.mjs --force     # Regenerate all
 */

import { readdirSync, existsSync, statSync, mkdirSync } from 'fs';
import { join, extname, basename } from 'path';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const GUESTS_DIR = join(ROOT, 'src', 'Guests');
const OG_DIR = join(ROOT, 'src', 'assets', 'og-guests');

const OG_WIDTH = 1200;
const OG_HEIGHT = 630;
const BLUR_SIGMA = 25;
const PORTRAIT_MAX_HEIGHT = 530; // leave padding above/below
const FORCE = process.argv.includes('--force');

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function generateOgImage(inputPath, outputPath) {
  // Read original
  const original = sharp(inputPath);
  const meta = await original.metadata();

  // 1. Create blurred background — cover the full 1200x630
  //    Add slight dark overlay for contrast
  const blurred = await sharp(inputPath)
    .resize(OG_WIDTH, OG_HEIGHT, { fit: 'cover' })
    .blur(BLUR_SIGMA)
    .modulate({ brightness: 0.7 })
    .toBuffer();

  // 2. Resize portrait to fit within frame (maintain aspect ratio)
  const portrait = await sharp(inputPath)
    .resize(null, PORTRAIT_MAX_HEIGHT, {
      fit: 'inside',
      withoutEnlargement: false, // upscale small images
    })
    .toBuffer();

  const portraitMeta = await sharp(portrait).metadata();

  // 3. Composite portrait centered on blurred background
  await sharp(blurred)
    .composite([
      {
        input: portrait,
        left: Math.round((OG_WIDTH - portraitMeta.width) / 2),
        top: Math.round((OG_HEIGHT - portraitMeta.height) / 2),
      },
    ])
    .jpeg({ quality: 85 })
    .toFile(outputPath);
}

async function main() {
  if (!existsSync(OG_DIR)) {
    mkdirSync(OG_DIR, { recursive: true });
  }

  const files = readdirSync(GUESTS_DIR).filter((f) =>
    IMAGE_EXTS.has(extname(f).toLowerCase())
  );

  let generated = 0;
  let skipped = 0;

  for (const file of files) {
    const inputPath = join(GUESTS_DIR, file);
    // Always output as .jpg
    const outName = basename(file, extname(file)) + '.jpg';
    const outputPath = join(OG_DIR, outName);

    // Skip if OG image exists and is newer than source
    if (!FORCE && existsSync(outputPath)) {
      const srcTime = statSync(inputPath).mtimeMs;
      const outTime = statSync(outputPath).mtimeMs;
      if (outTime > srcTime) {
        skipped++;
        continue;
      }
    }

    try {
      await generateOgImage(inputPath, outputPath);
      generated++;
      process.stdout.write(`  ✓ ${file}\n`);
    } catch (err) {
      process.stderr.write(`  ✗ ${file}: ${err.message}\n`);
    }
  }

  console.log(
    `\nOG images: ${generated} generated, ${skipped} up-to-date (${files.length} total)`
  );
}

main();
