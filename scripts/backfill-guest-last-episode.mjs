#!/usr/bin/env node

// Backfill `lastEpisode` onto guest-profile JSON for the CMS list view.
//
// For each guest profile, finds the most recent episode the guest appears in
// (matched by normalized key against each episode's `guests` list) and stamps
// `lastEpisode` with that episode's date (YYYY-MM-DD). The Sveltia CMS
// "Guest Profiles" collection default-sorts by this field (newest first), so
// recently-featured guests surface at the top — combine with the "Missing bio"
// filter to triage bios in recency order.
//
// Idempotent — safe to re-run on every sync. Profiles for guests not found in
// any episode are left without a date (they sort to the bottom).

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { normalizeKey } from './lib/guest-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EPISODES_DIR = join(REPO_ROOT, 'src', 'episodes');
const PROFILES_DIR = join(REPO_ROOT, 'src', 'guest-profiles');

const toDateStr = (d) => {
  if (!d) return null;
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10); // YYYY-MM-DD
};

// 1. Build normalized key → most-recent episode date.
const lastByKey = {};
for (const f of readdirSync(EPISODES_DIR).filter((n) => n.endsWith('.md'))) {
  const { data } = matter(readFileSync(join(EPISODES_DIR, f), 'utf8'));
  const date = toDateStr(data.date);
  if (!date || !Array.isArray(data.guests)) continue;
  for (const g of data.guests) {
    const key = normalizeKey(g);
    if (!key) continue;
    if (!lastByKey[key] || date > lastByKey[key]) lastByKey[key] = date;
  }
}

// 2. Stamp each profile.
let touched = 0;
let matched = 0;
for (const f of readdirSync(PROFILES_DIR).filter((n) => n.endsWith('.json'))) {
  const fpath = join(PROFILES_DIR, f);
  const data = JSON.parse(readFileSync(fpath, 'utf8'));
  const key = normalizeKey(data.key);
  const last = lastByKey[key] || null;
  if (!last) continue;
  matched++;
  if (data.lastEpisode !== last) {
    data.lastEpisode = last;
    writeFileSync(fpath, JSON.stringify(data, null, 2) + '\n');
    touched++;
  }
}

console.log(`Guest profiles matched to an episode: ${matched}`);
console.log(`Profiles updated (lastEpisode set/changed): ${touched}`);
