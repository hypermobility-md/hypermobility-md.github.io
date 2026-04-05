#!/usr/bin/env node

/**
 * Fill missing timestamps in proofread transcripts using Claude.
 *
 * Reads timestamped output from add-timestamps.mjs, identifies turns
 * without timestamps, and uses Claude to match them against labeled
 * utterances (which have timing data).
 *
 * Usage:
 *   node scripts/fill-timestamps.mjs                    # Preview all
 *   node scripts/fill-timestamps.mjs --write            # Write to episodes
 *   node scripts/fill-timestamps.mjs --episode 136      # Single episode
 *   node scripts/fill-timestamps.mjs --min-gap 5        # Only episodes with ≥5 missing (default: 3)
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';

const TIMESTAMPED_DIR = join(import.meta.dirname, 'output', 'timestamped');
const LABELED_DIR = join(import.meta.dirname, 'output', 'labeled');
const FILLED_DIR = join(import.meta.dirname, 'output', 'filled');
const EPISODES_DIR = join(import.meta.dirname, '..', 'src', 'episodes');

const args = process.argv.slice(2);
const writeToEpisodes = args.includes('--write');
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;
const minGapIdx = args.indexOf('--min-gap');
const minGap = minGapIdx !== -1 ? parseInt(args[minGapIdx + 1], 10) : 3;

const anthropic = new Anthropic();

/**
 * Format milliseconds as [MM:SS] or [H:MM:SS].
 */
function formatTimestamp(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `[${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`;
  }
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}]`;
}

/**
 * Parse timestamped markdown to find lines with and without timestamps.
 */
function parseTimestampedLines(text) {
  const lines = text.split('\n');
  const tsRegex = /^\[(\d+:)?\d+:\d+\]\s/;
  const speakerRegex = /^([A-Z][^:]{1,60}):\s/;

  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const hasTimestamp = tsRegex.test(lines[i]);
    const isSpeakerLine = speakerRegex.test(lines[i]) || tsRegex.test(lines[i]);
    if (isSpeakerLine) {
      result.push({
        lineIdx: i,
        hasTimestamp,
        text: lines[i],
      });
    }
  }
  return result;
}

/**
 * Build a compact reference of labeled utterances with timestamps.
 */
function buildUtteranceReference(labeled) {
  const { utterances } = labeled;
  if (!utterances) return '';

  return utterances.map(u => {
    const ts = formatTimestamp(u.start);
    const preview = u.text.slice(0, 120).replace(/\n/g, ' ');
    return `${ts} ${u.speakerName}: ${preview}`;
  }).join('\n');
}

/**
 * Use Claude to match unmatched turns to labeled utterances.
 * Sends surrounding context (timestamped lines) and the reference utterances.
 */
async function fillMissingTimestamps(slug, timestampedText, labeled) {
  const lines = timestampedText.split('\n');
  const parsedLines = parseTimestampedLines(timestampedText);
  const missing = parsedLines.filter(l => !l.hasTimestamp);

  if (missing.length === 0) return { text: timestampedText, filled: 0 };

  // Build reference from labeled utterances
  const reference = buildUtteranceReference(labeled);

  // Build context: show the timestamped transcript with markers for missing lines
  const contextLines = [];
  for (let i = 0; i < lines.length; i++) {
    const missingLine = missing.find(m => m.lineIdx === i);
    if (missingLine) {
      contextLines.push(`>>> MISSING TIMESTAMP (line ${i + 1}): ${lines[i]}`);
    } else {
      contextLines.push(lines[i]);
    }
  }

  // Truncate if too long (keep first and last sections)
  let context = contextLines.join('\n');
  if (context.length > 30000) {
    // Focus on areas around missing timestamps
    const keepLines = new Set();
    for (const m of missing) {
      for (let j = Math.max(0, m.lineIdx - 3); j <= Math.min(lines.length - 1, m.lineIdx + 3); j++) {
        keepLines.add(j);
      }
    }
    const sections = [];
    let inSection = false;
    let sectionStart = -1;
    for (let i = 0; i < contextLines.length; i++) {
      if (keepLines.has(i)) {
        if (!inSection) { sections.push('...'); sectionStart = i; inSection = true; }
        sections.push(contextLines[i]);
      } else {
        inSection = false;
      }
    }
    context = sections.join('\n');
  }

  // Truncate reference if too long
  let ref = reference;
  if (ref.length > 20000) {
    ref = ref.slice(0, 20000) + '\n... (truncated)';
  }

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are matching podcast transcript lines to their timestamps.

Below is a proofread transcript where most lines already have timestamps like [MM:SS] or [H:MM:SS]. Lines marked with ">>> MISSING TIMESTAMP" need timestamps filled in.

Below that is the original transcription with timestamps for every utterance. The text won't match exactly (the proofread version has corrections), but the content should be similar enough to identify the right timestamp.

For each missing timestamp line, find the closest matching utterance from the reference and assign its timestamp. Use the surrounding already-timestamped lines as anchors.

TRANSCRIPT (with missing lines marked):
${context}

REFERENCE UTTERANCES (original transcription with timestamps):
${ref}

Respond with ONLY a JSON object mapping line numbers to timestamps. Example:
{"5": "[02:30]", "23": "[15:45]", "41": "[1:02:30]"}

If you cannot confidently match a line, omit it from the response. Only include lines you are confident about.`,
    }],
  });

  let result;
  try {
    let text = response.content[0].text.trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    result = JSON.parse(text);
  } catch {
    console.error(`  ⚠ Failed to parse response for ${slug}:`, response.content[0].text.slice(0, 200));
    return { text: timestampedText, filled: 0 };
  }

  // Apply timestamps
  let filled = 0;
  for (const [lineNum, timestamp] of Object.entries(result)) {
    const idx = parseInt(lineNum, 10) - 1; // Convert 1-based to 0-based
    if (idx >= 0 && idx < lines.length && !lines[idx].match(/^\[(\d+:)?\d+:\d+\]/)) {
      // Validate timestamp format
      if (/^\[\d+:\d{2}(:\d{2})?\]$/.test(timestamp)) {
        lines[idx] = `${timestamp} ${lines[idx]}`;
        filled++;
      }
    }
  }

  return { text: lines.join('\n'), filled };
}

