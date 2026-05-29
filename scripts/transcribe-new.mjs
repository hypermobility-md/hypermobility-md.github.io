#!/usr/bin/env node

/**
 * Transcribe new podcast episodes end-to-end.
 *
 * Pipeline:
 *   1. Submit to AssemblyAI → raw transcript with word-level timestamps
 *   2. Label speakers (map A/B/C → real names)
 *   3. Format as plain text for proofreading
 *   4. Proofread with Claude (fix speakers, terminology, remove ads + fillers)
 *   5. Add timestamps via word-level alignment
 *   6. Write to episode file
 *
 * Usage:
 *   node scripts/transcribe-new.mjs                # Transcribe all new episodes
 *   node scripts/transcribe-new.mjs --dry-run      # Show what would be transcribed
 *   node scripts/transcribe-new.mjs --max 3        # Limit to 3 episodes per run
 *   node scripts/transcribe-new.mjs --episode 190  # Single episode
 *   node scripts/transcribe-new.mjs --episode 50 --force  # Re-process with existing raw data
 *   node scripts/transcribe-new.mjs --model claude-haiku-4-5-20251001  # Use Haiku for proofreading (default: Sonnet)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import { buildTagRequest, parseTagJson, resolveTags } from './lib/tagging.mjs';
import { submitTranscription } from './lib/assemblyai-helpers.mjs';
import { mapSpeakers } from './lib/speaker-map.mjs';
import { alignAndFormat } from './lib/format-transcript.mjs';
import {
  PROOFREAD_MAX_TOKENS,
  LONG_CONTEXT_BETA,
  formatPlainText,
  buildProofreadUserContent,
  proofreadSystemBlock,
  parseProofreadResponse,
} from './lib/proofread.mjs';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';

// Load .env for local development
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

const SCRIPTS_DIR = import.meta.dirname;
const OUTPUT_RAW = join(SCRIPTS_DIR, 'output', 'raw');
const OUTPUT_LABELED = join(SCRIPTS_DIR, 'output', 'labeled');
const OUTPUT_FORMATTED = join(SCRIPTS_DIR, 'output', 'formatted');
const OUTPUT_PROOFREAD = join(SCRIPTS_DIR, 'output', 'proofread');
const REPORTS_DIR = join(OUTPUT_PROOFREAD, 'reports');
const GUEST_PROFILES_DIR = join(SCRIPTS_DIR, '..', 'src', 'guest-profiles');

// Hosts and recurring co-hosts whose profiles aren't auto-created from episodes
// (their guestImages.json entry covers the photo; bios are managed elsewhere).
const HOST_KEYS = new Set(['linda bluestein']);

mkdirSync(OUTPUT_RAW, { recursive: true });
mkdirSync(OUTPUT_LABELED, { recursive: true });
mkdirSync(OUTPUT_FORMATTED, { recursive: true });
mkdirSync(OUTPUT_PROOFREAD, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const maxIdx = args.indexOf('--max');
const maxEpisodes = maxIdx !== -1 ? parseInt(args[maxIdx + 1], 10) : 5;
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;
const modelIdx = args.indexOf('--model');
const PROOFREAD_MODEL = modelIdx !== -1 ? args[modelIdx + 1] : 'claude-sonnet-4-6';

const anthropic = new Anthropic({
  timeout: 30 * 60 * 1000, // 30 min — Sonnet needs more time for long transcripts
});

// ── Proofreading ──────────────────────────────────────────────────────
// The prompt, cast, user-message, and response parsing live in
// lib/proofread.mjs (shared with the batch runner so they can't drift).

const MAX_RETRIES = 5;

/**
 * Proofread a full transcript in a single streamed Sonnet 4.6 call.
 *
 * Uses the 1M-context beta header so even ~3-hour episodes (~40k input tokens)
 * fit in one request. Streams to avoid SDK HTTP timeouts on long outputs.
 *
 * @param {string} slug - Episode slug
 * @param {string} text - Full transcript text
 * @param {object} episode - Episode object with title and description for context
 */
