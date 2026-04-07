#!/usr/bin/env node

/**
 * Phase 1: Taxonomy Discovery — survey all episodes to discover natural tag clusters.
 *
 * Uses Anthropic's Message Batches API (50% cheaper) to suggest tags for each episode.
 * Aggregates results into a frequency-sorted candidate list.
 *
 * Usage:
 *   node scripts/generate-taxonomy.mjs submit         # Submit batch
 *   node scripts/generate-taxonomy.mjs status         # Check batch status
 *   node scripts/generate-taxonomy.mjs results        # Download and aggregate results
 *   node scripts/generate-taxonomy.mjs --dry-run      # Preview without API calls
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import Anthropic from '@anthropic-ai/sdk';

// Load .env
const envPath = join(import.meta.dirname, '..', '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2];
    }
  }
}

const OUTPUT_DIR = join(import.meta.dirname, 'output', 'tags');
const PER_EPISODE_DIR = join(OUTPUT_DIR, 'per-episode');
const CANDIDATES_FILE = join(OUTPUT_DIR, 'tag-candidates.json');
const BATCH_STATE_FILE = join(OUTPUT_DIR, 'batch-state.json');

mkdirSync(PER_EPISODE_DIR, { recursive: true });

const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes('--dry-run');
const batchIdIdx = args.indexOf('--batch');
const explicitBatchId = batchIdIdx !== -1 ? args[batchIdIdx + 1] : null;

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a podcast content tagger for a medical podcast about hypermobility, Ehlers-Danlos syndromes, and related conditions.

Given an episode's title, description, and transcript excerpt, suggest 5-10 topic tags that describe what this episode covers.

Rules:
- Use short, Title Case labels (e.g., "Mental Health", "Physical Therapy", "EDS")
- Use standard medical abbreviations where common (EDS, POTS, MCAS, ME/CFS)
- Focus on: medical conditions, body systems, treatment approaches, specialties, and lifestyle topics
- Be specific but not too narrow — tags should be reusable across multiple episodes
- Do NOT include guest names, episode numbers, or the podcast name as tags
- Do NOT include generic tags like "Health", "Medicine", or "Podcast"

Respond with ONLY a JSON array of strings. Example:
["EDS", "Physical Therapy", "Pain Management", "Dance", "Injury Prevention"]`;

function loadBatchState() {
  if (existsSync(BATCH_STATE_FILE)) return JSON.parse(readFileSync(BATCH_STATE_FILE, 'utf-8'));
  return { batches: [] };
}

function saveBatchState(state) {
  writeFileSync(BATCH_STATE_FILE, JSON.stringify(state, null, 2));
}

async function submitBatch() {
  const episodes = parseAllEpisodes();

  // Skip episodes already processed
  const done = new Set();
  const files = existsSync(PER_EPISODE_DIR) ? (await import('fs')).readdirSync(PER_EPISODE_DIR) : [];
  for (const f of files) {
    if (f.endsWith('.json')) done.add(f.replace('.json', ''));
  }

  const remaining = episodes.filter(ep => {
    if (done.has(ep.slug)) return false;
    if (!ep.description && ep.existingTranscript.length < 50) return false;
    return true;
  });

  if (remaining.length === 0) {
    console.log('All episodes already processed!');
    return;
  }

  if (dryRun) {
    console.log(`Would process ${remaining.length} episodes.`);
    const withTranscript = remaining.filter(ep => ep.existingTranscript.length > 100).length;
    console.log(`With transcript: ${withTranscript}, Description only: ${remaining.length - withTranscript}`);
    return;
  }

  console.log(`Submitting ${remaining.length} episodes as batch...\n`);

  const requests = [];
  for (const ep of remaining) {
    const transcript = ep.existingTranscript || '';
    const excerpt = transcript.split(/\s+/).slice(0, 500).join(' ');

    const content = `Title: ${ep.title}
Description: ${ep.description}
${excerpt ? `\nTranscript excerpt:\n${excerpt}` : ''}`;

    requests.push({
      custom_id: ep.slug,
      params: {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      },
    });
  }

  const batch = await client.messages.batches.create({ requests });
  console.log(`Batch created: ${batch.id}`);
  console.log(`Status: ${batch.processing_status}`);
  console.log(`Requests: ${requests.length}`);

  const state = loadBatchState();
  state.batches.push({
    id: batch.id,
    count: requests.length,
    created_at: new Date().toISOString(),
  });
  saveBatchState(state);

  console.log(`\nCheck status: node scripts/generate-taxonomy.mjs status`);
  console.log(`Get results:  node scripts/generate-taxonomy.mjs results`);
}

async function checkStatus() {
  const state = loadBatchState();
  if (state.batches.length === 0) {
    console.log('No batches submitted yet.');
    return;
  }
  for (const info of state.batches) {
    const batch = await client.messages.batches.retrieve(info.id);
    console.log(`Batch: ${batch.id}`);
    console.log(`  Status: ${batch.processing_status}`);
    console.log(`  Counts:`, JSON.stringify(batch.request_counts));
    console.log(`  Created: ${batch.created_at}`);
    if (batch.ended_at) console.log(`  Ended: ${batch.ended_at}`);
    console.log();
  }
}

async function downloadResults() {
  const state = loadBatchState();
  const batchId = explicitBatchId || state.batches[state.batches.length - 1]?.id;
  if (!batchId) {
    console.log('No batch ID found. Submit a batch first.');
    return;
  }

  const batch = await client.messages.batches.retrieve(batchId);
  console.log(`Batch ${batchId}: ${batch.processing_status}`);
  if (batch.processing_status !== 'ended') {
    console.log('Batch still processing. Try again later.');
    return;
  }

  console.log('Downloading results...\n');

  let succeeded = 0;
  let errored = 0;
  const allTags = {};

  for await (const result of await client.messages.batches.results(batchId)) {
    const slug = result.custom_id;

    if (result.result.type === 'succeeded') {
      try {
        let text = result.result.message.content[0].text.trim();
        text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        const tags = JSON.parse(text);

        if (Array.isArray(tags)) {
          writeFileSync(join(PER_EPISODE_DIR, `${slug}.json`), JSON.stringify({ slug, tags }, null, 2));
          for (const tag of tags) {
            allTags[tag] = (allTags[tag] || 0) + 1;
          }
          console.log(`✓ ${slug}: ${tags.join(', ')}`);
          succeeded++;
        } else {
          console.log(`✗ ${slug}: response not an array`);
          errored++;
        }
      } catch (e) {
        console.log(`✗ ${slug}: parse error — ${e.message}`);
        errored++;
      }
    } else {
      console.log(`✗ ${slug}: ${result.result.type}`);
      errored++;
    }
  }

  // Aggregate from all per-episode files (including previously processed)
  const { readdirSync } = await import('fs');
  const finalTags = {};
  let totalEpisodes = 0;
  for (const f of readdirSync(PER_EPISODE_DIR).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(PER_EPISODE_DIR, f), 'utf-8'));
    for (const tag of data.tags || []) {
      finalTags[tag] = (finalTags[tag] || 0) + 1;
    }
    totalEpisodes++;
  }

  const sorted = Object.entries(finalTags)
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count, pct: Math.round(count / totalEpisodes * 100) }));

  writeFileSync(CANDIDATES_FILE, JSON.stringify(sorted, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`This batch: ${succeeded} succeeded, ${errored} errored`);
  console.log(`Total episodes tagged: ${totalEpisodes}`);
  console.log(`Unique tags: ${sorted.length}`);
  console.log(`Output: ${CANDIDATES_FILE}`);

  console.log(`\nTop 30 tags:`);
  for (const { tag, count, pct } of sorted.slice(0, 30)) {
    console.log(`  ${tag}: ${count} episodes (${pct}%)`);
  }
}

switch (command) {
  case 'submit': await submitBatch(); break;
  case 'status': await checkStatus(); break;
  case 'results': await downloadResults(); break;
  default:
    if (dryRun) { await submitBatch(); break; }
    console.log('Usage:');
    console.log('  node scripts/generate-taxonomy.mjs submit    # Submit batch');
    console.log('  node scripts/generate-taxonomy.mjs status    # Check status');
    console.log('  node scripts/generate-taxonomy.mjs results   # Download results');
    break;
}