async function main() {
  mkdirSync(FILLED_DIR, { recursive: true });

  let files = readdirSync(TIMESTAMPED_DIR).filter(f => f.endsWith('.md'));

  if (singleEpisode) {
    const padded = String(singleEpisode).padStart(3, '0');
    files = files.filter(f => f === `${padded}.md` || f === `${singleEpisode}.md`);
  }

  // Find episodes with missing timestamps
  const candidates = [];
  for (const file of files) {
    const slug = file.replace('.md', '');
    const text = readFileSync(join(TIMESTAMPED_DIR, file), 'utf-8');
    const parsed = parseTimestampedLines(text);
    const missing = parsed.filter(l => !l.hasTimestamp).length;
    if (missing >= minGap) {
      candidates.push({ slug, file, missing, total: parsed.length });
    }
  }

  if (candidates.length === 0) {
    console.log(`No episodes with ≥${minGap} missing timestamps found.`);
    return;
  }

  candidates.sort((a, b) => b.missing - a.missing);
  console.log(`Found ${candidates.length} episodes with ≥${minGap} missing timestamps:\n`);
  for (const c of candidates) {
    console.log(`  ${c.slug}: ${c.missing}/${c.total} missing`);
  }
  console.log('');

  let totalFilled = 0;
  let processed = 0;

  for (const { slug, file, missing, total } of candidates) {
    const labeledPath = join(LABELED_DIR, `${slug}.json`);
    if (!existsSync(labeledPath)) {
      console.log(`⚠ ${slug}: no labeled JSON, skipping`);
      continue;
    }

    console.log(`🤖 ${slug}: filling ${missing} missing timestamps...`);

    const timestampedText = readFileSync(join(TIMESTAMPED_DIR, file), 'utf-8');
    const labeled = JSON.parse(readFileSync(labeledPath, 'utf-8'));

    const result = await fillMissingTimestamps(slug, timestampedText, labeled);

    writeFileSync(join(FILLED_DIR, file), result.text);

    if (result.filled > 0) {
      console.log(`  ✓ Filled ${result.filled}/${missing} timestamps`);
      totalFilled += result.filled;
    } else {
      console.log(`  - No additional timestamps matched`);
    }

    if (writeToEpisodes && result.filled > 0) {
      const episodePath = join(EPISODES_DIR, `${slug}.md`);
      if (existsSync(episodePath)) {
        const raw = readFileSync(episodePath, 'utf-8');
        const { data } = matter(raw);
        writeFileSync(episodePath, matter.stringify(result.text, data));
        console.log(`  ✓ Written to ${slug}.md`);
      }
    }

    processed++;
  }

  console.log(`\nOutput: ${FILLED_DIR}`);
  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Total timestamps filled: ${totalFilled}`);
  if (!writeToEpisodes) {
    console.log(`Preview mode: use --write to update episode files`);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
