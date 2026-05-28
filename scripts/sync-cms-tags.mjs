#!/usr/bin/env node

/**
 * Sync the CMS "Tags" select options to the canonical taxonomy.
 *
 * The Sveltia CMS (src/admin/config.yml) can't read tagTaxonomy.json directly,
 * so its tag <select> options have to be written into the YAML. This script
 * regenerates that options block from src/_data/tagTaxonomy.json, ordered by
 * how many episodes use each tag (most → least common, so the big categories
 * are easy to find), with any unused taxonomy tags appended alphabetically.
 *
 * Run it whenever the taxonomy changes:
 *   node scripts/sync-cms-tags.mjs
 *   node scripts/sync-cms-tags.mjs --dry-run
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

const ROOT = join(import.meta.dirname, '..');
const CONFIG = join(ROOT, 'src', 'admin', 'config.yml');
const TAXONOMY = join(ROOT, 'src', '_data', 'tagTaxonomy.json');
const EPISODES_DIR = join(ROOT, 'src', 'episodes');

const dryRun = process.argv.includes('--dry-run');

const taxonomy = JSON.parse(readFileSync(TAXONOMY, 'utf-8'));
const tagNames = taxonomy.tags.map(t => t.name);

// Count episode usage per tag.
const counts = {};
for (const file of readdirSync(EPISODES_DIR).filter(f => f.endsWith('.md'))) {
  const { data } = matter(readFileSync(join(EPISODES_DIR, file), 'utf-8'));
  for (const tag of data.tags || []) counts[tag] = (counts[tag] || 0) + 1;
}

// Order: most → least common, ties broken alphabetically.
const ordered = [...tagNames].sort(
  (a, b) => (counts[b] || 0) - (counts[a] || 0) || a.localeCompare(b)
);

const optionsBlock = ordered.map(name => `          - "${name}"`).join('\n');

const config = readFileSync(CONFIG, 'utf-8');
// Replace the option items under the tags widget's `options:` line.
const re = /(\n        name: "tags"[\s\S]*?\n        options:\n)(?:          - .*\n)+/;
if (!re.test(config)) {
  console.error('✗ Could not locate the tags widget options block in config.yml');
  process.exit(1);
}
const updated = config.replace(re, `$1${optionsBlock}\n`);

if (updated === config) {
  console.log('✓ CMS tag options already up to date.');
} else if (dryRun) {
  console.log(`Would write ${ordered.length} tag options (most → least common):\n`);
  console.log(ordered.map((n, i) => `  ${i + 1}. ${n} (${counts[n] || 0})`).join('\n'));
} else {
  writeFileSync(CONFIG, updated);
  console.log(`✓ Wrote ${ordered.length} tag options to config.yml (most → least common).`);
}
