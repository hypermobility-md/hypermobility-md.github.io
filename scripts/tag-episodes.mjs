#!/usr/bin/env node

/**
 * Apply canonical taxonomy tags to episodes.
 *
 * Tagging logic (prompt, alias resolution, 3-8 cap) lives in lib/tagging.mjs
 * and is shared with the inline tagger in transcribe-new.mjs.
 *
 * Two modes:
 *
 *   Batch (cheap, async — for the whole catalog):
 *     node scripts/tag-episodes.mjs submit              # Submit batch
 *     node scripts/tag-episodes.mjs status              # Check batch status
 *     node scripts/tag-episodes.mjs results             # Download results, write episodes
 *     node scripts/tag-episodes.mjs results --dry-run   # Download but don't write
 *
 *   Direct (immediate — for a small set):
 *     node scripts/tag-episodes.mjs retag --outliers    # Re-tag episodes with <3 or >8 tags
 *     node scripts/tag-episodes.mjs retag 193 197 013   # Re-tag specific episodes by slug
 *     node scripts/tag-episodes.mjs retag --outliers --dry-run
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import {
  loadTaxonomy,
  buildSystemPrompt,
  buildUserContent,
  buildTagRequest,
  parseTagJson,
  resolveTags,
  TAG_MIN,
  TAG_MAX,
} from './lib/tagging.mjs';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';

const ROOT = join(import.meta.dirname, '..');

// Load .env (without overriding already-set vars)
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const OUTPUT_DIR = join(ROOT, 'scripts', 'output', 'tags');
const TAG_RESULTS_DIR = join(OUTPUT_DIR, 'applied');
const BATCH_STATE_FILE = join(OUTPUT_DIR, 'apply-batch-state.json');
mkdirSync(TAG_RESULTS_DIR, { recursive: true });

const args = process.argv.slice(2);
const command = args[0];
const dryRun = args.includes('--dry-run');
const batchIdIdx = args.indexOf('--batch');
const explicitBatchId = batchIdIdx !== -1 ? args[batchIdIdx + 1] : null;

const client = new Anthropic();
const MODEL = 'claude-haiku-4-5-20251001';

/** Write a resolved tag list back into an episode markdown file. */
function writeTags(filePath, tags) {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  data.tags = tags;
  writeFileSync(filePath, matter.stringify(content, data));
}

function loadBatchState() {
  if (existsSync(BATCH_STATE_FILE)) return JSON.parse(readFileSync(BATCH_STATE_FILE, 'utf-8'));
  return { batches: [] };
}
function saveBatchState(state) {
  writeFileSync(BATCH_STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Direct mode: re-tag a small, targeted set immediately ────────────────────

async function retag() {
  const taxonomy = loadTaxonomy(ROOT);
  const episodes = parseAllEpisodes();

  const explicitSlugs = args.slice(1).filter(a => !a.startsWith('--'));
  let targets;
  if (explicitSlugs.length) {
    const bySlug = new Map(episodes.map(ep => [ep.slug, ep]));
    targets = explicitSlugs.map(s => bySlug.get(s)).filter(Boolean);
    const missing = explicitSlugs.filter(s => !bySlug.has(s));
    if (missing.length) console.log(`⚠  Unknown slugs ignored: ${missing.join(', ')}`);
  } else if (args.includes('--outliers')) {
    targets = episodes.filter(ep => {
      const n = (ep.tags || []).length;
      return n < TAG_MIN || n > TAG_MAX;
    });
  } else {
    console.log('Specify episodes: `retag --outliers` or `retag <slug> [<slug>...]`');
    return;
  }

  if (targets.length === 0) {
    console.log('No matching episodes to re-tag.');
    return;
  }

  console.log(`Re-tagging ${targets.length} episode(s)${dryRun ? ' (dry run)' : ''}...\n`);

  for (const ep of targets) {
    const transcript = ep.existingTranscript || ''; // lib clamps to MAX_TRANSCRIPT_WORDS
    let resolved;
    try {
      const msg = await client.messages.create(buildTagRequest(ep, transcript, taxonomy, MODEL));
      resolved = resolveTags(parseTagJson(msg.content[0].text), taxonomy);
    } catch (e) {
      console.log(`✗ ${ep.slug}: ${e.message}`);
      continue;
    }
    const before = (ep.tags || []).join(', ') || '(none)';
    const note = resolved.dropped.length ? ` (dropped: ${resolved.dropped.join(', ')})` : '';
    console.log(`${dryRun ? '~' : '✓'} ${ep.slug}: [${before}] → [${resolved.tags.join(', ')}]${note}`);
    if (!dryRun) writeTags(ep.filePath, resolved.tags);
  }
}

// ── Batch mode: tag the whole catalog cheaply (async) ────────────────────────

async function submitBatch() {
  const taxonomy = loadTaxonomy(ROOT);
  const episodes = parseAllEpisodes();
  const system = buildSystemPrompt(taxonomy);

  const done = new Set(
    readdirSync(TAG_RESULTS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''))
  );

  const remaining = episodes.filter(ep => {
    if (done.has(ep.slug)) return false;
    if (!ep.description && ep.existingTranscript.length < 50) return false;
    return true;
  });

  if (remaining.length === 0) return console.log('All episodes already tagged!');
  if (dryRun) return console.log(`Would tag ${remaining.length} episodes with ${taxonomy.tags.length} canonical tags.`);

  console.log(`Submitting ${remaining.length} episodes (${taxonomy.tags.length} canonical tags)...\n`);

  const requests = remaining.map(ep => {
    const transcript = ep.existingTranscript || ''; // lib clamps to MAX_TRANSCRIPT_WORDS
    return {
      custom_id: ep.slug,
      params: {
        model: MODEL,
        max_tokens: 256,
        system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: buildUserContent({ ...ep, transcript }) }],
      },
    };
  });

  const batch = await client.messages.batches.create({ requests });
  console.log(`Batch created: ${batch.id}\nRequests: ${requests.length}`);

  const state = loadBatchState();
  state.batches.push({ id: batch.id, count: requests.length, created_at: new Date().toISOString() });
  saveBatchState(state);

  console.log(`\nCheck status: node scripts/tag-episodes.mjs status`);
  console.log(`Get results:  node scripts/tag-episodes.mjs results`);
}

