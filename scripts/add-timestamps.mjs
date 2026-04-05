#!/usr/bin/env node

/**
 * Retroactively add timestamps to already-proofread episode transcripts.
 *
 * Uses text-based fuzzy matching to align proofread turns with labeled
 * utterances (which have timing data from AssemblyAI). This handles:
 * - Speaker name mismatches (matches by text, not speaker name)
 * - Split turns (proofreader split one utterance into multiple turns)
 * - Merged turns (proofreader combined multiple utterances)
 *
 * Usage:
 *   node scripts/add-timestamps.mjs                 # Preview all
 *   node scripts/add-timestamps.mjs --write         # Write to src/episodes/
 *   node scripts/add-timestamps.mjs --episode 50    # Single episode
 *   node scripts/add-timestamps.mjs --verify        # Show alignment details
 *   node scripts/add-timestamps.mjs --mismatches    # Only process episodes with known mismatches
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
const mismatchesOnly = args.includes('--mismatches');
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;

// Episodes with known mismatches from timestamp-mismatch-report.md
const MISMATCH_EPISODES = new Set([
  '000', '005', '006', '007', '011', '013', '016', '019', '022', '024',
  '025', '026', '027', '029', '030', '037', '038', '039', '042', '046',
  '048', '054', '055', '056', '058', '060', '064', '073', '079', '081',
  '082', '085', '094', '095', '111', '122', '131', '133', '134', '136',
  '141', '151', '169', '170', '174', '176', '177', '180',
  'bonus-glaucomflecken',
]);

// ── Inline ad detection ─────────────────────────────────────────────────
const INTRO_PHRASES = [
  'welcome back',
  'hello and welcome',
  'every bendy body',
  'welcome to the bendy bodies',
  'welcome to bendy bodies',
];

const INLINE_AD_PHRASES = [
  'brought to you by bauerfeind',
  'brought to you by bowerfine',
  'bauerfeind premium braces',
  'bowerfine promotes mobility',
  'this episode of the bendy bodies podcast is brought to you',
];

function stripInlineAds(text) {
  const lower = text.toLowerCase();
  const hasInlineAd = INLINE_AD_PHRASES.some(p => lower.includes(p));
  if (!hasInlineAd) return text;

  let introIdx = -1;
  for (const phrase of INTRO_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1 && (introIdx === -1 || idx < introIdx)) {
      introIdx = idx;
    }
  }

  if (introIdx > 0) {
    const trimmed = text.slice(introIdx);
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  if (text.length < 500 && !INTRO_PHRASES.some(p => lower.includes(p))) {
    return '';
  }

  return text;
}

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
 * Normalize text for fuzzy matching: lowercase, strip punctuation, collapse whitespace.
 */
function normalizeText(text) {
  return text
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/[""]/g, '"')
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract words from text for matching.
 */
