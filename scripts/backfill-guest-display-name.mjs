#!/usr/bin/env node

// ONE-TIME backfill of the `name` (Preferred Display Name) field on guest
// profiles, so the Sveltia CMS list shows a real, properly-capitalized name.
//
// Sveltia's `default()` summary transformation only accepts a literal string
// (not a field reference), and there's no title-case transformation — so the
// CMS list can't derive a pretty name from the lowercase `key`. The only
// reliable way to show names is to store one on each profile. The summary is
// set to `{{fields.name}}`.
//
// For each profile the name is the best display name seen in the episodes'
// `guests` lists (preferring a "Dr." form, then the longest) — i.e. exactly
// what the site already renders. Guests not found in any episode fall back to
// a title-cased key.
//
// NOT wired into the sync pipeline: `name` is user-editable, so re-running on
// every sync would clobber manual edits. Only fills profiles that don't
// already have a `name`. Safe to re-run.

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';
import { normalizeKey } from './lib/guest-keys.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const EPISODES_DIR = join(REPO_ROOT, 'src', 'episodes');
const PROFILES_DIR = join(REPO_ROOT, 'src', 'guest-profiles');

const isDr = (s) => /^Dr\.?\s/i.test(s);
const titleCase = (s) =>
  s.replace(/\b\w/g, (c) => c.toUpperCase());

// Build key → best display name from episode guest lists (mirrors the
// guestDisplayNames collection in eleventy.config.js).
const bestName = {};
for (const f of readdirSync(EPISODES_DIR).filter((n) => n.endsWith('.md'))) {
  const { data } = matter(readFileSync(join(EPISODES_DIR, f), 'utf8'));
  if (!Array.isArray(data.guests)) continue;
  for (const g of data.guests) {
    const key = normalizeKey(g);
    if (!key || key.length < 3) continue;
    const current = bestName[key];
    if (!current) {
      bestName[key] = g;
    } else if (isDr(g) && !isDr(current)) {
      bestName[key] = g;
    } else if (g.length > current.length && !isDr(current)) {
      bestName[key] = g;
    }
  }
}

let filled = 0;
let fromEpisode = 0;
let fromKey = 0;
for (const f of readdirSync(PROFILES_DIR).filter((n) => n.endsWith('.json'))) {
  const fpath = join(PROFILES_DIR, f);
  const data = JSON.parse(readFileSync(fpath, 'utf8'));
  if (data.name && String(data.name).trim()) continue; // don't clobber

  const key = normalizeKey(data.key);
  const name = bestName[key] || titleCase(data.key || '');
  if (!name) continue;
  if (bestName[key]) fromEpisode++; else fromKey++;

  // Rebuild with `name` right after `key` for clean diffs.
  const { key: k, ...rest } = data;
  const ordered = { key: k, name, ...rest };
  writeFileSync(fpath, JSON.stringify(ordered, null, 2) + '\n');
  filled++;
}

console.log(`Profiles filled with a name: ${filled}`);
console.log(`  from episode display name:  ${fromEpisode}`);
console.log(`  from title-cased key:       ${fromKey}`);