async function checkStatus() {
  const state = loadBatchState();
  if (state.batches.length === 0) return console.log('No batches submitted yet.');
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
  const taxonomy = loadTaxonomy(ROOT);
  const state = loadBatchState();
  const batchId = explicitBatchId || state.batches[state.batches.length - 1]?.id;
  if (!batchId) return console.log('No batch ID found. Submit a batch first.');

  const batch = await client.messages.batches.retrieve(batchId);
  console.log(`Batch ${batchId}: ${batch.processing_status}`);
  if (batch.processing_status !== 'ended') return console.log('Batch still processing. Try again later.');

  console.log('Downloading results...\n');

  const episodes = parseAllEpisodes();
  const episodeMap = new Map(episodes.map(ep => [ep.slug, ep]));

  let succeeded = 0, errored = 0, written = 0;

  for await (const result of await client.messages.batches.results(batchId)) {
    const slug = result.custom_id;
    if (result.result.type !== 'succeeded') {
      console.log(`✗ ${slug}: ${result.result.type}`);
      errored++;
      continue;
    }
    try {
      const { tags, dropped } = resolveTags(parseTagJson(result.result.message.content[0].text), taxonomy);
      writeFileSync(join(TAG_RESULTS_DIR, `${slug}.json`), JSON.stringify({ slug, tags, dropped }, null, 2));
      console.log(dropped.length ? `~ ${slug}: ${tags.join(', ')} (dropped: ${dropped.join(', ')})` : `✓ ${slug}: ${tags.join(', ')}`);
      succeeded++;
      if (!dryRun) {
        const ep = episodeMap.get(slug);
        if (ep) { writeTags(ep.filePath, tags); written++; }
      }
    } catch (e) {
      console.log(`✗ ${slug}: ${e.message}`);
      errored++;
    }
  }

  // Tag distribution summary
  const tagCounts = {};
  for (const f of readdirSync(TAG_RESULTS_DIR).filter(f => f.endsWith('.json'))) {
    for (const tag of JSON.parse(readFileSync(join(TAG_RESULTS_DIR, f), 'utf-8')).tags || []) {
      tagCounts[tag] = (tagCounts[tag] || 0) + 1;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Succeeded: ${succeeded}, Errored: ${errored}`);
  console.log(dryRun ? '(dry run — no episodes updated)' : `Episodes updated: ${written}`);
  console.log(`\nTag distribution:`);
  for (const [tag, count] of Object.entries(tagCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${tag}: ${count}`);
  }
}

switch (command) {
  case 'retag': await retag(); break;
  case 'submit': await submitBatch(); break;
  case 'status': await checkStatus(); break;
  case 'results': await downloadResults(); break;
  default:
    if (dryRun) { await submitBatch(); break; }
    console.log('Usage:');
    console.log('  Direct:  node scripts/tag-episodes.mjs retag --outliers');
    console.log('           node scripts/tag-episodes.mjs retag <slug> [<slug>...]');
    console.log('  Batch:   node scripts/tag-episodes.mjs submit | status | results');
    break;
}
