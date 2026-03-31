#!/usr/bin/env node

/**
 * Stage 2: Map AssemblyAI speaker labels (A, B, C) to real names.
 * Reads from scripts/output/raw/, writes to scripts/output/labeled/
 *
 * Usage:
 *   node scripts/label-speakers.mjs             # All raw transcripts
 *   node scripts/label-speakers.mjs --episode 50
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import { mapSpeakers } from './lib/speaker-map.mjs';

const RAW_DIR = join(import.meta.dirname, 'output', 'raw');
const LABELED_DIR = join(import.meta.dirname, 'output', 'labeled');
const REVIEW_FILE = join(import.meta.dirname, 'speaker-review.json');

const args = process.argv.slice(2);
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;

function main() {
  const allEpisodes = parseAllEpisodes();
  const episodeMap = new Map(allEpisodes.map(ep => [ep.slug, ep]));

  // Get raw transcript files
  let rawFiles = readdirSync(RAW_DIR).filter(f => f.endsWith('.json'));

  if (singleEpisode) {
    rawFiles = rawFiles.filter(f => {
      const slug = f.replace('.json', '');
      const ep = episodeMap.get(slug);
      return slug === singleEpisode || String(ep?.num) === singleEpisode;
    });
  }

  if (rawFiles.length === 0) {
    console.log('No raw transcripts found. Run transcribe.mjs first.');
    return;
  }

  console.log(`Processing ${rawFiles.length} raw transcripts...\n`);

  const reviewItems = [];
  let highCount = 0, mediumCount = 0, lowCount = 0;

  for (const file of rawFiles) {
    const slug = file.replace('.json', '');
    const episode = episodeMap.get(slug);

    if (!episode) {
      console.log(`SKIP ${slug}: no matching episode found`);
      continue;
    }

    const raw = JSON.parse(readFileSync(join(RAW_DIR, file), 'utf-8'));
    const utterances = raw.utterances || [];

    if (utterances.length === 0) {
      console.log(`SKIP ${slug}: no utterances in raw transcript`);
      reviewItems.push({ slug, reason: 'no utterances', confidence: 'low' });
      continue;
    }

    // Map speakers (now filters out pre-roll ads)
    const { speakerMap, confidence, flags, adSpeakers, contentStartIndex } = mapSpeakers(utterances, episode);

    // Only include content utterances (skip pre-roll ads)
    const contentUtterances = utterances.slice(contentStartIndex);

    // Create labeled output
    const labeled = {
      slug,
      num: episode.num,
      title: episode.title,
      guests: episode.guests,
      cohosts: episode.cohosts,
      guestSpeakers: episode.guestSpeakers,
      speakerMap,
      adSpeakers,
      contentStartIndex,
      confidence,
      flags,
      utterances: contentUtterances
        .filter(u => !adSpeakers.includes(u.speaker))
        .map(u => ({
          speaker: u.speaker,
          speakerName: speakerMap[u.speaker] || `Speaker ${u.speaker}`,
          text: u.text,
          start: u.start,
          end: u.end,
        })),
    };

    writeFileSync(join(LABELED_DIR, `${slug}.json`), JSON.stringify(labeled, null, 2));

    // Track confidence
    if (confidence === 'high') highCount++;
    else if (confidence === 'medium') mediumCount++;
    else lowCount++;

    // Flag for review if needed
    if (confidence !== 'high') {
      reviewItems.push({ slug, confidence, flags, speakerMap });
    }

    const icon = confidence === 'high' ? '✓' : confidence === 'medium' ? '~' : '✗';
    console.log(`${icon} ${slug} [${confidence}]${flags.length ? ' — ' + flags.join('; ') : ''}`);
  }

  // Write review file
  writeFileSync(REVIEW_FILE, JSON.stringify(reviewItems, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`High confidence: ${highCount}`);
  console.log(`Medium confidence: ${mediumCount}`);
  console.log(`Low confidence: ${lowCount}`);
  console.log(`Review file: ${REVIEW_FILE}`);
  if (reviewItems.length > 0) {
    console.log(`\n${reviewItems.length} episodes need review. Check speaker-review.json`);
  }
}

main();
