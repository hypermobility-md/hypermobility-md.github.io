#!/usr/bin/env node

/**
 * Re-proofread the back catalogue via the Anthropic Message Batches API.
 *
 * 50% cheaper than per-call requests, no streaming timeouts. The proofread
 * prompt, cast block, plain-text formatting, and timestamp/format logic are all
 * imported from the same libs the interactive pipeline uses, so batch output is
 * byte-identical to `transcribe-new.mjs` — just cheaper and in bulk.
 *
 * Caching: the (large, static) proofread system prompt is sent with
 * cache_control so it is written once and read on every subsequent request in
 * the batch. The per-episode transcript is unique and not cacheable.
 *
 * This re-derives everything from the cached AssemblyAI JSON in
 * scripts/output/raw/ — it does NOT call AssemblyAI, so only episodes with a
 * cached raw transcript are eligible (the local back catalogue, ~000–191).
 *
 * Workflow:
 *   node scripts/proofread-catalog-batch.mjs submit              # all cached episodes
 *   node scripts/proofread-catalog-batch.mjs submit --from 0 --to 191
 *   node scripts/proofread-catalog-batch.mjs submit --only 033,044,085
 *   node scripts/proofread-catalog-batch.mjs status
 *   node scripts/proofread-catalog-batch.mjs results             # write episode files
 *   node scripts/proofread-catalog-batch.mjs results --dry-run   # don't touch episodes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import { mapSpeakers } from './lib/speaker-map.mjs';
import { alignAndFormat } from './lib/format-transcript.mjs';
import {
  PROOFREAD_MODEL_DEFAULT,
  formatPlainText,
  buildProofreadUserContent,
  proofreadSystemBlock,
  parseProofreadResponse,
} from './lib/proofread.mjs';
import {
  loadTaxonomy,
  buildTagRequest,
  parseTagJson,
  resolveTags,
} from './lib/tagging.mjs';

// ── env ────────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dirname, '..');
const envPath = join(ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([^#=]+?)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

const RAW_DIR = join(import.meta.dirname, 'output', 'raw');
const PROOFREAD_DIR = join(import.meta.dirname, 'output', 'proofread');
const REPORTS_DIR = join(PROOFREAD_DIR, 'reports');
const STATE_FILE = join(PROOFREAD_DIR, 'catalog-batch-state.json');
mkdirSync(REPORTS_DIR, { recursive: true });

const client = new Anthropic();

const args = process.argv.slice(2);
const command = args[0];
const flag = (name, dflt = null) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : dflt;
};
const has = (name) => args.includes(name);

const MODEL = flag('--model', PROOFREAD_MODEL_DEFAULT);
const FROM = flag('--from') != null ? parseInt(flag('--from'), 10) : null;
const TO = flag('--to') != null ? parseInt(flag('--to'), 10) : null;
const ONLY = flag('--only') ? new Set(flag('--only').split(',').map((s) => s.trim())) : null;
const EXCLUDE = flag('--exclude') ? new Set(flag('--exclude').split(',').map((s) => s.trim())) : null;
const explicitBatch = flag('--batch');
const dryRun = has('--dry-run');

// ── shared helpers ───────────────────────────────────────────────────────────

/** Build the ad-stripped, name-labeled utterance list for one episode. */
function labelEpisode(raw, ep) {
  const utterances = raw.utterances || [];
  const { speakerMap, adSpeakers, contentStartIndex } = mapSpeakers(utterances, ep);
  const content = utterances.slice(contentStartIndex);
  const labeledUtterances = content
    .filter((u) => !adSpeakers.includes(u.speaker))
    .map((u) => ({
      speaker: u.speaker,
      speakerName: speakerMap[u.speaker] || `Speaker ${u.speaker}`,
      text: u.text,
      start: u.start,
      end: u.end,
    }));
  return { speakerMap, utterances: labeledUtterances };
}

function rawPath(slug) {
  return join(RAW_DIR, `${slug}.json`);
}

