#!/usr/bin/env node

/**
 * Batch-process transcripts using Anthropic's Message Batches API.
 * 50% cheaper, no timeouts, higher throughput. Results come back within ~1 hour.
 *
 * Usage:
 *   node scripts/proofread-batch.mjs submit                    # Submit remaining episodes
 *   node scripts/proofread-batch.mjs submit --model claude-haiku-4-5-20251001
 *   node scripts/proofread-batch.mjs status                    # Check batch status
 *   node scripts/proofread-batch.mjs results                   # Download and save results
 *   node scripts/proofread-batch.mjs results --batch <id>      # Download specific batch
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
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

const FORMATTED_DIR = join(import.meta.dirname, 'output', 'formatted');
const PROOFREAD_DIR = join(import.meta.dirname, 'output', 'proofread');
const REPORTS_DIR = join(import.meta.dirname, 'output', 'proofread', 'reports');
const BATCH_STATE_FILE = join(import.meta.dirname, 'output', 'proofread', 'batch-state.json');

mkdirSync(PROOFREAD_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });

const client = new Anthropic();

const args = process.argv.slice(2);
const command = args[0]; // submit, status, results
const modelIdx = args.indexOf('--model');
const MODEL = modelIdx !== -1 ? args[modelIdx + 1] : 'claude-haiku-4-5-20251001';
const batchIdIdx = args.indexOf('--batch');
const explicitBatchId = batchIdIdx !== -1 ? args[batchIdIdx + 1] : null;

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

The transcript uses the format "Speaker Name: text". Maintain this format, but:
- Ensure there is a blank line between each speaker turn
- Break long speaker turns into multiple paragraphs at natural points (topic shifts, new ideas, after ~3-5 sentences). Keep the speaker label only on the first paragraph of their turn — continuation paragraphs should NOT repeat the speaker name, just continue as plain text
- Do NOT merge separate speaker turns together

## Task 3: Proofread

- Fix obvious transcription errors in medical/scientific terminology (EDS, POTS, MCAS, collagen, proprioception, etc.)
- Fix misspelled proper nouns and speaker names if clearly wrong
- Fix garbled or nonsensical phrases where the intended meaning is clear
- Do NOT rewrite for style — preserve the conversational, spoken tone
- Do NOT remove filler words (um, uh, you know) — these are part of the natural speech

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

function loadBatchState() {
  if (existsSync(BATCH_STATE_FILE)) {
    return JSON.parse(readFileSync(BATCH_STATE_FILE, 'utf-8'));
  }
  return { batches: [] };
}

function saveBatchState(state) {
  writeFileSync(BATCH_STATE_FILE, JSON.stringify(state, null, 2));
}

async function submitBatch() {
  // Find episodes that need processing
  const allFiles = readdirSync(FORMATTED_DIR).filter(f => f.endsWith('.md')).sort();
  const doneFiles = new Set(
    readdirSync(PROOFREAD_DIR).filter(f => f.endsWith('.md')).map(f => f)
  );

  const remaining = allFiles.filter(f => !doneFiles.has(f));

  if (remaining.length === 0) {
    console.log('All transcripts already processed!');
    return;
  }

  console.log(`Submitting ${remaining.length} transcripts as batch (model: ${MODEL})...\n`);

  // Build batch requests
  const requests = [];
  for (const file of remaining) {
    const slug = file.replace('.md', '');
    const text = readFileSync(join(FORMATTED_DIR, file), 'utf-8');

    if (!text.trim()) {
      console.log(`SKIP ${slug}: empty transcript`);
      continue;
    }

    const estInputTokens = Math.round(text.length / 4);
    const maxTokens = Math.min(64000, Math.max(16000, Math.round(estInputTokens * 1.3)));

    requests.push({
      custom_id: slug,
      params: {
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
      },
    });
  }

  console.log(`Built ${requests.length} requests. Submitting batch...`);

  const batch = await client.messages.batches.create({ requests });

  console.log(`\nBatch created!`);
  console.log(`  ID: ${batch.id}`);
  console.log(`  Status: ${batch.processing_status}`);
  console.log(`  Requests: ${requests.length}`);
  console.log(`\nCheck status with: node scripts/proofread-batch.mjs status`);
  console.log(`Download results with: node scripts/proofread-batch.mjs results`);

  // Save batch state
  const state = loadBatchState();
  state.batches.push({
    id: batch.id,
    model: MODEL,
    count: requests.length,
    episodes: requests.map(r => r.custom_id),
    created_at: new Date().toISOString(),
  });
  saveBatchState(state);
}

async function checkStatus() {
  const state = loadBatchState();

  if (state.batches.length === 0) {
    console.log('No batches submitted yet.');
    return;
  }

  for (const batchInfo of state.batches) {
    const batch = await client.messages.batches.retrieve(batchInfo.id);
    console.log(`Batch: ${batch.id}`);
    console.log(`  Model: ${batchInfo.model}`);
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
    console.log('No batch ID found. Submit a batch first or use --batch <id>.');
    return;
  }

  // Check if batch is done
  const batch = await client.messages.batches.retrieve(batchId);
  console.log(`Batch ${batchId}: ${batch.processing_status}`);
  console.log(`Counts:`, JSON.stringify(batch.request_counts));

  if (batch.processing_status !== 'ended') {
    console.log('\nBatch is still processing. Try again later.');
    return;
  }

  console.log('\nDownloading results...\n');

  let succeeded = 0;
  let errored = 0;
  let expired = 0;
  let totalInput = 0;
  let totalOutput = 0;
  const failures = [];

  for await (const result of await client.messages.batches.results(batchId)) {
    const slug = result.custom_id;

    if (result.result.type === 'succeeded') {
      const message = result.result.message;
      const responseText = message.content[0].text;

      // Parse XML-delimited response
      const transcriptMatch = responseText.match(/<transcript>\s*\n?([\s\S]*?)\n?\s*<\/transcript>/);
      const reportMatch = responseText.match(/<report>\s*\n?([\s\S]*?)\n?\s*<\/report>/);

      if (!transcriptMatch) {
        console.log(`✗ ${slug}: could not find <transcript> tags`);
        failures.push({ slug, error: 'missing transcript tags' });
        errored++;
        continue;
      }

      const transcript = transcriptMatch[1].trim();

      // Save transcript
      writeFileSync(join(PROOFREAD_DIR, `${slug}.md`), transcript);

      // Parse and save report
      let report = {};
      if (reportMatch) {
        try {
          const reportStr = reportMatch[1].trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
          report = JSON.parse(reportStr);
        } catch {
          // Report parsing failed, but transcript is saved
          report = { parse_error: true };
        }
      }

      const fullReport = {
        episode: slug,
        ads_removed: report.ads_removed || [],
        flags: report.flags || [],
        changes_summary: report.changes_summary || '',
        usage: {
          input_tokens: message.usage.input_tokens,
          output_tokens: message.usage.output_tokens,
        },
      };
      writeFileSync(join(REPORTS_DIR, `${slug}.json`), JSON.stringify(fullReport, null, 2));

      totalInput += message.usage.input_tokens;
      totalOutput += message.usage.output_tokens;

      const adCount = (report.ads_removed || []).length;
      const flagCount = (report.flags || []).length;
      console.log(`✓ ${slug} — ${adCount} ad(s), ${flagCount} flag(s)`);
      succeeded++;

    } else if (result.result.type === 'errored') {
      console.log(`✗ ${slug}: ${result.result.error.message}`);
      failures.push({ slug, error: result.result.error.message });
      errored++;

    } else if (result.result.type === 'expired') {
      console.log(`⏰ ${slug}: expired`);
      failures.push({ slug, error: 'expired' });
      expired++;
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Errored: ${errored}`);
  console.log(`Expired: ${expired}`);
  console.log(`Total tokens: ${totalInput} input, ${totalOutput} output`);

  // Haiku batch pricing: $0.50/MTok in, $2.50/MTok out
  const costIn = (totalInput / 1_000_000) * 0.50;
  const costOut = (totalOutput / 1_000_000) * 2.50;
  console.log(`Estimated cost: $${(costIn + costOut).toFixed(2)}`);
  console.log(`Output: ${PROOFREAD_DIR}`);

  if (failures.length > 0) {
    console.log(`\nFailed episodes:`);
    failures.forEach(f => console.log(`  ${f.slug}: ${f.error}`));
  }

  // Generate consolidated report
  const allReports = readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => JSON.parse(readFileSync(join(REPORTS_DIR, f), 'utf-8')));

  const allAds = allReports.flatMap(r =>
    (r.ads_removed || []).map(a => ({ episode: r.episode, ...a }))
  );
  const allFlags = allReports.flatMap(r =>
    (r.flags || []).map(f => ({ episode: r.episode, ...f }))
  );

  const consolidatedReport = {
    total_episodes: allReports.length,
    total_ads_removed: allAds.length,
    total_flags: allFlags.length,
    ads_by_sponsor: groupBy(allAds, a => a.description),
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

// Main
switch (command) {
  case 'submit':
    await submitBatch();
    break;
  case 'status':
    await checkStatus();
    break;
  case 'results':
    await downloadResults();
    break;
  default:
    console.log('Usage:');
    console.log('  node scripts/proofread-batch.mjs submit    # Submit remaining episodes');
    console.log('  node scripts/proofread-batch.mjs status    # Check batch status');
    console.log('  node scripts/proofread-batch.mjs results   # Download results');
    break;
}
