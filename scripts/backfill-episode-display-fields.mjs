#!/usr/bin/env node

// Backfill of episode front-matter for nicer CMS display (idempotent — runs on
// every sync-podcast push):
//   1. Set `bonus: true` on episodes with `num: null` or a "bonus-" filename.
//   2. Set `guestImage` to the first guest's photo, if known and not already set.
//
// This is purely cosmetic for the CMS list view — the rendered site already
// resolves guest photos via guestData.js, so nothing changes on the live site.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { normalizeKey, normalizeImagePath, findGuestFile } from './lib/guest-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EPISODES_DIR = join(REPO_ROOT, 'src', 'episodes');
const PROFILES_DIR = join(REPO_ROOT, 'src', 'guest-profiles');
const GUESTS_DIR = join(REPO_ROOT, 'src', 'Guests');
const IMAGES_MAP = join(REPO_ROOT, 'src', '_data', 'guestImages.json');

// Build a unified key → image lookup from guestImages.json, guest-profiles,
// and /Guests/ filename matching — same fallback order as guestData.js.
const imagesByKey = {};
if (existsSync(IMAGES_MAP)) {
  const raw = JSON.parse(readFileSync(IMAGES_MAP, 'utf8'));
  for (const [k, v] of Object.entries(raw)) {
    imagesByKey[normalizeKey(k)] = normalizeImagePath(v);
  }
}
if (existsSync(PROFILES_DIR)) {
  for (const f of readdirSync(PROFILES_DIR).filter(n => n.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf8'));
    if (data.key && data.image) {
      imagesByKey[normalizeKey(data.key)] = normalizeImagePath(data.image);
    }
  }
}
const guestFiles = existsSync(GUESTS_DIR)
  ? readdirSync(GUESTS_DIR).filter(f => /\.(jpe?g|png|webp|avif)$/i.test(f))
  : [];

let bonusSet = 0;
let imageSet = 0;
let touched = 0;

for (const f of readdirSync(EPISODES_DIR).filter(n => n.endsWith('.md'))) {
  const fpath = join(EPISODES_DIR, f);
  const parsed = matter(readFileSync(fpath, 'utf8'));
  const data = parsed.data;
  let changed = false;

  // 1. Bonus tag — driven by num:null OR filename prefix.
  const isBonusByNum = data.num === null || data.num === undefined;
  const isBonusByName = /^bonus[-_]/i.test(f);
  if ((isBonusByNum || isBonusByName) && data.bonus !== true) {
    data.bonus = true;
    bonusSet++;
    changed = true;
  }

  // 2. First-guest photo as guestImage (only if not already set).
  if (!data.guestImage && Array.isArray(data.guests) && data.guests.length > 0) {
    const firstGuest = data.guests[0];
    const key = normalizeKey(firstGuest);
    let photo = imagesByKey[key];
    if (!photo) photo = findGuestFile(key, guestFiles);
    if (photo) {
      data.guestImage = normalizeImagePath(photo);
      imageSet++;
      changed = true;
    }
  }

  if (changed) {
    writeFileSync(fpath, matter.stringify(parsed.content, data));
    touched++;
  }
}

console.log(`Episodes touched: ${touched}`);
console.log(`  bonus: true set on:   ${bonusSet}`);
console.log(`  guestImage set on:    ${imageSet}`);