function extractWords(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

/**
 * Jaccard similarity between two word sets (bag-of-words overlap).
 * Robust to word reordering and partial edits.
 */
function jaccardSimilarity(wordsA, wordsB) {
  if (wordsA.length === 0 || wordsB.length === 0) return 0;
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

/**
 * Sequential word overlap: how many words from `query` appear in order within `target`.
 */
function sequentialOverlap(queryWords, targetWords) {
  if (queryWords.length === 0 || targetWords.length === 0) return 0;
  const n = Math.min(queryWords.length, 25);
  const query = queryWords.slice(0, n);
  let bestMatches = 0;

  for (let start = 0; start <= Math.max(0, targetWords.length - Math.floor(n / 2)); start++) {
    let matches = 0;
    let qi = 0;
    for (let ti = start; ti < Math.min(start + n * 3, targetWords.length) && qi < n; ti++) {
      if (targetWords[ti] === query[qi]) {
        matches++;
        qi++;
      }
    }
    if (matches > bestMatches) bestMatches = matches;
  }
  return bestMatches / n;
}

/**
 * Combined similarity score using both Jaccard and sequential overlap.
 * Takes the higher of the two, with a bonus when both agree.
 */
function similarityScore(queryWords, targetWords) {
  const jaccard = jaccardSimilarity(queryWords, targetWords);
  const sequential = sequentialOverlap(queryWords, targetWords);
  return Math.max(jaccard, sequential);
}

/**
 * Extract utterances from labeled JSON, merging consecutive same-speaker
 * utterances and stripping ads (mirrors format-transcripts logic).
 */
function extractLabeledUtterances(labeled) {
  const { utterances } = labeled;
  if (!utterances || utterances.length === 0) return [];

  const result = [];
  let currentSpeaker = null;
  let currentStart = null;
  let currentText = '';
  let isFirstUtterance = true;
  let hasFlushedAny = false;

  for (const u of utterances) {
    let text = u.text;

    if (isFirstUtterance || !hasFlushedAny) {
      text = stripInlineAds(text);
      if (!text) continue;
    }
    isFirstUtterance = false;

    if (u.speakerName === currentSpeaker) {
      currentText += ' ' + text;
    } else {
      if (currentSpeaker !== null) {
        result.push({ speaker: currentSpeaker, start: currentStart, text: currentText });
        hasFlushedAny = true;
      }
      currentSpeaker = u.speakerName;
      currentStart = u.start;
      currentText = text;
    }
  }

  if (currentSpeaker !== null) {
    result.push({ speaker: currentSpeaker, start: currentStart, text: currentText });
  }

  return result;
}

/**
 * Also extract raw (unmerged) utterances for finer-grained text matching.
 */
function extractRawUtterances(labeled) {
  const { utterances } = labeled;
  if (!utterances || utterances.length === 0) return [];

  const result = [];
  let hasFlushedAny = false;

  for (const u of utterances) {
    let text = u.text;
    if (!hasFlushedAny) {
      text = stripInlineAds(text);
      if (!text) continue;
    }
    hasFlushedAny = true;
    result.push({ speaker: u.speakerName, start: u.start, end: u.end, text });
  }

  return result;
}

/**
 * Detect speaker names from proofread text.
 */
function detectSpeakers(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const candidates = new Map();
  for (const line of lines) {
    const m = line.match(/^([A-Z][^:]{1,60}):\s/);
    if (m) {
      const name = m[1];
      candidates.set(name, (candidates.get(name) || 0) + 1);
    }
  }
  return [...candidates.keys()];
}

/**
 * Parse proofread markdown into turns with full text.
 */
function parseProofreadTurns(text, speakers) {
  const lines = text.split('\n');
  const turns = [];
  let currentTurn = null;

  const escapedNames = speakers.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const speakerRegex = new RegExp(`^(${escapedNames.join('|')}):\\s`);

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(speakerRegex);
    if (match) {
      if (currentTurn) {
        currentTurn.endLine = i - 1;
        turns.push(currentTurn);
      }
      // Extract text after "Speaker: "
      const textStart = lines[i].slice(match[0].length);
      currentTurn = {
        speaker: match[1],
        lineIdx: i,
        textLines: [textStart],
      };
    } else if (currentTurn && lines[i].trim()) {
      currentTurn.textLines.push(lines[i].trim());
    }
  }
  if (currentTurn) {
    currentTurn.endLine = lines.length - 1;
    turns.push(currentTurn);
  }

  // Compute full text for each turn
  for (const turn of turns) {
    turn.text = turn.textLines.join(' ');
    turn.words = extractWords(turn.text);
  }

  return turns;
}

/**
 * Text-based timestamp alignment.
 * For each proofread turn, finds the best-matching labeled utterance(s) by text similarity.
 * Also tries matching against consecutive utterance pairs (for merged turns).
 * Enforces monotonic timestamp ordering.
 */
function alignByText(proofreadTurns, rawUtterances) {
  // Build word arrays for all raw utterances
  const uttWords = rawUtterances.map(u => ({
    ...u,
    words: extractWords(u.text),
  }));

  // Pre-build merged pairs (consecutive utterances combined) for handling proofread merges
  const mergedPairs = [];
  for (let i = 0; i < uttWords.length - 1; i++) {
    mergedPairs.push({
      start: uttWords[i].start,
      words: [...uttWords[i].words, ...uttWords[i + 1].words],
      firstIdx: i,
    });
  }
  // Also triples for heavy merges
  const mergedTriples = [];
  for (let i = 0; i < uttWords.length - 2; i++) {
    mergedTriples.push({
      start: uttWords[i].start,
      words: [...uttWords[i].words, ...uttWords[i + 1].words, ...uttWords[i + 2].words],
      firstIdx: i,
    });
  }

  const matches = [];
  let searchStart = 0;
  const THRESHOLD = 0.15;

  for (const turn of proofreadTurns) {
    if (turn.words.length < 2) {
      matches.push({ turn, matched: false, score: 0 });
      continue;
    }

    let bestScore = 0;
    let bestTimestamp = 0;
    let bestIdx = -1;

    // Search forward from last match, with backtrack allowance
    const from = Math.max(0, searchStart - 3);
    const to = uttWords.length;

    // 1. Try individual utterances
    for (let i = from; i < to; i++) {
      const score = similarityScore(turn.words, uttWords[i].words);
      if (score > bestScore) {
        bestScore = score;
        bestTimestamp = uttWords[i].start;
        bestIdx = i;
      }
      if (bestScore > 0.7 && i > bestIdx + 15) break;
    }

    // 2. Try merged pairs (for when proofreader merged 2 utterances)
    if (bestScore < 0.5) {
      for (let i = Math.max(0, from - 1); i < mergedPairs.length; i++) {
        if (mergedPairs[i].firstIdx < from - 3) continue;
        const score = similarityScore(turn.words, mergedPairs[i].words);
        if (score > bestScore) {
          bestScore = score;
          bestTimestamp = mergedPairs[i].start;
          bestIdx = mergedPairs[i].firstIdx;
        }
        if (bestScore > 0.6 && mergedPairs[i].firstIdx > bestIdx + 10) break;
      }
    }

    // 3. Try merged triples (for heavy merges)
    if (bestScore < 0.4 && turn.words.length > 30) {
      for (let i = Math.max(0, from - 2); i < mergedTriples.length; i++) {
        if (mergedTriples[i].firstIdx < from - 3) continue;
        const score = similarityScore(turn.words, mergedTriples[i].words);
        if (score > bestScore) {
          bestScore = score;
          bestTimestamp = mergedTriples[i].start;
          bestIdx = mergedTriples[i].firstIdx;
        }
        if (bestScore > 0.5 && mergedTriples[i].firstIdx > bestIdx + 10) break;
      }
    }

    if (bestScore >= THRESHOLD && bestIdx >= 0) {
      matches.push({
        turn,
        matched: true,
        score: bestScore,
        utteranceIdx: bestIdx,
        timestamp: bestTimestamp,
      });
      if (bestIdx >= searchStart) {
        searchStart = bestIdx;
      }
    } else {
      matches.push({ turn, matched: false, score: bestScore });
    }
  }

  return matches;
}

/**
 * Apply timestamps to proofread text based on alignment results.
 */
function applyTimestamps(proofreadText, alignmentResults) {
  const lines = proofreadText.split('\n');
  let matched = 0;
  let unmatched = 0;
  const mismatches = [];

  for (const result of alignmentResults) {
    if (result.matched) {
      const ts = formatTimestamp(result.timestamp);
      lines[result.turn.lineIdx] = `${ts} ${lines[result.turn.lineIdx]}`;
      matched++;
    } else {
      unmatched++;
      if (result.turn.words.length >= 3) {
        mismatches.push(`Line ${result.turn.lineIdx + 1}: ${result.turn.speaker} (score: ${result.score.toFixed(2)}, ${result.turn.words.length} words)`);
      }
    }
  }

  return {
    text: lines.join('\n'),
    matched,
    total: alignmentResults.length,
    mismatches,
  };
}

function main() {
  let labeledFiles = readdirSync(LABELED_DIR).filter(f => f.endsWith('.json'));

  if (singleEpisode) {
    const padded = String(singleEpisode).padStart(3, '0');
    labeledFiles = labeledFiles.filter(f => f === `${padded}.json` || f === `${singleEpisode}.json`);
  }

  if (mismatchesOnly) {
    labeledFiles = labeledFiles.filter(f => {
      const slug = f.replace('.json', '');
      return MISMATCH_EPISODES.has(slug);
    });
  }

  mkdirSync(TIMESTAMPED_DIR, { recursive: true });

  console.log(`Scanning ${labeledFiles.length} labeled transcripts...\n`);

  let processed = 0;
  let written = 0;
  let skipped = 0;
  let perfect = 0;
  let warnings = 0;

  for (const file of labeledFiles) {
    const slug = file.replace('.json', '');
    const proofreadPath = join(PROOFREAD_DIR, `${slug}.md`);

    if (!existsSync(proofreadPath)) {
      skipped++;
      continue;
    }

    const labeled = JSON.parse(readFileSync(join(LABELED_DIR, file), 'utf-8'));
    const proofreadText = readFileSync(proofreadPath, 'utf-8');

    // Skip if already has timestamps
    if (/^\[\d+:\d+/.test(proofreadText)) {
      if (verify) console.log(`SKIP ${slug}: already has timestamps`);
      skipped++;
      continue;
    }

    // Detect speakers and parse turns
    const speakers = detectSpeakers(proofreadText);
    if (speakers.length === 0) {
      if (verify) console.log(`SKIP ${slug}: no speakers detected`);
      skipped++;
      continue;
    }

    const proofreadTurns = parseProofreadTurns(proofreadText, speakers);

    // Extract raw utterances (unmerged) for finer text matching
    const rawUtterances = extractRawUtterances(labeled);

    if (rawUtterances.length === 0) {
      if (verify) console.log(`SKIP ${slug}: no utterances in labeled JSON`);
      skipped++;
      continue;
    }

    // Align by text similarity
    const alignment = alignByText(proofreadTurns, rawUtterances);
    const result = applyTimestamps(proofreadText, alignment);

    // Save to timestamped/ output folder
    writeFileSync(join(TIMESTAMPED_DIR, `${slug}.md`), result.text);

    if (result.mismatches.length > 0) {
      const pct = Math.round((result.matched / result.total) * 100);
      if (pct < 90) {
        warnings++;
        console.log(`⚠ ${slug}: ${result.matched}/${result.total} (${pct}%) turns timestamped`);
      } else {
        console.log(`~ ${slug}: ${result.matched}/${result.total} (${pct}%) turns timestamped`);
      }
      if (verify) {
        for (const m of result.mismatches.slice(0, 5)) {
          console.log(`    ${m}`);
        }
        if (result.mismatches.length > 5) {
          console.log(`    ... and ${result.mismatches.length - 5} more`);
        }
      }
    } else {
      perfect++;
      console.log(`✓ ${slug}: ${result.matched}/${result.total} turns timestamped`);
    }

    processed++;

    if (writeToEpisodes) {
      const episodePath = join(EPISODES_DIR, `${slug}.md`);
      if (!existsSync(episodePath)) {
        console.log(`  SKIP write: ${slug}.md not found in episodes/`);
        continue;
      }

      const raw = readFileSync(episodePath, 'utf-8');
      const { data } = matter(raw);
      writeFileSync(episodePath, matter.stringify(result.text, data));
      written++;
    }
  }

  console.log(`\nOutput: ${TIMESTAMPED_DIR}`);
  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Perfect (100%): ${perfect}`);
  console.log(`Warnings (<90%): ${warnings}`);
  console.log(`Skipped: ${skipped}`);
  if (writeToEpisodes) {
    console.log(`Written to episodes: ${written}`);
  } else {
    console.log(`Preview mode: use --write to also update episode files`);
  }
}

main();
