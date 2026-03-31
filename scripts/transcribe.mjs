#!/usr/bin/env node

/**
 * Stage 1: Submit episodes to AssemblyAI for transcription and save raw JSON results.
 *
 * Usage:
 *   node scripts/transcribe.mjs                 # All episodes
 *   node scripts/transcribe.mjs --dry-run       # Validate audioUrls, estimate cost
 *   node scripts/transcribe.mjs --episode 50    # Single episode
 *   node scripts/transcribe.mjs --range 0-50    # Range of episodes
 *   node scripts/transcribe.mjs --retry-errors  # Retry failed episodes
 */

import { writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import { submitOnly, getTranscript } from './lib/assemblyai-helpers.mjs';
import { loadState, setEpisodeState } from './lib/state.mjs';

const OUTPUT_RAW = join(import.meta.dirname, 'output', 'raw');
const POLL_INTERVAL = 30_000; // 30 seconds
const SUBMIT_DELAY = 200; // 200ms between submissions

// --- Parse CLI args ---
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const retryErrors = args.includes('--retry-errors');
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;
const rangeIdx = args.indexOf('--range');
const range = rangeIdx !== -1 ? args[rangeIdx + 1] : null;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseDuration(durStr) {
  // Parse "1h 5m", "42m", "28m", etc. to hours
  const hours = durStr.match(/(\d+)h/)?.[1] || 0;
  const minutes = durStr.match(/(\d+)m/)?.[1] || 0;
  return Number(hours) + Number(minutes) / 60;
}

async function main() {
  const allEpisodes = parseAllEpisodes();
  const state = loadState();

  // --- Filter episodes ---
  let episodes = allEpisodes;

  if (singleEpisode) {
    episodes = allEpisodes.filter(ep => ep.slug === singleEpisode || String(ep.num) === singleEpisode);
    if (episodes.length === 0) {
      console.error(`Episode "${singleEpisode}" not found.`);
      process.exit(1);
    }
  } else if (range) {
    const [start, end] = range.split('-').map(Number);
    episodes = allEpisodes.filter(ep => ep.num !== null && ep.num >= start && ep.num <= end);
  }

  // Filter based on state
  if (!retryErrors) {
    episodes = episodes.filter(ep => {
      const s = state[ep.slug];
      if (!s) return true; // not started
      if (s.status === 'transcribed') return false; // already done
      if (s.status === 'submitted') return true; // need to poll
      if (s.status === 'error' && !retryErrors) return false;
      return true;
    });
  } else {
    episodes = episodes.filter(ep => state[ep.slug]?.status === 'error');
  }

  // --- Summary ---
  const totalHours = episodes.reduce((sum, ep) => sum + parseDuration(ep.duration), 0);
  const missingAudio = episodes.filter(ep => !ep.audioUrl);

  console.log(`\n=== Transcription Pipeline ===`);
  console.log(`Episodes to process: ${episodes.length}`);
  console.log(`Total audio: ~${totalHours.toFixed(1)} hours`);
  console.log(`Estimated cost: ~$${(totalHours * 0.33).toFixed(2)} (before free tier)`);
  console.log(`Episodes missing audioUrl: ${missingAudio.length}`);
  if (missingAudio.length > 0) {
    console.log(`  Missing: ${missingAudio.map(e => e.slug).join(', ')}`);
  }

  // Speaker count summary
  const speakerCounts = {};
  for (const ep of episodes) {
    speakerCounts[ep.speakersExpected] = (speakerCounts[ep.speakersExpected] || 0) + 1;
  }
  console.log(`Speaker distribution: ${JSON.stringify(speakerCounts)}`);

  // Co-host episodes
  const cohostEps = episodes.filter(ep => ep.cohosts.length > 0);
  if (cohostEps.length > 0) {
    console.log(`\nCo-host episodes (${cohostEps.length}):`);
    for (const ep of cohostEps) {
      console.log(`  ${ep.slug}: ${ep.cohosts.join(', ')} (co-host) + ${ep.guestSpeakers.join(', ') || 'no guest'}`);
    }
  }

  if (dryRun) {
    console.log('\n--- DRY RUN: Validating audio URLs ---');
    let valid = 0, invalid = 0;
    for (const ep of episodes) {
      if (!ep.audioUrl) {
        console.log(`  SKIP ${ep.slug}: no audioUrl`);
        invalid++;
        continue;
      }
      try {
        const res = await fetch(ep.audioUrl, { method: 'HEAD' });
        if (res.ok) {
          valid++;
        } else {
          console.log(`  FAIL ${ep.slug}: HTTP ${res.status}`);
          invalid++;
        }
      } catch (err) {
        console.log(`  FAIL ${ep.slug}: ${err.message}`);
        invalid++;
      }
    }
    console.log(`\nURL validation: ${valid} valid, ${invalid} invalid`);
    console.log('Dry run complete. No API calls made.');
    return;
  }

  // --- Stage 1: Submit new transcriptions ---
  const needSubmit = episodes.filter(ep => {
    const s = state[ep.slug];
    return !s || s.status === 'error' || !s.transcriptId;
  });

  const needPoll = episodes.filter(ep => {
    const s = state[ep.slug];
    return s?.status === 'submitted' && s.transcriptId;
  });

  console.log(`\nNew submissions: ${needSubmit.length}`);
  console.log(`Pending polls: ${needPoll.length}`);

  for (const ep of needSubmit) {
    if (!ep.audioUrl) {
      console.log(`SKIP ${ep.slug}: no audioUrl`);
      setEpisodeState(state, ep.slug, { status: 'error', error: 'no audioUrl' });
      continue;
    }

    try {
      console.log(`SUBMIT ${ep.slug} (${ep.speakersExpected} speakers)...`);
      const result = await submitOnly(ep.audioUrl, ep.speakersExpected);
      setEpisodeState(state, ep.slug, {
        status: 'submitted',
        transcriptId: result.id,
        speakersExpected: ep.speakersExpected,
      });
      console.log(`  → ID: ${result.id}`);
      await sleep(SUBMIT_DELAY);
    } catch (err) {
      console.error(`ERROR ${ep.slug}: ${err.message}`);
      setEpisodeState(state, ep.slug, { status: 'error', error: err.message });
    }
  }

  // --- Stage 2: Poll for completions ---
  const pending = episodes.filter(ep => state[ep.slug]?.status === 'submitted');

  if (pending.length === 0) {
    console.log('\nNo pending transcriptions to poll.');
    return;
  }

  console.log(`\nPolling ${pending.length} pending transcriptions...`);

  let completed = 0;
  let errors = 0;
  const total = pending.length;

  while (true) {
    const stillPending = [];

    for (const ep of pending) {
      const s = state[ep.slug];
      if (s.status !== 'submitted') continue;

      try {
        const result = await getTranscript(s.transcriptId);

        if (result.status === 'completed') {
          // Save raw JSON
          const outPath = join(OUTPUT_RAW, `${ep.slug}.json`);
          writeFileSync(outPath, JSON.stringify(result, null, 2));
          setEpisodeState(state, ep.slug, { status: 'transcribed' });
          completed++;
          console.log(`  ✓ ${ep.slug} (${completed}/${total})`);
        } else if (result.status === 'error') {
          setEpisodeState(state, ep.slug, { status: 'error', error: result.error || 'unknown' });
          errors++;
          console.error(`  ✗ ${ep.slug}: ${result.error}`);
        } else {
          stillPending.push(ep);
        }
      } catch (err) {
        console.error(`  POLL ERROR ${ep.slug}: ${err.message}`);
        stillPending.push(ep);
      }
    }

    // Replace pending list with still-pending
    pending.length = 0;
    pending.push(...stillPending);

    if (pending.length === 0) break;

    console.log(`  ... ${pending.length} still processing, waiting ${POLL_INTERVAL / 1000}s`);
    await sleep(POLL_INTERVAL);
  }

  console.log(`\n=== Done ===`);
  console.log(`Completed: ${completed}, Errors: ${errors}`);
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nInterrupted — state saved. Re-run to resume.');
  process.exit(0);
});

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
