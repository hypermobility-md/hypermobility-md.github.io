#!/usr/bin/env node

/**
 * Generate favicon and touch icon assets from BBLogo.svg.
 *
 * Outputs:
 *   src/favicon.ico            (32x32 ICO via PNG)
 *   src/assets/favicon-16x16.png
 *   src/assets/favicon-32x32.png
 *   src/assets/apple-touch-icon.png  (180x180)
 *   src/assets/android-chrome-192x192.png
 *   src/assets/android-chrome-512x512.png
 */

import { join } from 'path';
import { existsSync } from 'fs';
import sharp from 'sharp';

const ROOT = join(import.meta.dirname, '..');
const SVG = join(ROOT, 'src', 'assets', 'BBLogo.svg');
const ASSETS = join(ROOT, 'src', 'assets');
const SRC = join(ROOT, 'src');

const sizes = [
  { name: 'favicon-16x16.png', size: 16, dir: ASSETS },
  { name: 'favicon-32x32.png', size: 32, dir: ASSETS },
  { name: 'apple-touch-icon.png', size: 180, dir: ASSETS },
  { name: 'android-chrome-192x192.png', size: 192, dir: ASSETS },
  { name: 'android-chrome-512x512.png', size: 512, dir: ASSETS },
];

async function main() {
  if (!existsSync(SVG)) {
    console.error(`Logo not found: ${SVG}`);
    process.exit(1);
  }

  for (const { name, size, dir } of sizes) {
    const out = join(dir, name);
    await sharp(SVG, { density: Math.max(150, size * 2) })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toFile(out);
    console.log(`  ✓ ${name} (${size}x${size})`);
  }

  // Generate favicon.ico as a 32x32 PNG (browsers accept PNG favicons)
  // For a proper .ico we'd need a separate library, but modern browsers
  // prefer the <link rel="icon" type="image/png"> anyway
  await sharp(SVG, { density: 300 })
    .resize(32, 32, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(SRC, 'favicon.ico'));
  console.log('  ✓ favicon.ico (32x32 PNG)');

  console.log('\nFavicons generated successfully.');
}

main();
