#!/usr/bin/env node

// One-time backfill: ensure every guest-profile JSON has an `image` field
// pointing to /Guests/<File>.<ext>.
//
// Strategy (in order):
//   1. Use src/_data/guestImages.json mapping (key → path)
//   2. Fall back to scanning src/Guests/ for a file whose name matches the
//      profile key (e.g. "alan hakim" → Alan_Hakim.jpg / Alan-Hakim.png).
//
// Skips profiles that already have a non-empty `image` field.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PROFILES_DIR = join(REPO_ROOT, 'src', 'guest-profiles');
const GUESTS_DIR = join(REPO_ROOT, 'src', 'Guests');
const IMAGES_MAP = join(REPO_ROOT, 'src', '_data', 'guestImages.json');

const images = JSON.parse(readFileSync(IMAGES_MAP, 'utf8'));

const guestFiles = readdirSync(GUESTS_DIR).filter(
  f => /\.(jpe?g|png|webp|avif)$/i.test(f)
);

function keyVariants(key) {
  // "alan hakim" → ["Alan_Hakim", "Alan-Hakim", "alan_hakim", ...]
  const words = key.split(/\s+/);
  const capital = words.map(w => w[0].toUpperCase() + w.slice(1)).join('_');
  const capitalDash = words.map(w => w[0].toUpperCase() + w.slice(1)).join('-');
  return new Set([
    capital,
    capitalDash,
    capital.replace(/_/g, ''),
    words.join('_'),
    words.join('-'),
    words.join(''),
  ]);
}

function findFileForKey(key) {
  const variants = keyVariants(key);
  for (const f of guestFiles) {
    const stem = f.replace(/\.[^.]+$/, '');
    if (variants.has(stem)) return '/Guests/' + f;
  }
  return null;
}

let updated = 0;
let skipped = 0;
let unresolved = [];

for (const f of readdirSync(PROFILES_DIR).filter(n => n.endsWith('.json'))) {
  const path = join(PROFILES_DIR, f);
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (data.image && data.image.trim()) {
    skipped++;
    continue;
  }
  const key = (data.key || '').trim().toLowerCase();
  if (!key) continue;

  let resolved = images[key];
  if (!resolved) resolved = findFileForKey(key);

  if (!resolved) {
    unresolved.push(key);
    continue;
  }

  // Normalize to /Guests/...
  if (!resolved.startsWith('/')) resolved = '/' + resolved;
  if (!resolved.startsWith('/Guests/')) {
    const parts = resolved.split('/');
    resolved = '/Guests/' + parts[parts.length - 1];
  }

  data.image = resolved;
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n');
  updated++;
}

console.log(`Updated: ${updated}`);
console.log(`Skipped (already had image): ${skipped}`);
console.log(`Unresolved (no photo on file): ${unresolved.length}`);
if (unresolved.length) {
  console.log('  ' + unresolved.slice(0, 30).join('\n  '));
  if (unresolved.length > 30) console.log(`  ...and ${unresolved.length - 30} more`);
}
