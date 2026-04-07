#!/usr/bin/env node

/**
 * Phase 3: Tag Application — apply canonical taxonomy tags to all episodes.
 *
 * Uses Anthropic's Message Batches API (50% cheaper). Requires a curated
 * taxonomy file at src/_data/tagTaxonomy.json.
 *
 * Usage:
 *   node scripts/tag-episodes.mjs submit              # Submit batch
 *   node scripts/tag-episodes.mjs status              # Check batch status
 *   node scripts/tag-episodes.mjs results             # Download results and update episodes
 *   node scripts/tag-episodes.mjs results --dry-run   # Download but don't write to episodes
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import matter from 'gray-matter';
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

const TAXONOMY_FILE = join(import.meta.dirname, '..', 'src', '_data', 'tagTaxonomy.json');
const OUTPUT_DIR = join(import.meta.dirname, 'output', 'tags');
const TAG_RESULTS_DIR = join(OUTPUT_DIR, 'applied');
const BATCH_STATE_FILE = join(OUTPUT_DIR, 'apply-batch-state.json');

mkdirSync(TAG_RESULTS_DIR, { recursive: true });

const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes('--dry-run');
const batchIdIdx = args.indexOf('--batch');
const explicitBatchId = batchIdIdx !== -1 ? args[batchIdIdx + 1] : null;

const client = new Anthropic();

function loadTaxonomy() {
  if (!existsSync(TAXONOMY_FILE)) {
    console.error(`Taxonomy file not found: ${TAXONOMY_FILE}`);
    console.error('Run generate-taxonomy.mjs first, then curate the results into tagTaxonomy.json.');
    process.exit(1);
  }
  return JSON.parse(readFileSync(TAXONOMY_FILE, 'utf-8'));
}

function buildSystemPrompt(taxonomy) {
  const tagList = taxonomy.tags.map(t => {
    const aliases = t.aliases?.length ? ` (also: ${t.aliases.join(', ')})` : '';
    return `- ${t.name}${aliases}`;
  }).join('\n');

  return `You are tagging podcast episodes for a medical podcast about hypermobility and Ehlers-Danlos syndromes.

Given an episode's title, description, and transcript excerpt, select ALL tags that apply from the canonical list below. Only use tags from this list — do not invent new ones.

Canonical tags:
${tagList}

Rules:
- Select 3-8 tags per episode (most episodes should have 4-6)
- A tag applies if the episode substantively discusses that topic (not just a passing mention)
- Use alias names as hints — if the content mentions an alias, use the canonical tag name
- When in doubt, include the tag — it's better to over-tag slightly than to miss relevant content

Respond with ONLY a JSON array of tag names. Example:
["EDS", "Pain", "Physical Therapy"]`;
}

function loadBatchState() {
  if (existsSync(BATCH_STATE_FILE)) return JSON.parse(readFileSync(BATCH_STATE_FILE, 'utf-8'));
  return { batches: [] };
}

function saveBatchState(state) {
  writeFileSync(BATCH_STATE_FILE, JSON.stringify(state, null, 2));
}

async function submitBatch() {
  const taxonomy = loadTaxonomy();
  const episodes = parseAllEpisodes();
  const systemPrompt = buildSystemPrompt(taxonomy);

  // Skip already-applied episodes
  const done = new Set(
    existsSync(TAG_RESULTS_DIR)
      ? readdirSync(TAG_RESULTS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
      : []
  );

  const remaining = episodes.filter(ep => {
    if (done.has(ep.slug)) return false;
    if (!ep.description && ep.existingTranscript.length < 50) return false;
    return true;
  });

  if (remaining.length === 0) {
    console.log('All episodes already tagged!');
    return;
  }

  if (dryRun) {
    console.log(`Would tag ${remaining.length} episodes with ${taxonomy.tags.length} canonical tags.`);
    return;
  }

  console.log(`Submitting ${remaining.length} episodes (${taxonomy.tags.length} canonical tags)...\n`);

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
        system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content }],
      },
    });
  }

  const batch = await client.messages.batches.create({ requests });
  console.log(`Batch created: ${batch.id}`);
  console.log(`Requests: ${requests.length}`);

  const state = loadBatchState();
  state.batches.push({
    id: batch.id,
    count: requests.length,
    created_at: new Date().toISOString(),
  });
  saveBatchState(state);

  console.log(`\nCheck status: node scripts/tag-episodes.mjs status`);
  console.log(`Get results:  node scripts/tag-episodes.mjs results`);
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
    if (batch.ended_at) console.log(`  Ended: ${batch.ended_at}`);
    console.log();
  }
}

async function downloadResults() {
  const taxonomy = loadTaxonomy();
  const validTags = new Set(taxonomy.tags.map(t => t.name));

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

  const episodes = parseAllEpisodes();
  const episodeMap = new Map(episodes.map(ep => [ep.slug, ep]));

  let succeeded = 0;
  let errored = 0;
  let written = 0;

  for await (const result of await client.messages.batches.results(batchId)) {
    const slug = result.custom_id;

    if (result.result.type !== 'succeeded') {
      console.log(`✗ ${slug}: ${result.result.type}`);
      errored++;
      continue;
    }

    try {
      let text = result.result.message.content[0].text.trim();
      text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      const tags = JSON.parse(text);

      if (!Array.isArray(tags)) throw new Error('not an array');

      // Filter to only valid taxonomy tags
      const validatedTags = tags.filter(t => validTags.has(t));
      const invalid = tags.filter(t => !validTags.has(t));

      writeFileSync(join(TAG_RESULTS_DIR, `${slug}.json`), JSON.stringify({ slug, tags: validatedTags, invalid }, null, 2));

      if (invalid.length > 0) {
        console.log(`~ ${slug}: ${validatedTags.join(', ')} (dropped: ${invalid.join(', ')})`);
      } else {
        console.log(`✓ ${slug}: ${validatedTags.join(', ')}`);
      }
      succeeded++;

      // Write to episode file
      if (!dryRun) {
        const ep = episodeMap.get(slug);
        if (ep) {
          const raw = readFileSync(ep.filePath, 'utf-8');
          const { data, content } = matter(raw);
          data.tags = validatedTags;
          writeFileSync(ep.filePath, matter.stringify(content, data));
          written++;
        }
      }
    } catch (e) {
      console.log(`✗ ${slug}: ${e.message}`);
      errored++;
    }
  }

  // Tag distribution summary
  const tagCounts = {};
  for (const f of readdirSync(TAG_RESULTS_DIR).filter(f => f.endsWith('.json'))) {
    const data = JSON.parse(readFileSync(join(TAG_RESULTS_DIR, f), 'utf-8'));
    for (const tag of data.tags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Succeeded: ${succeeded}, Errored: ${errored}`);
  if (!dryRun) console.log(`Episodes updated: ${written}`);
  else console.log('(dry run — no episodes updated)');

  console.log(`\nTag distribution:`);
  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  for (const [tag, count] of sorted) {
    console.log(`  ${tag}: ${count}`);
  }
}

switch (command) {
  case 'submit': await submitBatch(); break;
  case 'status': await checkStatus(); break;
  case 'results': await downloadResults(); break;
  default:
    if (dryRun) { await submitBatch(); break; }
    console.log('Usage:');
    console.log('  node scripts/tag-episodes.mjs submit             # Submit batch');
    console.log('  node scripts/tag-episodes.mjs status             # Check status');
    console.log('  node scripts/tag-episodes.mjs results            # Download & update episodes');
    console.log('  node scripts/tag-episodes.mjs results --dry-run  # Download without updating');
    break;
}
