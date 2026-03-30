#!/usr/bin/env node

/**
 * Generate favicon and touch icon assets from BBLogo.svg.
 *
 * Style: Purple BB logo on a white circle background.
 *
 * Outputs:
 *   src/favicon.ico                         (multi-size: 16x16, 32x32, 48x48)
 *   src/assets/favicon-16x16.png
 *   src/assets/favicon-32x32.png
 *   src/assets/favicon-48x48.png
 *   src/assets/favicon-96x96.png
 *   src/assets/apple-touch-icon.png         (180x180)
 *   src/assets/android-chrome-192x192.png
 *   src/assets/android-chrome-512x512.png
 *   src/assets/favicon.svg                  (SVG favicon)
 */

import { join } from 'path';
import { existsSync, writeFileSync, readFileSync } from 'fs';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const ROOT = join(import.meta.dirname, '..');
const SVG = join(ROOT, 'src', 'assets', 'BBLogo.svg');
const ASSETS = join(ROOT, 'src', 'assets');
const SRC = join(ROOT, 'src');

// Site purple color
const PURPLE = { r: 107, g: 63, b: 160 }; // #6b3fa0

const sizes = [
  { name: 'favicon-16x16.png', size: 16 },
  { name: 'favicon-32x32.png', size: 32 },
  { name: 'favicon-48x48.png', size: 48 },
  { name: 'favicon-96x96.png', size: 96 },
  { name: 'apple-touch-icon.png', size: 180 },
  { name: 'android-chrome-192x192.png', size: 192, maskable: true },
  { name: 'android-chrome-512x512.png', size: 512, maskable: true },
];

/**
 * Generate a favicon at a given size:
 * 1. Create white circle background
 * 2. Render the SVG logo (black)
 * 3. Tint it to purple
 * 4. Composite logo onto white circle
 */
async function generateFavicon(size, { maskable = false } = {}) {
  // Maskable icons need more padding (safe zone is inner 80%) and opaque background
  const padding = maskable ? Math.round(size * 0.12) : Math.round(size * 0.06);
  const logoSize = size - padding * 2;

  // Create background: opaque white square for maskable, white circle for others
  let bg;
  if (maskable) {
    bg = await sharp({
      create: { width: size, height: size, channels: 4,
        background: { r: 255, g: 255, b: 255, alpha: 1 } }
    }).png().toBuffer();
  } else {
    const circle = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
        <circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="white"/>
      </svg>`
    );
    bg = await sharp(circle).png().toBuffer();
  }

  // Render logo at target size
  const logo = await sharp(SVG, { density: Math.min(600, Math.max(150, size * 3)) })
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // The logo is black on transparent. To make it purple:
  // 1. Extract the alpha channel from the rendered logo
  // 2. Create a solid purple rectangle
  // 3. Use the alpha as a mask
  const { width: lw, height: lh } = await sharp(logo).metadata();
  const alphaChannel = await sharp(logo)
    .extractChannel(3) // alpha channel
    .toBuffer();

  const tintedLogo = await sharp({
    create: { width: lw, height: lh, channels: 4,
      background: { r: PURPLE.r, g: PURPLE.g, b: PURPLE.b, alpha: 1 } }
  })
    .png()
    .toBuffer();

  // Join: use alpha from original logo on the purple fill
  const finalLogo = await sharp(tintedLogo)
    .joinChannel(alphaChannel)
    .png()
    .toBuffer();

  // But joinChannel adds a 5th channel. Instead, composite with dest-in.
  // Simpler approach: create purple rect, then composite original as mask.
  // Actually, let's use a different method: create an SVG overlay.
  const purpleLogo = await sharp({
    create: { width: lw, height: lh, channels: 4,
      background: { r: PURPLE.r, g: PURPLE.g, b: PURPLE.b, alpha: 1 } }
  })
    .composite([{ input: logo, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // Composite
  return sharp(bg)
    .composite([{
      input: purpleLogo,
      left: padding,
      top: padding,
    }])
    .png()
    .toBuffer();
}

async function main() {
  if (!existsSync(SVG)) {
    console.error(`Logo not found: ${SVG}`);
    process.exit(1);
  }

  // Generate PNG favicons at all sizes
  for (const { name, size, maskable } of sizes) {
    const buf = await generateFavicon(size, { maskable });
    await sharp(buf).toFile(join(ASSETS, name));
    console.log(`  ✓ ${name} (${size}x${size}${maskable ? ', maskable' : ''})`);
  }

  // Generate favicon.ico (multi-size: 16x16, 32x32, 48x48)
  const ico16 = await generateFavicon(16);
  const ico32 = await generateFavicon(32);
  const ico48 = await generateFavicon(48);
  const icoBuffer = await pngToIco([ico16, ico32, ico48]);
  writeFileSync(join(SRC, 'favicon.ico'), icoBuffer);
  console.log('  ✓ favicon.ico (16x16, 32x32, 48x48)');

  // Generate SVG favicon — read original SVG, change fill to purple,
  // wrap in a circle background
  const originalSvg = readFileSync(SVG, 'utf-8');

  // Extract the viewBox/dimensions from the original
  const widthMatch = originalSvg.match(/width="(\d+)"/);
  const heightMatch = originalSvg.match(/height="(\d+)"/);
  const origW = widthMatch ? parseInt(widthMatch[1]) : 960;
  const origH = heightMatch ? parseInt(heightMatch[1]) : 854;

  // Create a square SVG with white circle + purple logo
  const svgSize = Math.max(origW, origH);
  const offsetX = (svgSize - origW) / 2;
  const offsetY = (svgSize - origH) / 2;
  const padding = svgSize * 0.1;

  // Extract path data from original SVG
  const paths = [...originalSvg.matchAll(/<path\s+d="([^"]+)"[^>]*\/>/g)]
    .map(m => m[0].replace(/fill="[^"]*"/, `fill="#6b3fa0"`))
    .join('\n');

  const svgFavicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgSize} ${svgSize}">
  <circle cx="${svgSize / 2}" cy="${svgSize / 2}" r="${svgSize / 2}" fill="white"/>
  <g transform="translate(${offsetX + padding / 2}, ${offsetY + padding / 2}) scale(${(svgSize - padding) / svgSize})">
    ${paths}
  </g>
</svg>`;

  writeFileSync(join(ASSETS, 'favicon.svg'), svgFavicon);
  console.log('  ✓ favicon.svg');

  console.log('\nFavicons generated successfully.');
}

main();
