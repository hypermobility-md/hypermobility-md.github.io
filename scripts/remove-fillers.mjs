#!/usr/bin/env node

/**
 * Remove filler words (uh, um) from transcript text.
 * Preserves legitimate uses like "uh-huh". Can process proofread output
 * files or episode files directly.
 *
 * Usage:
 *   node scripts/remove-fillers.mjs                    # Process proofread/ files
 *   node scripts/remove-fillers.mjs --episodes         # Process src/episodes/ directly
 *   node scripts/remove-fillers.mjs --episode 050      # Single episode
 *   node scripts/remove-fillers.mjs --dry-run          # Preview without writing
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const PROOFREAD_DIR = join(import.meta.dirname, 'output', 'proofread');
const EPISODES_DIR = join(import.meta.dirname, '..', 'src', 'episodes');

const args = process.argv.slice(2);
const useEpisodes = args.includes('--episodes');
const dryRun = args.includes('--dry-run');
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;

/**
 * Remove filler words (uh, um) from transcript text while preserving
 * legitimate uses like "uh-huh" and trailing stammers ("um—").
 */
function removeFillers(text) {
  let result = text;

  // ", uh," or ", um," — filler between commas
  result = result.replace(/,\s*\b[Uu][hm]\b,/g, ',');

  // ", uh " or ", um " — filler after comma, no trailing comma
  result = result.replace(/,\s*\b[Uu][hm]\b\s+/g, ', ');

  // "uh, " or "um, " — filler before comma
  result = result.replace(/\b[Uu][hm]\b,\s*/g, '');

  // standalone "uh" or "um" surrounded by spaces
  result = result.replace(/\s+\b[Uu][hm]\b\s+/g, ' ');

  // "um—" or "uh-" stammers (but NOT "uh-huh")
  result = result.replace(/,\s*\b[Uu][hm]\s*—/g, '—');
  result = result.replace(/\b[Uu][hm]\s*—\s*/g, '');
  result = result.replace(/\b[Uu][hm]-(?!huh)(\w)/g, '$1');

  // "Uh " or "Um " at start of speaker turn (after "Speaker Name: ")
  result = result.replace(/^([A-Za-z\s.]+:\s*)[Uu][hm]\s+/gm, '$1');

  // Clean up double spaces
  result = result.replace(/  +/g, ' ');

  // Clean up ",," left behind
  result = result.replace(/,\s*,/g, ',');

  return result;
}

function main() {
  const dir = useEpisodes ? EPISODES_DIR : PROOFREAD_DIR;
  let files = readdirSync(dir).filter(f => f.endsWith('.md'));

  if (singleEpisode) {
    files = files.filter(f => {
      const slug = f.replace('.md', '');
      return slug === singleEpisode || slug === String(singleEpisode).padStart(3, '0');
    });
  }

  if (files.length === 0) {
    console.log('No files found.');
    return;
  }

  console.log(`Processing ${files.length} files from ${useEpisodes ? 'src/episodes/' : 'scripts/output/proofread/'}...`);
  if (dryRun) console.log('(dry run — no files will be modified)\n');

  let totalRemoved = 0;
  let filesChanged = 0;

  for (const file of files) {
    const path = join(dir, file);
    const original = readFileSync(path, 'utf-8');

    const beforeCount = (original.match(/\b[Uu][hm]\b/g) || []).length;
    if (beforeCount === 0) continue;

    const cleaned = removeFillers(original);
    const afterCount = (cleaned.match(/\b[Uu][hm]\b/g) || []).length;
    const removed = beforeCount - afterCount;

    if (cleaned !== original) {
      if (!dryRun) writeFileSync(path, cleaned);
      totalRemoved += removed;
      filesChanged++;

      if (afterCount > 0) {
        console.log(`${file}: removed ${removed}, ${afterCount} remaining (uh-huh etc.)`);
      } else {
        console.log(`${file}: removed ${removed}`);
      }
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Files changed: ${filesChanged}`);
  console.log(`Fillers removed: ${totalRemoved}`);
  if (dryRun) console.log('(dry run — no files were modified)');
}

main();
