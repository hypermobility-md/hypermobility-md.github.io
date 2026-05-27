#!/usr/bin/env node

/**
 * Add timestamps to proofread episode transcripts.
 *
 * The proofreader works on plain-text speaker turns (no timestamps) so it
 * can read naturally — but the published markdown needs timestamps at every
 * paragraph break so listeners can navigate long monologues. This script
 * does that re-attachment using word-level timing data preserved by
 * label-speakers.mjs.
 *
 * Algorithm (paragraph-level alignment against the raw word stream):
 *
 *   1. Flatten labeled.utterances[].words into a single sequence
 *      [{ text, start }] of normalized words.
 *   2. Split proofread markdown into paragraphs (blank-line separated).
 *   3. For each paragraph, take its first N words, anchor on each of the
 *      first 3 head words in turn, and score the resulting window against
 *      the head with sequential overlap. The best window's first word's
 *      `start` becomes the paragraph's timestamp.
 *   4. Cursor advances only on high-confidence matches so a single weak
 *      match doesn't poison subsequent alignments.
 *
 * Design choices:
 *   - "No timestamp" is better than a wrong one — paragraphs whose best
 *     score is below MIN_SCORE are emitted without any bracket prefix.
 *     Readers infer the position from neighbouring paragraphs.
 *   - Very short reactions ("Yeah.", "Mm-hmm.") are not stamped or counted
 *     against the success rate.
 *
 * Usage:
 *   node scripts/add-timestamps.mjs                 # Preview all
 *   node scripts/add-timestamps.mjs --write         # Write to src/episodes/
 *   node scripts/add-timestamps.mjs --episode 191   # Single episode
 *   node scripts/add-timestamps.mjs --verify        # Show un-stamped paragraphs
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

const LABELED_DIR = join(import.meta.dirname, 'output', 'labeled');
const PROOFREAD_DIR = join(import.meta.dirname, 'output', 'proofread');
const TIMESTAMPED_DIR = join(import.meta.dirname, 'output', 'timestamped');
const EPISODES_DIR = join(import.meta.dirname, '..', 'src', 'episodes');

const args = process.argv.slice(2);
const writeToEpisodes = args.includes('--write');
const verify = args.includes('--verify');
const force = args.includes('--force');
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;
const minCoverageIdx = args.indexOf('--min-coverage');
const MIN_COVERAGE_PCT = minCoverageIdx !== -1 ? parseInt(args[minCoverageIdx + 1], 10) : 70;

// Tuning constants
const HEAD_WORDS = 8;
const MAX_LOOKAHEAD = 1200;    // ~5-10 min of words from the cursor
const MIN_SCORE = 0.5;         // Below this, leave un-stamped (don't risk a wrong stamp)
const ADVANCE_SCORE = 0.6;     // Only advance the cursor on confident matches
const SHORT_PARA_TOKENS = 5;   // Skip ("Yeah.", "Mm-hmm.") — not worth stamping

// ── Formatting helpers ──────────────────────────────────────────────────

function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `[${h}:${pad(m)}:${pad(s)}]` : `[${pad(m)}:${pad(s)}]`;
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
}

// ── Step 1: Flatten the labeled word stream ─────────────────────────────

function flattenWords(labeled) {
  const flat = [];
  for (const u of labeled.utterances || []) {
    if (!u.words) continue;
    for (const w of u.words) {
      const t = normalize(w.text);
      if (t) flat.push({ text: t, start: w.start });
    }
  }
  return flat;
}

// ── Step 2: Parse proofread into paragraphs ─────────────────────────────

const speakerRegex = /^([A-Z][^:\n]{1,60}):\s+/;

function parseProofreadParagraphs(text) {
  // Blank-line separated blocks. The first block of a speaker turn is
  // prefixed with "Name: "; continuation paragraphs are not. We keep the
  // raw block (for emission) plus tokens for alignment.
  const blocks = text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);
  const paragraphs = [];
  for (const block of blocks) {
    const m = block.match(speakerRegex);
    const textForTokens = m ? block.slice(m[0].length) : block;
    const allTokens = tokens(textForTokens);
    paragraphs.push({
      raw: block,
      headTokens: allTokens.slice(0, HEAD_WORDS),
      totalTokens: allTokens.length,
    });
  }
  return paragraphs;
}

// ── Step 3: Alignment ───────────────────────────────────────────────────

function sequentialOverlap(head, window) {
  if (head.length === 0) return 0;
  let qi = 0, matches = 0;
  for (let i = 0; i < window.length && qi < head.length; i++) {
    if (window[i].text === head[qi]) { matches++; qi++; }
  }
  return matches / head.length;
}

function findBestAlignment(head, cursor, rawWords) {
  const from = Math.max(0, cursor - 5);
  const to = Math.min(rawWords.length, cursor + MAX_LOOKAHEAD);
  let bestScore = 0, bestIdx = -1;

  // Try anchoring on each of the first 3 head words. If the proofreader
  // rephrased the opening, head[0] might not appear at the actual start —
  // but head[1] or head[2] usually do. We back the candidate idx up by
  // the anchor position so the timestamp still targets paragraph start.
  for (let anchorPos = 0; anchorPos < Math.min(3, head.length); anchorPos++) {
    const anchor = head[anchorPos];
    for (let i = from; i < to; i++) {
      if (rawWords[i].text !== anchor) continue;
      const candidateIdx = Math.max(from, i - anchorPos);
      const window = rawWords.slice(candidateIdx, candidateIdx + head.length * 3);
      const score = sequentialOverlap(head, window);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = candidateIdx;
        if (score >= 0.95) return { score: bestScore, idx: bestIdx };
      }
    }
    if (bestScore >= ADVANCE_SCORE) break;
  }

  return { score: bestScore, idx: bestIdx };
}

function alignParagraphs(paragraphs, rawWords) {
  let cursor = 0;
  const results = [];
  for (const para of paragraphs) {
    const head = para.headTokens;
    if (head.length < 2) {
      results.push({ ...para, timestamp: null, score: 0, skip: true });
      continue;
    }
    const { score, idx } = findBestAlignment(head, cursor, rawWords);
    if (score >= MIN_SCORE && idx >= 0) {
      results.push({ ...para, timestamp: rawWords[idx].start, score, idx });
      if (score >= ADVANCE_SCORE) {
        cursor = idx + Math.max(1, Math.floor(para.totalTokens * 0.6));
      }
    } else {
      results.push({ ...para, timestamp: null, score });
    }
  }
  return results;
}

// ── Step 4: Render ──────────────────────────────────────────────────────

function renderTimestamped(aligned) {
  const lines = [];
  for (const a of aligned) {
    if (a.timestamp === null) {
      lines.push(a.raw); // no bracket — readers infer from neighbours
    } else {
      lines.push(`${formatTimestamp(a.timestamp)} ${a.raw}`);
    }
  }
  return lines.join('\n\n') + '\n';
}

// ── Main ────────────────────────────────────────────────────────────────

function main() {
  let labeledFiles = readdirSync(LABELED_DIR).filter(f => f.endsWith('.json'));

  if (singleEpisode) {
    const padded = String(singleEpisode).padStart(3, '0');
    labeledFiles = labeledFiles.filter(f => f === `${padded}.json` || f === `${singleEpisode}.json`);
  }

  mkdirSync(TIMESTAMPED_DIR, { recursive: true });

  console.log(`Scanning ${labeledFiles.length} labeled transcripts...\n`);

  let processed = 0;
  let written = 0;
  let skipped = 0;
  let perfect = 0;
  let warnings = 0;
  let missingWords = 0;

  for (const file of labeledFiles) {
    const slug = file.replace('.json', '');
    const proofreadPath = join(PROOFREAD_DIR, `${slug}.md`);

    if (!existsSync(proofreadPath)) {
      skipped++;
      continue;
    }

    const labeled = JSON.parse(readFileSync(join(LABELED_DIR, file), 'utf-8'));
    const proofreadText = readFileSync(proofreadPath, 'utf-8');

    // Already timestamped? Skip.
    if (/^\[\d+:\d+/.test(proofreadText.trimStart())) {
      if (verify) console.log(`SKIP ${slug}: already has timestamps`);
      skipped++;
      continue;
    }

    const rawWords = flattenWords(labeled);
    if (rawWords.length === 0) {
      console.log(`⚠ ${slug}: no word-level data in labeled JSON — re-run label-speakers.mjs`);
      missingWords++;
      skipped++;
      continue;
    }

    const paragraphs = parseProofreadParagraphs(proofreadText);
    const aligned = alignParagraphs(paragraphs, rawWords);

    const significant = aligned.filter(a => !a.skip && a.totalTokens >= SHORT_PARA_TOKENS);
    const matched = significant.filter(a => a.timestamp !== null).length;
    const unstamped = significant.length - matched;
    const pct = significant.length ? Math.round(100 * matched / significant.length) : 100;

    const output = renderTimestamped(aligned);
    writeFileSync(join(TIMESTAMPED_DIR, `${slug}.md`), output);

    if (unstamped === 0) {
      perfect++;
      console.log(`✓ ${slug}: ${matched}/${significant.length} paragraphs timestamped`);
    } else if (pct < 85) {
      warnings++;
      console.log(`⚠ ${slug}: ${matched}/${significant.length} (${pct}%) — ${unstamped} un-stamped`);
    } else {
      console.log(`~ ${slug}: ${matched}/${significant.length} (${pct}%) — ${unstamped} un-stamped`);
    }

    if (verify && unstamped > 0) {
      const misses = aligned.filter(a => a.timestamp === null && !a.skip && a.totalTokens >= SHORT_PARA_TOKENS);
      for (const m of misses.slice(0, 5)) {
        const preview = m.raw.slice(0, 90).replace(/\n/g, ' ');
        console.log(`    score=${m.score.toFixed(2)} tokens=${m.totalTokens}  ${preview}…`);
      }
      if (misses.length > 5) console.log(`    ... and ${misses.length - 5} more`);
    }

    processed++;

    if (writeToEpisodes) {
      if (pct < MIN_COVERAGE_PCT && !force) {
        console.log(`  SKIP write: coverage ${pct}% below threshold ${MIN_COVERAGE_PCT}% (use --force to override)`);
        continue;
      }
      const episodePath = join(EPISODES_DIR, `${slug}.md`);
      if (!existsSync(episodePath)) {
        console.log(`  SKIP write: ${slug}.md not found in episodes/`);
        continue;
      }
      const raw = readFileSync(episodePath, 'utf-8');
      const { data } = matter(raw);
      writeFileSync(episodePath, matter.stringify(output, data));
      written++;
    }
  }

  console.log(`\nOutput: ${TIMESTAMPED_DIR}`);
  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  console.log(`100% stamped: ${perfect}`);
  console.log(`Warnings (<85%): ${warnings}`);
  console.log(`Skipped: ${skipped}`);
  if (missingWords > 0) {
    console.log(`⚠ Missing word-level data: ${missingWords} — re-run label-speakers.mjs`);
  }
  if (writeToEpisodes) {
    console.log(`Written to episodes: ${written}`);
  } else {
    console.log(`Preview mode: use --write to update episode files`);
  }
}

main();
