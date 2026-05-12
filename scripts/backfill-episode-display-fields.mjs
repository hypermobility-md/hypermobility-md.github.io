#!/usr/bin/env node

// One-time backfill of episode front-matter for nicer CMS display:
//   1. Set `bonus: true` on episodes with `num: null` or a "bonus-" filename.
//   2. Set `guestImage` to the first guest's photo, if known and not already set.
//
// This is purely cosmetic for the CMS list view — the rendered site already
// resolves guest photos via guestData.js, so nothing changes on the live site.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EPISODES_DIR = join(REPO_ROOT, 'src', 'episodes');
const PROFILES_DIR = join(REPO_ROOT, 'src', 'guest-profiles');
const GUESTS_DIR = join(REPO_ROOT, 'src', 'Guests');
const IMAGES_MAP = join(REPO_ROOT, 'src', '_data', 'guestImages.json');

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
    if (!photo) photo = findFileForKey(key);
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
