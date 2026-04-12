#!/usr/bin/env node

/**
 * Stage 4: Proofread and clean transcripts using Claude API.
 * - Removes ads (pre-roll, mid-roll, post-roll) but keeps the outro
 * - Adds paragraph breaks within long speaker turns
 * - Proofreads for transcription errors
 * - Flags problematic sections (speaker ID issues, garbled text)
 * - Reports which ads were removed
 *
 * Reads from scripts/output/formatted/, writes to scripts/output/proofread/
 *
 * Usage:
 *   node scripts/proofread-transcripts.mjs                    # Process all
 *   node scripts/proofread-transcripts.mjs --episode 50       # Single episode
 *   node scripts/proofread-transcripts.mjs --range 0-20       # Range of episodes
 *   node scripts/proofread-transcripts.mjs --resume            # Skip already-processed
 *   node scripts/proofread-transcripts.mjs --dry-run           # Show what would be processed
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import Anthropic from '@anthropic-ai/sdk';

// Load .env manually (avoid dotenv dependency)
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

const FORMATTED_DIR = join(import.meta.dirname, 'output', 'formatted');
const PROOFREAD_DIR = join(import.meta.dirname, 'output', 'proofread');
const REPORTS_DIR = join(import.meta.dirname, 'output', 'proofread', 'reports');

mkdirSync(PROOFREAD_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const client = new Anthropic({
  timeout: 20 * 60 * 1000, // 20 minute timeout for large transcripts
});

const args = process.argv.slice(2);
const resume = args.includes('--resume');
const dryRun = args.includes('--dry-run');
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;
const rangeIdx = args.indexOf('--range');
const range = rangeIdx !== -1 ? args[rangeIdx + 1] : null;
const modelIdx = args.indexOf('--model');
const MODEL = modelIdx !== -1 ? args[modelIdx + 1] : 'claude-sonnet-4-6';

// Concurrency and rate limiting
const concurrencyIdx = args.indexOf('--concurrency');
const CONCURRENCY = concurrencyIdx !== -1 ? parseInt(args[concurrencyIdx + 1], 10) : 1;
const MAX_RETRIES = 5;
const STAGGER_MS = 3000; // stagger between launching workers

const SYSTEM_PROMPT = `You are a professional transcript editor for the Bendy Bodies Podcast, a medical podcast about hypermobility and Ehlers-Danlos syndromes hosted by Dr. Linda Bluestein (the Hypermobility MD).

You will receive a podcast transcript and must perform three tasks:

## Task 1: Remove Advertisements

Remove ALL ad/sponsor reads, including:
- Pre-roll ads (before the episode content starts)
- Mid-roll ads (sponsor reads inserted during the episode)
- Post-roll sponsor tags (e.g., "This episode was brought to you by...")
- NPR sponsor messages
- Product/brand ads (Bauerfeind, Celsius, BetterHelp, Athletic Greens, etc.)
- Substack/newsletter plugs that appear as scripted ad reads

**KEEP the outro.** The outro is the closing segment where Dr. Bluestein (or a co-host) wraps up the episode. It typically includes:
- Thanking the guest and summarizing the episode
- Mentioning the Bendy Bodies website (bendybodiespodcast.com)
- Social media handles (@bendy_buddies, @HypermobilityMD)
- The disclaimer about "this podcast is for general informational purposes only..."
- References to hypermobilitymd.com
- Credits (music composer, website designer, etc.)
- "We'll catch you next time on the Bendy Bodies Podcast"

This outro content should STAY — it's the show's standard sign-off, not an ad. Only remove the final sponsor tag line if one appears after the outro (e.g., "This episode of the Bendy Bodies Podcast was brought to you by Bauerfeind Premium Braces and Supports...").

## Task 2: Format into Readable Paragraphs

The transcript uses the format "[MM:SS] Speaker Name: text" (or "[H:MM:SS] Speaker Name: text" after the 1-hour mark). Each speaker turn starts with a timestamp in square brackets. Maintain this format, but:
- Preserve all timestamps exactly as they appear — do NOT remove, modify, or add timestamps
- Ensure there is a blank line between each speaker turn
- Break long speaker turns into multiple paragraphs at natural points (topic shifts, new ideas, after ~3-5 sentences). Keep the speaker label and timestamp only on the first paragraph of their turn — continuation paragraphs should NOT repeat the speaker name or timestamp, just continue as plain text
- Do NOT merge separate speaker turns together

## Task 3: Proofread

- Fix obvious transcription errors in medical/scientific terminology (EDS, POTS, MCAS, collagen, proprioception, etc.)
- Fix misspelled proper nouns and speaker names if clearly wrong
- Fix garbled or nonsensical phrases where the intended meaning is clear
- Do NOT rewrite for style — preserve the conversational, spoken tone
- Do NOT remove filler words (um, uh, you know) — these are part of the natural speech
- Do NOT use em dashes (—). Use commas, periods, or other punctuation instead

## Output Format

Use the EXACT format below with these XML-style delimiters. The transcript goes between the tags as plain text (not JSON-escaped). The report section is JSON.

<transcript>
The full cleaned, formatted, proofread transcript goes here as plain text with real line breaks.
</transcript>

<report>
{
  "ads_removed": [
    {
      "location": "pre-roll|mid-roll|post-roll",
      "description": "Brief description of the ad (sponsor name, product)"
    }
  ],
  "flags": [
    {
      "type": "speaker-id|transcription-error|garbled|other",
      "description": "Description of the issue",
      "context": "Brief quote from the problematic section"
    }
  ],
  "changes_summary": "1-2 sentence summary of what was changed"
}
</report>

Important: The transcript section must contain the FULL cleaned transcript, not a summary or truncation.`;

async function processTranscript(slug, text) {
  // Estimate tokens and set max_tokens high enough for full transcript output
  // JSON wrapping adds ~20% overhead on top of the transcript text
  const estInputTokens = Math.round(text.length / 4);
  const maxTokens = Math.min(64000, Math.max(16000, Math.round(estInputTokens * 1.3)));

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: `Here is the transcript for episode ${slug} of the Bendy Bodies Podcast. Please clean, format, and proofread it.\n\n<transcript>\n${text}\n</transcript>`,
      },
    ],
  });

  // Check for truncation
  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Output truncated at ${maxTokens} max_tokens — transcript too long`);
  }

  const responseText = message.content[0].text;

  // Parse XML-delimited response: <transcript>...</transcript> and <report>...</report>
  const transcriptMatch = responseText.match(/<transcript>\s*\n?([\s\S]*?)\n?\s*<\/transcript>/);
  const reportMatch = responseText.match(/<report>\s*\n?([\s\S]*?)\n?\s*<\/report>/);

  if (!transcriptMatch) {
    throw new Error('Could not find <transcript> tags in response');
  }

  const transcript = transcriptMatch[1].trim();
  let report = {};
  if (reportMatch) {
    try {
      report = JSON.parse(reportMatch[1].trim());
    } catch {
      // Try stripping markdown code fences inside report
      const inner = reportMatch[1].trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
      report = JSON.parse(inner);
    }
  }

  const result = { transcript, ...report };
  return {
    ...result,
    usage: {
      input_tokens: message.usage.input_tokens,
      output_tokens: message.usage.output_tokens,
    },
  };
}

async function processWithRetry(slug, text) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await processTranscript(slug, text);
    } catch (err) {
      const isRateLimit = err?.status === 429;
      const isOverloaded = err?.status === 529;
      const isTerminated = err?.message === 'terminated';
      const isRetryable = isRateLimit || isOverloaded || isTerminated || err?.status >= 500;

      if (isRetryable && attempt < MAX_RETRIES) {
        const backoff = isRateLimit ? 15000 * attempt : 5000 * attempt;
        console.log(
          `  ⚠ ${slug} ${err.status || 'error'} attempt ${attempt}, retrying in ${backoff / 1000}s...`
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }
}

async function main() {
  let files = readdirSync(FORMATTED_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  // Filter to single episode
  if (singleEpisode) {
    const padded = String(singleEpisode).padStart(3, '0');
    files = files.filter((f) => f === `${padded}.md`);
  }

  // Filter to range
  if (range) {
    const [start, end] = range.split('-').map(Number);
    files = files.filter((f) => {
      const num = parseInt(f.replace('.md', ''), 10);
      return num >= start && num <= end;
    });
  }

  // Skip already processed
  if (resume) {
    files = files.filter((f) => !existsSync(join(PROOFREAD_DIR, f)));
  }

  if (files.length === 0) {
    console.log('No transcripts to process.');
    return;
  }

  if (dryRun) {
    console.log(`Would process ${files.length} transcripts:`);
    files.forEach((f) => console.log(`  ${f}`));
    return;
  }

  console.log(`Processing ${files.length} transcripts (model: ${MODEL}, concurrency: ${CONCURRENCY})...\n`);

  let processed = 0;
  let failed = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const failures = [];

  // Process a single file — used by the worker pool
  async function processFile(file) {
    const slug = file.replace('.md', '');
    const text = readFileSync(join(FORMATTED_DIR, file), 'utf-8');

    if (!text.trim()) {
      console.log(`SKIP ${slug}: empty transcript`);
      return;
    }

    const charCount = text.length;
    const estTokens = Math.round(charCount / 4);

    try {
      const result = await processWithRetry(slug, text);

      // Save cleaned transcript
      writeFileSync(join(PROOFREAD_DIR, `${slug}.md`), result.transcript);

      // Save report
      const report = {
        episode: slug,
        ads_removed: result.ads_removed || [],
        flags: result.flags || [],
        changes_summary: result.changes_summary || '',
        usage: result.usage,
      };
      writeFileSync(join(REPORTS_DIR, `${slug}.json`), JSON.stringify(report, null, 2));

      const adCount = (result.ads_removed || []).length;
      const flagCount = (result.flags || []).length;
      processed++;
      console.log(
        `✓ ${slug} (${(charCount / 1024).toFixed(0)}KB) — ${adCount} ad(s), ${flagCount} flag(s) [${result.usage.input_tokens}in/${result.usage.output_tokens}out] (${processed + failed}/${files.length})`
      );

      totalInput += result.usage.input_tokens;
      totalOutput += result.usage.output_tokens;
    } catch (err) {
      const detail = err.status ? `${err.status} ${err.message}` : err.stack?.split('\n').slice(0, 3).join(' ') || err.message;
      console.log(`✗ ${slug}: ${detail}`);
      failures.push({ slug, error: detail });
      failed++;
    }
  }

  // Worker pool: process files with limited concurrency and staggered start
  const queue = [...files];
  async function worker(id) {
    // Stagger worker starts to avoid burst rate limits
    await new Promise((r) => setTimeout(r, id * STAGGER_MS));
    while (queue.length > 0) {
      const file = queue.shift();
      if (file) await processFile(file);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, (_, i) => worker(i));
  await Promise.all(workers);

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total tokens: ${totalInput} input, ${totalOutput} output`);

  // Rough cost estimate for Sonnet 4.6
  const costIn = (totalInput / 1_000_000) * 3;
  const costOut = (totalOutput / 1_000_000) * 15;
  console.log(`Estimated cost: $${(costIn + costOut).toFixed(2)}`);
  console.log(`Output: ${PROOFREAD_DIR}`);

  if (failures.length > 0) {
    console.log(`\nFailed episodes:`);
    failures.forEach((f) => console.log(`  ${f.slug}: ${f.error}`));
  }

  // Generate consolidated report
  const allReports = readdirSync(REPORTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(REPORTS_DIR, f), 'utf-8')));

  const allAds = allReports.flatMap((r) =>
    (r.ads_removed || []).map((a) => ({ episode: r.episode, ...a }))
  );
  const allFlags = allReports.flatMap((r) =>
    (r.flags || []).map((f) => ({ episode: r.episode, ...f }))
  );

  const consolidatedReport = {
    total_episodes: allReports.length,
    total_ads_removed: allAds.length,
    total_flags: allFlags.length,
    ads_by_sponsor: groupBy(allAds, (a) => a.description),
    all_flags: allFlags,
  };

  writeFileSync(
    join(PROOFREAD_DIR, 'consolidated-report.json'),
    JSON.stringify(consolidatedReport, null, 2)
  );
  console.log(`\nConsolidated report: ${join(PROOFREAD_DIR, 'consolidated-report.json')}`);
}

function groupBy(arr, keyFn) {
  const groups = {};
  for (const item of arr) {
    const key = keyFn(item);
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
