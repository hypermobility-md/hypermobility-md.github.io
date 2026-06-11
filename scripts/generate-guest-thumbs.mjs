// Generate right-sized guest-headshot thumbnails.
//
// Guest photos in src/Guests/ arrive full-resolution (often 600–850px, up to
// ~900KB) from the CMS and the sync-guest-profile-images cron, but they are
// only ever displayed at <=100px (the /guests/ profile photo) and 52px
// everywhere else. This emits ~220px derivatives (100px @2x) into
// src/assets/guest-thumbs/, which guestData.js then points the image map at —
// so both the server templates and the client data.js serve the small version.
//
// Non-destructive: originals in src/Guests/ are never touched. Output is
// gitignored and regenerated every build (prebuild) + on `npm start`
// (prestart), so the back catalog and cron-added photos are covered no matter
// how they arrived. Idempotent: skips thumbs already newer than their source.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'src', 'Guests');
const OUT_DIR = path.join(__dirname, '..', 'src', 'assets', 'guest-thumbs');

// 100px is the largest a headshot is ever rendered (.guest-detail-photo); 220px
// covers that at 2x retina with a little headroom. Avatars (52px) are tiny.
const MAX_EDGE = 220;

const isImage = (f) => /\.(jpe?g|png)$/i.test(f);

async function run() {
  if (!fs.existsSync(SRC_DIR)) {
    console.log('[guest-thumbs] no src/Guests/ dir — nothing to do');
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const files = fs.readdirSync(SRC_DIR).filter(isImage);
  let made = 0;
  let skipped = 0;
  let bytesIn = 0;
  let bytesOut = 0;

  for (const file of files) {
    const srcPath = path.join(SRC_DIR, file);
    const outPath = path.join(OUT_DIR, file);
    const srcStat = fs.statSync(srcPath);

    // Idempotent: skip if an up-to-date thumb already exists.
    if (fs.existsSync(outPath) && fs.statSync(outPath).mtimeMs >= srcStat.mtimeMs) {
      skipped++;
      continue;
    }

    try {
      const img = sharp(srcPath).rotate().resize(MAX_EDGE, MAX_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      });
      const isPng = /\.png$/i.test(file);
      const out = isPng
        ? img.png({ compressionLevel: 9, palette: true, quality: 80 })
        : img.jpeg({ quality: 82, mozjpeg: true });
      await out.toFile(outPath);
      made++;
      bytesIn += srcStat.size;
      bytesOut += fs.statSync(outPath).size;
    } catch (err) {
      console.warn(`[guest-thumbs] skip ${file}: ${err.message}`);
    }
  }

  const kb = (n) => Math.round(n / 1024);
  console.log(
    `[guest-thumbs] ${made} generated, ${skipped} up-to-date` +
      (made ? ` — ${kb(bytesIn)}KB → ${kb(bytesOut)}KB on the rebuilt set` : '')
  );
}

run();