/** Episodes with a cached raw transcript, filtered by --from/--to/--only. */
function eligibleEpisodes() {
  return parseAllEpisodes()
    .filter((ep) => ep.num !== null && existsSync(rawPath(ep.slug)))
    .filter((ep) => (FROM == null || ep.num >= FROM) && (TO == null || ep.num <= TO))
    .filter((ep) => !ONLY || ONLY.has(ep.slug) || ONLY.has(String(ep.num)))
    .filter((ep) => !EXCLUDE || !(EXCLUDE.has(ep.slug) || EXCLUDE.has(String(ep.num))))
    .sort((a, b) => a.num - b.num);
}

function loadState() {
  return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf-8')) : { batches: [] };
}
function saveState(s) {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ── submit ───────────────────────────────────────────────────────────────────

async function submit() {
  const episodes = eligibleEpisodes();
  const requests = [];
  for (const ep of episodes) {
    const raw = JSON.parse(readFileSync(rawPath(ep.slug), 'utf-8'));
    const { utterances } = labelEpisode(raw, ep);
    const plain = formatPlainText(utterances);
    if (!plain.trim()) {
      console.log(`SKIP ${ep.slug}: empty after formatting`);
      continue;
    }
    const estIn = Math.round(plain.length / 4);
    const maxTokens = Math.min(64000, Math.max(20000, Math.round(estIn * 1.3)));
    requests.push({
      custom_id: ep.slug,
      params: {
        model: MODEL,
        max_tokens: maxTokens,
        system: proofreadSystemBlock(),
        messages: [{ role: 'user', content: buildProofreadUserContent(ep.slug, plain, ep) }],
      },
    });
  }

  if (requests.length === 0) {
    console.log('No eligible episodes.');
    return;
  }

  console.log(`Submitting ${requests.length} episodes as a batch (model: ${MODEL})...`);
  const batch = await client.messages.batches.create({ requests });
  console.log(`✓ Batch ${batch.id} — ${batch.processing_status} (${requests.length} requests)`);

  const state = loadState();
  state.batches.push({
    id: batch.id,
    model: MODEL,
    slugs: requests.map((r) => r.custom_id),
    created_at: new Date().toISOString(),
  });
  saveState(state);
  console.log(`\nPoll with:  node scripts/proofread-catalog-batch.mjs status`);
  console.log(`Finalize:   node scripts/proofread-catalog-batch.mjs results`);
}

// ── status ─────────────────────────────────────────────────────────────────

async function status() {
  const state = loadState();
  if (!state.batches.length) return console.log('No batches submitted.');
  for (const b of state.batches) {
    const batch = await client.messages.batches.retrieve(b.id);
    console.log(`${batch.id} [${b.model}] ${batch.processing_status} — ${JSON.stringify(batch.request_counts)}`);
  }
}

// ── results ──────────────────────────────────────────────────────────────────

async function tagEpisode(ep, transcript, taxonomy) {
  const msg = await client.messages.create(buildTagRequest(ep, transcript, taxonomy));
  const { tags } = resolveTags(parseTagJson(msg.content[0].text), taxonomy);
  return tags;
}

async function results() {
  const state = loadState();
  const batchId = explicitBatch || state.batches[state.batches.length - 1]?.id;
  if (!batchId) return console.log('No batch id. Submit first or pass --batch <id>.');

  const batch = await client.messages.batches.retrieve(batchId);
  console.log(`Batch ${batchId}: ${batch.processing_status} — ${JSON.stringify(batch.request_counts)}`);
  if (batch.processing_status !== 'ended') return console.log('Still processing; try later.');

  const episodeMap = new Map(parseAllEpisodes().map((ep) => [ep.slug, ep]));
  const taxonomy = (() => { try { return loadTaxonomy(ROOT); } catch { return null; } })();

  let ok = 0, failed = 0, totalIn = 0, totalOut = 0;
  const failures = [];

  for await (const result of await client.messages.batches.results(batchId)) {
    const slug = result.custom_id;
    if (result.result.type !== 'succeeded') {
      const reason = result.result.type === 'errored' ? result.result.error?.message : result.result.type;
      console.log(`✗ ${slug}: ${reason}`);
      failures.push({ slug, reason });
      failed++;
      continue;
    }

    const msg = result.result.message;
    totalIn += msg.usage.input_tokens;
    totalOut += msg.usage.output_tokens;
    const responseText = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('');

    let transcript, report;
    try {
      ({ transcript, report } = parseProofreadResponse(responseText));
    } catch (e) {
      console.log(`✗ ${slug}: ${e.message}`);
      failures.push({ slug, reason: e.message });
      failed++;
      continue;
    }

    writeFileSync(join(PROOFREAD_DIR, `${slug}.md`), transcript);
    writeFileSync(join(REPORTS_DIR, `${slug}.json`), JSON.stringify({
      episode: slug,
      ads_removed: report.ads_removed || [],
      flags: report.flags || [],
      changes_summary: report.changes_summary || '',
      usage: { input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens },
    }, null, 2));

    const ep = episodeMap.get(slug);
    if (!ep) { console.log(`~ ${slug}: proofread saved, no episode match to write`); ok++; continue; }

    // Re-derive raw words + utterances for paragraph timestamps + switch fill.
    const raw = JSON.parse(readFileSync(rawPath(slug), 'utf-8'));
    const { speakerMap, utterances } = labelEpisode(raw, ep);
    const castNames = new Set([
      ...Object.values(speakerMap),
      'Dr. Linda Bluestein',
      ...(ep.cohosts || []),
      ...(ep.guestSpeakers || []),
    ].filter(Boolean));
    const { text: timestamped, pct } = alignAndFormat(transcript, raw.words || [], castNames, utterances);

    let tags = [];
    if (taxonomy) {
      try { tags = await tagEpisode(ep, timestamped, taxonomy); } catch (e) { console.log(`  ⚠ ${slug} tag: ${e.message}`); }
    }

    if (!dryRun) {
      const { data } = matter(readFileSync(ep.filePath, 'utf-8'));
      if (tags.length) data.tags = tags;
      writeFileSync(ep.filePath, matter.stringify(timestamped, data));
    }
    const swap = (report.flags || []).some((f) => f.type === 'speaker-id');
    console.log(`✓ ${slug} — ${pct}% stamped${swap ? ', speaker-id flag' : ''}${tags.length ? `, tags: ${tags.length}` : ''}${dryRun ? ' (dry-run)' : ''}`);
    ok++;
  }

  // Sonnet batch pricing: $1.50/MTok in, $7.50/MTok out.
  const cost = (totalIn / 1e6) * 1.5 + (totalOut / 1e6) * 7.5;
  console.log(`\n=== Summary ===\nWrote ${ok}, failed ${failed}. Tokens ${totalIn} in / ${totalOut} out. ~$${cost.toFixed(2)} (proofread, batch rate).`);
  if (failures.length) failures.forEach((f) => console.log(`  ✗ ${f.slug}: ${f.reason}`));
}

// ── reformat (no API) ────────────────────────────────────────────────────────
// Re-apply the current timestamp/format logic to episodes whose proofread text
// is already cached. Used to propagate a formatter fix without re-proofreading.

function reformat() {
  const eps = eligibleEpisodes().filter((ep) => existsSync(join(PROOFREAD_DIR, `${ep.slug}.md`)));
  let done = 0;
  for (const ep of eps) {
    const transcript = readFileSync(join(PROOFREAD_DIR, `${ep.slug}.md`), 'utf-8');
    const raw = JSON.parse(readFileSync(rawPath(ep.slug), 'utf-8'));
    const { speakerMap, utterances } = labelEpisode(raw, ep);
    const castNames = new Set([
      ...Object.values(speakerMap), 'Dr. Linda Bluestein',
      ...(ep.cohosts || []), ...(ep.guestSpeakers || []),
    ].filter(Boolean));
    const { text, pct } = alignAndFormat(transcript, raw.words || [], castNames, utterances);
    if (!dryRun) {
      const { data } = matter(readFileSync(ep.filePath, 'utf-8'));
      writeFileSync(ep.filePath, matter.stringify(text, data));
    }
    console.log(`✓ ${ep.slug} reformatted (${pct}% stamped)${dryRun ? ' (dry-run)' : ''}`);
    done++;
  }
  console.log(`\nReformatted ${done} episodes (no API).`);
}

// ── main ─────────────────────────────────────────────────────────────────────

switch (command) {
  case 'submit': await submit(); break;
  case 'status': await status(); break;
  case 'results': await results(); break;
  case 'reformat': reformat(); break;
  default:
    console.log('Usage: submit|results [--from N --to N --only a,b --exclude a,b] [--model M] | status | reformat [--only a,b] [--dry-run]');
}
