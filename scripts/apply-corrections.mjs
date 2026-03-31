#!/usr/bin/env node

/**
 * Apply speaker corrections from scripts/output/speaker-corrections/*.json
 * Updates labeled files and re-formats affected episodes.
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const CORRECTIONS_DIR = join(import.meta.dirname, 'output', 'speaker-corrections');
const LABELED_DIR = join(import.meta.dirname, 'output', 'labeled');

const files = readdirSync(CORRECTIONS_DIR).filter(f => f.endsWith('.json'));

console.log(`Applying ${files.length} corrections...\n`);

let applied = 0, skipped = 0;

for (const file of files) {
  const correction = JSON.parse(readFileSync(join(CORRECTIONS_DIR, file), 'utf-8'));
  const slug = correction.slug || file.replace('.json', '');

  // Skip diarization failures — these need re-transcription
  if (correction.status === 'diarization failure') {
    console.log(`SKIP ${slug}: diarization failure (needs re-transcription)`);
    skipped++;
    continue;
  }

  // Skip if no correction needed
  if (correction.status === 'verified correct') {
    console.log(`OK   ${slug}: verified correct, no changes needed`);
    continue;
  }

  const labeledPath = join(LABELED_DIR, `${slug}.json`);
  const labeled = JSON.parse(readFileSync(labeledPath, 'utf-8'));

  // Apply the corrected speaker map
  const newMap = correction.speakerMap;

  // Remove ad speakers from the map
  const cleanMap = {};
  for (const [letter, name] of Object.entries(newMap)) {
    if (name === 'ad speaker' || name.includes('(all merged)')) continue;
    cleanMap[letter] = name;
  }

  labeled.speakerMap = cleanMap;
  labeled.confidence = 'corrected';
  labeled.flags = [...(labeled.flags || []), `manually corrected: ${correction.issue}`];

  // Update utterance speaker names
  for (const u of labeled.utterances) {
    if (cleanMap[u.speaker]) {
      u.speakerName = cleanMap[u.speaker];
    }
  }

  // Filter out ad speaker utterances
  if (newMap && Object.values(newMap).includes('ad speaker')) {
    const adLetters = Object.entries(newMap)
      .filter(([, name]) => name === 'ad speaker')
      .map(([letter]) => letter);
    labeled.utterances = labeled.utterances.filter(u => !adLetters.includes(u.speaker));
  }

  writeFileSync(labeledPath, JSON.stringify(labeled, null, 2));
  console.log(`FIX  ${slug}: ${correction.issue}`);
  applied++;
}

console.log(`\n=== Summary ===`);
console.log(`Applied: ${applied}`);
console.log(`Skipped (need re-transcription): ${skipped}`);
console.log(`\nNow run: node scripts/format-transcripts.mjs`);
