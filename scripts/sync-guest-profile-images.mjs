#!/usr/bin/env node

// Sync guest photos into guest-profile JSON files so the CMS Guest Profiles
// list always shows the right photo, regardless of whether the photo was
// uploaded directly on the profile or via an episode's Guest Photo field.
//
// For each guest profile (and for each guest name appearing in an episode):
//   1. Decide the best image path, in priority order:
//      a. Profile already has `image` set                → keep it
//      b. guestImages.json has a path for this key       → use it
//      c. An episode's guestImages/guestImage matches    → use it
//      d. /Guests/{Key_Variant}.{ext} exists on disk     → use it
//   2. If a profile exists and gained an image, write it back.
//   3. If a profile doesn't exist but we have a photo for that guest name,
//      create a stub profile { key, image }.
//
// Idempotent: safe to run on every push. Exits 0 always.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PROFILES_DIR = join(REPO_ROOT, 'src', 'guest-profiles');
const GUESTS_DIR = join(REPO_ROOT, 'src', 'Guests');
const EPISODES_DIR = join(REPO_ROOT, 'src', 'episodes');
const IMAGES_MAP = join(REPO_ROOT, 'src', '_data', 'guestImages.json');

// Mirrors normalizeKey in src/_data/guestData.js.
function normalizeKey(name) {
  if (!name) return '';
  let n = String(name).replace(/^(Dr\.?|Prof\.?|Professor)\s+/i, '');
  let prev;
  do {
    prev = n;
    n = n.replace(/[,\s]+(M\.?D\.?|Ph\.?D\.?|D\.?P\.?T\.?|D\.?O\.?|P\.?A\.?-?C?|R\.?D\.?N\.?|O\.?T\.?|P\.?T\.?|J\.?D\.?|LICSW|NCPT|ATC|MS|MA|MPT|DMSC|MRCPsych|DDS|D\.?C\.?|FACP|FACS|FAANS|FAAFP|FAAN|FAMSSM|FACOG|FRCPC|IFMCP|ABIHM|CCSP|CEDS-S|FAED|CHT|CYT|CHC|CMTPT|COMT|NCS|OCS|CES|MHCM)\.?\s*$/i, '');
  } while (n !== prev);
  return n.replace(/[,.\s]+$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeImagePath(p) {
  if (!p) return p;
  let out = String(p).trim();
  if (!out) return out;
  if (!out.startsWith('/')) out = '/' + out;
  if (!out.startsWith('/Guests/')) {
    const parts = out.split('/');
    out = '/Guests/' + parts[parts.length - 1];
  }
  return out;
}

function slugifyKey(key) {
  return key.replace(/\s+/g, '-');
}

// Build set of guest-image filenames available on disk.
const guestFiles = existsSync(GUESTS_DIR)
  ? readdirSync(GUESTS_DIR).filter(f => /\.(jpe?g|png|webp|avif)$/i.test(f))
  : [];

function findFileForKey(key) {
  const words = key.split(/\s+/);
  const variants = new Set([
    words.map(w => w[0].toUpperCase() + w.slice(1)).join('_'),
    words.map(w => w[0].toUpperCase() + w.slice(1)).join('-'),
    words.map(w => w[0].toUpperCase() + w.slice(1)).join(''),
    words.join('_'),
    words.join('-'),
    words.join(''),
  ]);
  for (const f of guestFiles) {
    const stem = f.replace(/\.[^.]+$/, '');
    if (variants.has(stem)) return '/Guests/' + f;
  }
  return null;
}

// Static image map. Used to FILL existing profiles, never to create new ones
// (it contains aliases like "larry afrin" → Lawrence_Afrin.jpg).
const staticImages = existsSync(IMAGES_MAP)
  ? JSON.parse(readFileSync(IMAGES_MAP, 'utf8'))
  : {};
const staticImagesByKey = {};
for (const [k, v] of Object.entries(staticImages)) {
  staticImagesByKey[normalizeKey(k)] = normalizeImagePath(v);
}

// Episode-derived image map. THIS is the source for stub creation —
// it only contains photos Linda actually uploaded on an episode.
const episodeImagesByKey = {};
if (existsSync(EPISODES_DIR)) {
  for (const f of readdirSync(EPISODES_DIR).filter(n => n.endsWith('.md'))) {
    const { data } = matter(readFileSync(join(EPISODES_DIR, f), 'utf8'));
    const guests = data.guests || [];
    const epImages = data.guestImages || [];
    guests.forEach((g, i) => {
      const key = normalizeKey(g);
      if (!key) return;
      if (epImages[i] && !episodeImagesByKey[key]) {
        episodeImagesByKey[key] = normalizeImagePath(epImages[i]);
      }
    });
    if (data.guestImage && guests.length === 1) {
      const key = normalizeKey(guests[0]);
      if (key && !episodeImagesByKey[key]) {
        episodeImagesByKey[key] = normalizeImagePath(data.guestImage);
      }
    }
  }
}

// Combined map used for filling existing profiles.
const imagesByKey = { ...staticImagesByKey, ...episodeImagesByKey };

// Walk existing profiles.
const existingProfileKeys = new Set();
const profileImagePaths = new Set();
let updated = 0;
let skipped = 0;
let created = 0;
let skippedHost = 0;
let skippedAlias = 0;

// Names that are hosts/co-hosts, not guests — never auto-create a profile.
const HOSTS = new Set(['linda bluestein']);

if (existsSync(PROFILES_DIR)) {
  for (const f of readdirSync(PROFILES_DIR).filter(n => n.endsWith('.json'))) {
    const fpath = join(PROFILES_DIR, f);
    const profile = JSON.parse(readFileSync(fpath, 'utf8'));
    const key = normalizeKey(profile.key || '');
    if (!key) continue;
    existingProfileKeys.add(key);

    if (profile.image && profile.image.trim()) {
      profileImagePaths.add(profile.image);
      skipped++;
      continue;
    }

    let resolved = imagesByKey[key] || findFileForKey(key);
    if (!resolved) continue;
    resolved = normalizeImagePath(resolved);
    profile.image = resolved;
    profileImagePaths.add(resolved);
    writeFileSync(fpath, JSON.stringify(profile, null, 2) + '\n');
    updated++;
  }
}

// Create stub profiles for guests we have a photo for but no profile.
// Only consider photos Linda uploaded via an episode form — the static
// guestImages.json contains aliases (e.g. "larry afrin" / "lawrence afrin").
// Also skip if the image is already used by another profile (=alias).
for (const [key, image] of Object.entries(episodeImagesByKey)) {
  if (existingProfileKeys.has(key)) continue;
  if (!image) continue;
  if (HOSTS.has(key)) { skippedHost++; continue; }
  const normalized = normalizeImagePath(image);
  if (profileImagePaths.has(normalized)) { skippedAlias++; continue; }
  const stub = { key, image: normalized };
  const filename = slugifyKey(key) + '.json';
  const stubPath = join(PROFILES_DIR, filename);
  if (existsSync(stubPath)) continue; // safety
  writeFileSync(stubPath, JSON.stringify(stub, null, 2) + '\n');
  profileImagePaths.add(normalized);
  existingProfileKeys.add(key);
  created++;
}

console.log(`Updated:  ${updated}`);
console.log(`Skipped:  ${skipped} (already had image)`);
console.log(`Created:  ${created} stub profile(s)`);
if (skippedHost) console.log(`Skipped:  ${skippedHost} host(s)`);
if (skippedAlias) console.log(`Skipped:  ${skippedAlias} alias(es) (image already in another profile)`);