async function proofreadTranscript(slug, text, episode) {
  const wordCount = text.split(/\s+/).length;

  console.log(`  Proofreading with ${PROOFREAD_MODEL} (1M context, single pass, ${wordCount} words)...`);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const stream = anthropic.beta.messages.stream({
        model: PROOFREAD_MODEL,
        max_tokens: PROOFREAD_MAX_TOKENS,
        betas: [LONG_CONTEXT_BETA],
        system: proofreadSystemBlock(),
        messages: [{ role: 'user', content: buildProofreadUserContent(slug, text, episode) }],
      });

      const message = await stream.finalMessage();

      if (message.stop_reason === 'max_tokens') {
        throw new Error(`Proofread output truncated at ${PROOFREAD_MAX_TOKENS} max_tokens`);
      }

      const responseText = message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('');

      const { transcript, report } = parseProofreadResponse(responseText);

      return {
        transcript,
        report,
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
          cache_read_input_tokens: message.usage.cache_read_input_tokens || 0,
          cache_creation_input_tokens: message.usage.cache_creation_input_tokens || 0,
        },
      };
    } catch (err) {
      // Retry on rate limits / overload / 5xx AND transient network failures
      // (APIConnectionError, "Connection error", socket "terminated").
      const isNetwork = err?.status == null &&
        (/connection|terminated|socket|network|timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(err?.message || '') ||
         /APIConnection/.test(err?.name || ''));
      const isRetryable = err?.status === 429 || err?.status === 529 || err?.status >= 500 || isNetwork;
      if (isRetryable && attempt < MAX_RETRIES) {
        const backoff = (err?.status === 429 ? 15000 : 5000) * attempt;
        console.log(`  ⚠ ${slug} ${err.status || 'error'} attempt ${attempt}, retrying in ${backoff / 1000}s...`);
        await new Promise(r => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}


// Timestamp alignment + formatting lives in lib/format-transcript.mjs
// (alignAndFormat), shared with the back-catalogue reformatter.

// ── Auto-tagging ──────────────────────────────────────────────────────

/**
 * Tag a single episode using the canonical taxonomy.
 * Used for new episodes in the pipeline (not batch). Shares prompt/resolution
 * logic with the batch tagger via scripts/lib/tagging.mjs.
 */
async function tagEpisode(ep, transcript, taxonomy) {
  const message = await anthropic.messages.create(buildTagRequest(ep, transcript, taxonomy));
  const { tags } = resolveTags(parseTagJson(message.content[0].text), taxonomy);
  return tags;
}

// ── Guest profile auto-creation ───────────────────────────────────────

/**
 * Slug a guest key for use as a profile filename.
 * "adji cissoko" → "adji-cissoko", "jo-anne la flèche" → "jo-anne-la-flèche"
 */
function profileSlug(key) {
  return key.trim().toLowerCase().replace(/\s+/g, '-');
}

/**
 * Mirror of normalizeGuestKey from speaker-map / eleventy.config.js.
 * Strips titles ("Dr.") and trailing credentials ("MD", "PhD") and lowercases.
 */
function normalizeGuestKey(name) {
  if (!name) return '';
  let n = name.replace(/^(Dr\.?|Prof\.?|Professor)\s+/i, '');
  let prev;
  do {
    prev = n;
    n = n.replace(/[,\s]+(M\.?D\.?|Ph\.?D\.?|D\.?P\.?T\.?|D\.?O\.?|P\.?A\.?-?C?|R\.?D\.?N\.?|O\.?T\.?|P\.?T\.?|J\.?D\.?|LICSW|NCPT|ATC|MS|MA|MPT|DMSC|MRCPsych|DDS|D\.?C\.?|FACP|FACS|FAANS|FAAFP|FAAN|FAMSSM|FACOG|FRCPC|IFMCP|ABIHM|CCSP|CEDS-S|FAED|CHT|CYT|CHC|CMTPT|COMT|NCS|OCS|CES|MHCM)\.?\s*$/i, '');
  } while (n !== prev);
  return n.replace(/[,.\s]+$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

const GUEST_BIO_SYSTEM_PROMPT = `You generate concise guest profiles for the Bendy Bodies Podcast (a medical podcast about hypermobility, EDS, MCAS, POTS, and related conditions hosted by Dr. Linda Bluestein).

You will receive a guest's name and the episode title and description that introduces them.

Your job: produce a short, factual profile entry IF you can confidently identify the guest as a real, public-facing professional (clinician, researcher, author, dancer, athlete, etc.) using your training data and the episode context. The episode description often quotes the guest's credentials and affiliation directly — those quotes are authoritative.

Do NOT fabricate information. Only include facts you are confident about. If you do not recognize the guest and the episode description does not provide enough information, return {"unknown": true}. It's far better to skip than to invent.

Output strict JSON in this exact shape:

{
  "bio": "1-3 sentence factual bio in plain prose",
  "credentials": "comma-separated credentials, e.g. 'MD, PhD' (omit if none mentioned)",
  "affiliation": "primary current affiliation (omit if not confident)",
  "website": "https://... (omit unless you are sure of the URL)"
}

Or, if you cannot confidently identify them:

{ "unknown": true }

Output ONLY the JSON object, no surrounding prose.`;

/**
 * Generate a guest bio via Sonnet 4.6.
 * Returns { bio, credentials?, affiliation?, website? } or null if the model
 * couldn't confidently identify the guest.
 */
async function generateGuestBio(guestName, ep) {
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: [{ type: 'text', text: GUEST_BIO_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content: `Guest: ${guestName}\n\nEpisode title: ${ep.title}\n\nEpisode description:\n${ep.description || '(no description)'}\n\nReturn the JSON object now.`,
    }],
  });

  const text = message.content
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (parsed.unknown) return null;
  if (!parsed.bio || typeof parsed.bio !== 'string') return null;

  const profile = { bio: parsed.bio.trim() };
  for (const field of ['credentials', 'affiliation', 'website']) {
    if (typeof parsed[field] === 'string' && parsed[field].trim()) {
      profile[field] = parsed[field].trim();
    }
  }
  return profile;
}

/**
 * For each guest in the episode, create a guest-profiles/<slug>.json file
 * if one doesn't already exist. Skips hosts and unknown guests.
 *
 * Returns an array of { key, action } records for the run summary.
 */
async function ensureGuestProfiles(ep) {
  const guests = ep.guests || [];
  const records = [];

  for (const guestName of guests) {
    const key = normalizeGuestKey(guestName);
    if (!key || key.length < 3) continue;
    if (HOST_KEYS.has(key)) {
      records.push({ key, action: 'skipped-host' });
      continue;
    }

    const slug = profileSlug(key);
    const filePath = join(GUEST_PROFILES_DIR, `${slug}.json`);
    if (existsSync(filePath)) {
      records.push({ key, action: 'existing' });
      continue;
    }

    try {
      const profile = await generateGuestBio(guestName, ep);
      if (!profile) {
        records.push({ key, action: 'unknown' });
        continue;
      }
      const data = { key, ...profile };
      mkdirSync(GUEST_PROFILES_DIR, { recursive: true });
      writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      records.push({ key, action: 'created' });
    } catch (err) {
      records.push({ key, action: 'error', error: err.message });
    }
  }

  return records;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
  const allEpisodes = parseAllEpisodes();

  // When using --force with --episode, search all episodes.
  // Otherwise, only scan the most recent ones.
  let scanPool;
  if (force && singleEpisode) {
    scanPool = allEpisodes;
  } else {
    const SCAN_WINDOW = 20;
    const recentEpisodes = allEpisodes
      .filter(ep => ep.num !== null)
      .sort((a, b) => b.num - a.num)
      .slice(0, SCAN_WINDOW);
    const bonusEpisodes = allEpisodes.filter(ep => ep.num === null);
    scanPool = [...recentEpisodes, ...bonusEpisodes];
  }

  // Find episodes needing transcription
  let candidates = scanPool.filter(ep => {
    if (!ep.audioUrl) return false;
    if (!force && ep.existingTranscript.length > 100) return false;
    return true;
  });

  if (singleEpisode) {
    candidates = candidates.filter(ep =>
      ep.slug === singleEpisode || String(ep.num) === singleEpisode
    );
  }

  if (candidates.length > maxEpisodes) {
    console.log(`Capping at ${maxEpisodes} episodes (${candidates.length} eligible). Use --max to change.`);
    candidates = candidates.slice(0, maxEpisodes);
  }

  if (candidates.length === 0) {
    console.log('No episodes need transcription.');
    return;
  }

  console.log(`\n=== Transcribe New Episodes ===`);
  console.log(`Episodes to process: ${candidates.length}`);
  for (const ep of candidates) {
    console.log(`  ${ep.slug}: "${ep.title}" (${ep.speakersExpected} speakers)`);
  }

  if (dryRun) {
    console.log('\nDry run — no API calls made.');
    return;
  }

  let succeeded = 0;
  let failed = 0;

  for (const ep of candidates) {
    console.log(`\n── Processing ${ep.slug} ──`);

    try {
      // Stage 1: Submit to AssemblyAI (or use cached raw JSON)
      const rawCachePath = join(OUTPUT_RAW, `${ep.slug}.json`);
      let raw;

      if (existsSync(rawCachePath)) {
        raw = JSON.parse(readFileSync(rawCachePath, 'utf-8'));
        console.log(`  ✓ Using cached transcription (${raw.utterances?.length || 0} utterances, ${raw.words?.length || 0} words)`);
      } else {
        console.log(`  Submitting to AssemblyAI (${ep.speakersExpected} speakers)...`);
        raw = await submitTranscription(ep.audioUrl, ep.speakersExpected);

        if (raw.status === 'error') {
          throw new Error(`AssemblyAI error: ${raw.error}`);
        }

        writeFileSync(rawCachePath, JSON.stringify(raw, null, 2));
        console.log(`  ✓ Transcription complete (${raw.utterances?.length || 0} utterances, ${raw.words?.length || 0} words)`);
      }

      // Sanity check: speaker count
      const detectedSpeakers = new Set((raw.utterances || []).map(u => u.speaker)).size;
      if (detectedSpeakers < ep.speakersExpected) {
        console.log(`  ⚠ Expected ${ep.speakersExpected} speakers but detected ${detectedSpeakers} — may need manual review`);
      }

      // Stage 2: Label speakers
      const utterances = raw.utterances || [];
      const { speakerMap, confidence, flags, adSpeakers, contentStartIndex } = mapSpeakers(utterances, ep);

      const contentUtterances = utterances.slice(contentStartIndex);
      const labeled = {
        slug: ep.slug,
        num: ep.num,
        title: ep.title,
        guests: ep.guests,
        cohosts: ep.cohosts,
        guestSpeakers: ep.guestSpeakers,
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

      writeFileSync(join(OUTPUT_LABELED, `${ep.slug}.json`), JSON.stringify(labeled, null, 2));
      console.log(`  ✓ Speakers labeled [${confidence}]${flags.length ? ' — ' + flags.join('; ') : ''}`);

      // Stage 3: Format plain text for proofreading
      const plainText = formatPlainText(labeled.utterances);
      writeFileSync(join(OUTPUT_FORMATTED, `${ep.slug}.md`), plainText);
      console.log(`  ✓ Formatted plain text for proofreading`);

      // Stage 4: Proofread transcript
      const proofread = await proofreadTranscript(ep.slug, plainText, ep);

      writeFileSync(join(OUTPUT_PROOFREAD, `${ep.slug}.md`), proofread.transcript);

      const report = {
        episode: ep.slug,
        ads_removed: proofread.report.ads_removed || [],
        flags: proofread.report.flags || [],
        changes_summary: proofread.report.changes_summary || '',
        usage: proofread.usage,
      };
      writeFileSync(join(REPORTS_DIR, `${ep.slug}.json`), JSON.stringify(report, null, 2));

      const adCount = report.ads_removed.length;
      const flagCount = report.flags.length;
      console.log(`  ✓ Proofread — ${adCount} ad(s) removed, ${flagCount} flag(s) [${proofread.usage.input_tokens}in/${proofread.usage.output_tokens}out]`);

      // Stage 5: Align timestamps at every paragraph break + format.
      // Pass the cast (the names used as speaker labels) so a mid-sentence
      // colon is never mistaken for a speaker turn. Union of the mapped names
      // and the full cast, since proofread reattribution (Task 2) may relabel a
      // generic "Speaker X" to a cast name not present in speakerMap.
      const castNames = new Set([
        ...Object.values(speakerMap),
        'Dr. Linda Bluestein',
        ...(ep.cohosts || []),
        ...(ep.guestSpeakers || []),
      ].filter(Boolean));
      const { text: timestamped, matched, total, pct } = alignAndFormat(
        proofread.transcript, raw.words || [], castNames, labeled.utterances
      );
      console.log(`  ✓ Timestamps aligned: ${matched}/${total} paragraphs (${pct}%)`);

      // Stage 6: Auto-tag using taxonomy (if available)
      const taxonomyPath = join(SCRIPTS_DIR, '..', 'src', '_data', 'tagTaxonomy.json');
      let autoTags = [];
      if (existsSync(taxonomyPath)) {
        try {
          const taxonomy = JSON.parse(readFileSync(taxonomyPath, 'utf-8'));
          autoTags = await tagEpisode(ep, timestamped, taxonomy);
          if (autoTags.length > 0) {
            console.log(`  ✓ Tagged: ${autoTags.join(', ')}`);
          } else {
            console.log(`  ⚠ Tagging returned no tags — check taxonomy or episode content`);
          }
        } catch (err) {
          console.log(`  ⚠ Tagging failed: ${err.message}`);
        }
      }

      // Stage 7: Write to episode file
      const epRaw = readFileSync(ep.filePath, 'utf-8');
      const { data } = matter(epRaw);
      if (autoTags.length > 0) data.tags = autoTags;
      writeFileSync(ep.filePath, matter.stringify(timestamped, data));
      console.log(`  ✓ Written to ${ep.slug}.md`);

      // Stage 8: Auto-create guest profiles for any new guests
      try {
        const profileRecords = await ensureGuestProfiles(ep);
        const created = profileRecords.filter(r => r.action === 'created').map(r => r.key);
        const unknown = profileRecords.filter(r => r.action === 'unknown').map(r => r.key);
        const errored = profileRecords.filter(r => r.action === 'error');
        if (created.length) console.log(`  ✓ Created guest profile(s): ${created.join(', ')}`);
        if (unknown.length) console.log(`  ⚠ Skipped (couldn't identify): ${unknown.join(', ')}`);
        for (const e of errored) console.log(`  ⚠ Profile error for ${e.key}: ${e.error}`);
      } catch (err) {
        console.log(`  ⚠ Guest profile creation failed: ${err.message}`);
      }

      succeeded++;
    } catch (err) {
      console.error(`  ✗ Failed: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Failed: ${failed}`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
