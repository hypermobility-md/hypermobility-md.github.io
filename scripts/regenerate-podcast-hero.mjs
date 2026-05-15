#!/usr/bin/env node

/**
 * One-shot: replace src/assets/podcast-hero-warm.* with new artwork.
 *
 * Reads ./Linda.png at the repo root, drops it in as the new master
 * podcast-hero-warm.png, and regenerates the variants the site uses:
 *   podcast-hero-warm.webp        (1000x1000)
 *   podcast-hero-warm-640.webp    (640x640)
 *   podcast-hero-warm-320.webp    (320x320)
 *   podcast-hero-warm_opt.png     (optimized 1000x1000 PNG)
 */

import { copyFileSync, existsSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'Linda.png');
const ASSETS = join(ROOT, 'src', 'assets');

if (!existsSync(SRC)) {
  console.error(`✗ Source not found: ${SRC}`);
  process.exit(1);
}

const outputs = [
  { name: 'podcast-hero-warm.png', size: 1000, format: 'png' },
  { name: 'podcast-hero-warm_opt.png', size: 1000, format: 'png', opts: { compressionLevel: 9, palette: false } },
  { name: 'podcast-hero-warm.webp', size: 1000, format: 'webp', opts: { quality: 88 } },
  { name: 'podcast-hero-warm-640.webp', size: 640, format: 'webp', opts: { quality: 85 } },
  { name: 'podcast-hero-warm-320.webp', size: 320, format: 'webp', opts: { quality: 82 } },
];

for (const out of outputs) {
  const outPath = join(ASSETS, out.name);
  let img = sharp(SRC).resize(out.size, out.size, { fit: 'cover' });
  if (out.format === 'png') img = img.png(out.opts || {});
  if (out.format === 'webp') img = img.webp(out.opts || {});
  await img.toFile(outPath);
  console.log(`  ✓ ${out.name}`);
}

// Replace the master source PNG with the new artwork too (so re-runs are idempotent).
copyFileSync(SRC, join(ASSETS, 'podcast-hero-warm.png'));
console.log('\nDone.');
