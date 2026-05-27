#!/usr/bin/env node

/**
 * EXPERIMENT: word-level timestamp alignment.
 *
 * Current add-timestamps.mjs aligns against utterances and only emits a
 * timestamp at the start of each speaker turn. When the proofreader splits
 * a long monologue into multiple paragraphs (intro / bio / disclaimer /
 * ad-read / "let's get into it"), the inner paragraphs get no timestamp,
 * leaving ~2-minute gaps in the markup.
 *
 * This experiment aligns at the WORD level using the raw AssemblyAI JSON
 * (which has `words[]` with start times) so we can stamp every paragraph
 * boundary — speaker turns AND intra-turn paragraph breaks. Approach:
 *
 *   1. Flatten raw.words into a normalized stream [{text, start}].
 *   2. Split proofread into paragraphs (blank-line separated).
 *   3. For each paragraph, take its first N words and slide a window over
 *      raw.words starting at the running cursor. Score by sequential overlap.
 *      Best window's start time becomes the paragraph's timestamp.
 *   4. Advance the cursor monotonically.
 *
 * Usage:
 *   node --env-file=.env scripts/experiments/word-align-timestamps.mjs --episode 191
 *   node --env-file=.env scripts/experiments/word-align-timestamps.mjs --episode 191 --window 6
 *   node --env-file=.env scripts/experiments/word-align-timestamps.mjs --episode 191 --diff
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

const ROOT = join(import.meta.dirname, '..', 'output');
const RAW_DIR = join(ROOT, 'raw');
const PROOFREAD_DIR = join(ROOT, 'proofread');
const OUT_DIR = join(import.meta.dirname, 'out');

const args = process.argv.slice(2);
const episodeIdx = args.indexOf('--episode');
const episode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;
const windowIdx = args.indexOf('--window');
const HEAD_WORDS = windowIdx !== -1 ? parseInt(args[windowIdx + 1], 10) : 8;
const showDiff = args.includes('--diff');

if (!episode) {
  console.error('Usage: --episode <num|slug> [--window 8] [--diff]');
  process.exit(1);
}

const slug = episode.match(/^\d+$/) ? episode.padStart(3, '0') : episode;
const rawPath = join(RAW_DIR, `${slug}.json`);
const proofPath = join(PROOFREAD_DIR, `${slug}.md`);
if (!existsSync(rawPath)) { console.error(`Missing ${rawPath}`); process.exit(1); }
if (!existsSync(proofPath)) { console.error(`Missing ${proofPath}`); process.exit(1); }

const raw = JSON.parse(readFileSync(rawPath, 'utf-8'));
const proofread = readFileSync(proofPath, 'utf-8');

function normalize(s) {
  return s
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function tokens(s) { return normalize(s).split(' ').filter(Boolean); }

function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `[${h}:${pad(m)}:${pad(s)}]` : `[${pad(m)}:${pad(s)}]`;
}

// ── 1. Flatten raw words ────────────────────────────────────────────────
// raw.words has { text, start, end, confidence, speaker }
const rawWords = raw.words.map(w => ({
  text: normalize(w.text),
  start: w.start,
}));
console.log(`Loaded ${rawWords.length} raw words (audio ${formatTimestamp(raw.audio_duration * 1000)}).`);

// ── 2. Parse proofread into paragraphs ──────────────────────────────────
// A paragraph is a non-empty block between blank lines. The first line of a
// turn-leading paragraph is prefixed by "Name: ". We keep paragraphs in order.
const speakerRegex = /^([A-Z][^:\n]{1,60}):\s+/;
const blocks = proofread.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

const paragraphs = [];
let currentSpeaker = null;
for (const block of blocks) {
  const m = block.match(speakerRegex);
  let textForTokens, displaySpeaker, isContinuation;
  if (m) {
    currentSpeaker = m[1];
    textForTokens = block.slice(m[0].length);
    displaySpeaker = m[1];
    isContinuation = false;
  } else {
    textForTokens = block;
    displaySpeaker = currentSpeaker;
    isContinuation = true;
  }
  paragraphs.push({
    raw: block,
    speaker: displaySpeaker,
    isContinuation,
    headTokens: tokens(textForTokens).slice(0, HEAD_WORDS),
    totalTokens: tokens(textForTokens).length,
  });
}
console.log(`Parsed ${paragraphs.length} paragraphs.`);

// ── 3. Align each paragraph to a word-stream position ────────────────────
// Sequential overlap score: how many of `head` (in order) appear within a
// look-ahead slice of the raw word stream.
function sequentialOverlap(head, window) {
  if (head.length === 0) return 0;
  let qi = 0, matches = 0;
  for (let i = 0; i < window.length && qi < head.length; i++) {
    if (window[i].text === head[qi]) { matches++; qi++; }
  }
  return matches / head.length;
}

const MAX_LOOKAHEAD = 1200;  // ~5-10 minutes of words
const MIN_SCORE = 0.5;       // Skip rather than misplace
const SHORT_PARA_TOKENS = 5; // "Yeah." "Right, exactly." — don't worry about these

function findBestAlignment(head, cursor) {
  const from = Math.max(0, cursor - 5);
  const to = Math.min(rawWords.length, cursor + MAX_LOOKAHEAD);
  let bestScore = 0, bestIdx = -1;

  // Pass 1: anchor on each of the first 3 head words (handles proofreader
  // rephrasing the opening). We then score the full head against the window
  // following the anchor, so the matched span still reflects the paragraph's
  // beginning, not an arbitrary middle word.
  for (let anchorPos = 0; anchorPos < Math.min(3, head.length); anchorPos++) {
    const anchor = head[anchorPos];
    for (let i = from; i < to; i++) {
      if (rawWords[i].text !== anchor) continue;
      // Adjust idx backward by anchorPos so the timestamp targets the
      // paragraph's first word in the raw stream (best-effort).
      const candidateIdx = Math.max(from, i - anchorPos);
      const window = rawWords.slice(candidateIdx, candidateIdx + head.length * 3);
      const score = sequentialOverlap(head, window);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = candidateIdx;
        if (score >= 0.95) return { score: bestScore, idx: bestIdx };
      }
    }
    if (bestScore >= 0.6) break;
  }

  return { score: bestScore, idx: bestIdx };
}

let cursor = 0;
const aligned = [];
for (const para of paragraphs) {
  const head = para.headTokens;
  if (head.length < 2) {
    aligned.push({ ...para, timestamp: null, score: 0, idx: -1, skip: true });
    continue;
  }

  const { score, idx } = findBestAlignment(head, cursor);

  if (score >= MIN_SCORE && idx >= 0) {
    aligned.push({ ...para, timestamp: rawWords[idx].start, score, idx });
    // Only advance cursor for high-confidence matches. Weak matches might
    // be wrong — leave the cursor alone so the next paragraph re-scans.
    if (score >= 0.6) {
      cursor = idx + Math.max(1, Math.floor(para.totalTokens * 0.6));
    }
  } else {
    aligned.push({ ...para, timestamp: null, score, idx: -1 });
  }
}

// ── 4. Emit ──────────────────────────────────────────────────────────────
// "No timestamp" is better than "wrong timestamp" — readers can infer
// position from the neighbours. We also don't worry about very-short
// reaction paragraphs ("Yeah.", "Mm-hmm.") that aren't worth stamping.
const significant = aligned.filter(a => a.totalTokens >= SHORT_PARA_TOKENS && !a.skip);
const sigMatched = significant.filter(a => a.timestamp !== null).length;
const shortSkipped = aligned.filter(a => a.skip || a.totalTokens < SHORT_PARA_TOKENS).length;
const missing = significant.length - sigMatched;
const pct = significant.length ? Math.round(100 * sigMatched / significant.length) : 100;
console.log(
  `Aligned ${sigMatched}/${significant.length} significant paragraphs (${pct}%). ` +
  `${missing} left un-stamped, ${shortSkipped} short reactions skipped.`
);

const lines = [];
for (const a of aligned) {
  if (a.timestamp === null) {
    lines.push(a.raw); // no bracket — leave the position to be inferred
  } else {
    lines.push(`${formatTimestamp(a.timestamp)} ${a.raw}`);
  }
}
const output = lines.join('\n\n') + '\n';

mkdirSync(OUT_DIR, { recursive: true });
const outPath = join(OUT_DIR, `${slug}.md`);
writeFileSync(outPath, output);
console.log(`\nWrote ${outPath}`);

if (showDiff) {
  console.log('\n=== Un-stamped significant paragraphs ===\n');
  const misses = aligned.filter(a => a.timestamp === null && a.totalTokens >= SHORT_PARA_TOKENS && !a.skip);
  if (misses.length === 0) {
    console.log('(none)');
  } else {
    for (const a of misses.slice(0, 15)) {
      const preview = a.raw.slice(0, 110).replace(/\n/g, ' ');
      console.log(`  score=${a.score.toFixed(2)} tokens=${a.totalTokens}  ${preview}…`);
    }
    if (misses.length > 15) console.log(`  ... and ${misses.length - 15} more`);
  }
}
