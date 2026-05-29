/**
 * Transcript timestamping + formatting.
 *
 * Two entry points share one renderer so the live pipeline
 * (transcribe-new.mjs) and a back-catalogue reformatter produce byte-identical
 * markdown:
 *
 *   alignAndFormat(proofreadText, rawWords)
 *     - proofreadText: clean plain-text speaker turns, no timestamps
 *     - rawWords:      AssemblyAI word stream [{ text, start }]
 *     Aligns every paragraph against the word stream (paragraph-level, so long
 *     monologues get a timestamp at each break, not just the speaker turn) and
 *     renders the formatted markdown.
 *
 *   reformatExisting(bodyText)
 *     - bodyText: an episode body that already has "[mm:ss] Name: ..." lines
 *     Re-renders with the same formatting (bold names, same-speaker grouping)
 *     reusing whatever timestamps are already present. No word stream needed,
 *     so it works on every episode regardless of how it was stamped.
 *
 * Rendering rules:
 *   - Speaker names are bold: "**Dr. Linda Bluestein:**".
 *   - Consecutive paragraphs by the same speaker are joined with a markdown
 *     hard break (trailing "\") so they render as one tight block; a blank
 *     line separates different speakers.
 *   - Each paragraph keeps its own leading "[mm:ss]" timestamp (or none, if
 *     alignment was not confident — a missing stamp beats a wrong one).
 */

// Matches an optional leading timestamp, then a "Candidate: " prefix. The
// candidate is only ACCEPTED as a speaker label if it also passes isSpeakerLabel
// — otherwise a sentence with a mid-line colon ("So the timing of it is this:")
// would be mistaken for a speaker turn.
const STAMP = /^\[(\d{1,2}):(\d{2})(?::(\d{2}))?\]\s+/;
const SPEAKER = /^([A-Z][^:\n]{1,60}):\s+/;

// Lowercase tokens allowed inside a name (particles/connectors).
const NAME_PARTICLES = new Set([
  'de', 'del', 'della', 'der', 'den', 'van', 'von', 'la', 'le', 'di', 'da',
  'dos', 'das', 'el', 'bin', 'al', 'y', 'e',
]);

// Common single-word sentence openers that can precede a colon ("So:", "Then:")
// and must never be mistaken for a one-word speaker name.
const SENTENCE_OPENERS = new Set([
  'so', 'then', 'now', 'well', 'okay', 'ok', 'yes', 'no', 'right', 'and', 'but',
  'because', 'actually', 'anyway', 'oh', 'yeah', 'also', 'plus', 'first',
  'second', 'third', 'finally', 'honestly', 'basically', 'look', 'listen',
  'sure', 'true', 'exactly', 'absolutely', 'again', 'meanwhile', 'however',
]);

/**
 * Decide whether `candidate` (the text before a colon) is a real speaker label.
 * If `known` (a Set of canonical names) is supplied, require an exact match —
 * the proofreader is instructed to use the cast names verbatim, so this is
 * both strict and correct for the live pipeline. Otherwise fall back to a
 * name-shape heuristic: Title-Case words only, no lowercase function words,
 * at most a handful of tokens.
 */
function isSpeakerLabel(candidate, known) {
  const name = candidate.trim();
  if (known) {
    return known.has(name) || known.has(name.toLowerCase());
  }
  const words = name.split(/\s+/);
  if (words.length === 0 || words.length > 6) return false;
  // A lone capitalized word that's a common opener ("So", "Then") is prose.
  if (words.length === 1 && SENTENCE_OPENERS.has(words[0].replace(/[.,]/g, '').toLowerCase())) {
    return false;
  }
  let capWords = 0;
  for (const w of words) {
    const clean = w.replace(/[.,]/g, '');
    if (!clean) continue;
    if (/^[A-Z]/.test(clean)) { capWords++; continue; } // Name, Initial, or CREDENTIAL
    if (NAME_PARTICLES.has(clean.toLowerCase())) continue;
    return false; // a lowercase, non-particle word → this is prose, not a name
  }
  return capWords >= 1;
}

// Alignment tuning (ported from the paragraph-level add-timestamps algorithm).
const HEAD_WORDS = 8;
const MAX_LOOKAHEAD = 1200; // ~5-10 min of words ahead of the cursor
const MIN_SCORE = 0.5; // below this, leave un-stamped
const ADVANCE_SCORE = 0.6; // only advance the cursor on confident matches
const SHORT_PARA_TOKENS = 5; // "Yeah.", "Mm-hmm." — not worth stamping/counting

// ── formatting helpers ──────────────────────────────────────────────────

export function formatTimestamp(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `[${h}:${pad(m)}:${pad(s)}]` : `[${pad(m)}:${pad(s)}]`;
}

function parseStampMs(line) {
  const m = line.match(STAMP);
  if (!m) return null;
  const h = m[3] ? Number(m[1]) : 0;
  const min = m[3] ? Number(m[2]) : Number(m[1]);
  const sec = m[3] ? Number(m[3]) : Number(m[2]);
  return (h * 3600 + min * 60 + sec) * 1000;
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\w\s']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalize(text).split(' ').filter(Boolean);
}

// ── shared paragraph model ────────────────────────────────────────────────
//
// A paragraph is one blank-line-separated block. We track the speaker so the
// renderer can group consecutive same-speaker blocks. Continuation paragraphs
// (no "Name:" prefix) inherit the running speaker.

function parseParagraphs(text, { stamped, known }) {
  const blocks = text
    .split(/\n\s*\n/)
    .map((b) => b.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const paras = [];
  let currentSpeaker = null;

  for (const block of blocks) {
    let rest = block;
    let timestamp = null;

    if (stamped) {
      timestamp = parseStampMs(rest);
      rest = rest.replace(STAMP, '');
    }

    const m = rest.match(SPEAKER);
    let speaker = null;
    let body = rest;
    if (m && isSpeakerLabel(m[1], known)) {
      speaker = m[1].trim();
      body = rest.slice(m[0].length);
      currentSpeaker = speaker;
    }

    const allTokens = tokens(body);
    paras.push({
      isStart: speaker !== null,
      speaker: currentSpeaker,
      body,
      timestamp,
      headTokens: allTokens.slice(0, HEAD_WORDS),
      totalTokens: allTokens.length,
    });
  }

  return paras;
}

// ── paragraph-level alignment against the raw word stream ──────────────────

function sequentialOverlap(head, window) {
  if (head.length === 0) return 0;
  let qi = 0;
  let matches = 0;
  for (let i = 0; i < window.length && qi < head.length; i++) {
    if (window[i] === head[qi]) {
      matches++;
      qi++;
    }
  }
  return matches / head.length;
}

function findBestAlignment(head, cursor, rawWords) {
  const from = Math.max(0, cursor - 5);
  const to = Math.min(rawWords.length, cursor + MAX_LOOKAHEAD);
  let bestScore = 0;
  let bestIdx = -1;

  // Anchor on each of the first 3 head words. If the proofreader rephrased the
  // opening word, head[1] or head[2] usually still appears; we back the
  // candidate index up by the anchor offset so the stamp targets the start.
  for (let anchorPos = 0; anchorPos < Math.min(3, head.length); anchorPos++) {
    const anchor = head[anchorPos];
    for (let i = from; i < to; i++) {
      if (rawWords[i].text !== anchor) continue;
      const candidateIdx = Math.max(from, i - anchorPos);
      const window = rawWords
        .slice(candidateIdx, candidateIdx + head.length * 3)
        .map((w) => w.text);
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

function alignParagraphs(paras, rawWords) {
  let cursor = 0;
  for (const para of paras) {
    const head = para.headTokens;
    if (head.length < 2) {
      para.timestamp = null;
      continue;
    }
    const { score, idx } = findBestAlignment(head, cursor, rawWords);
    if (score >= MIN_SCORE && idx >= 0) {
      para.timestamp = rawWords[idx].start;
      if (score >= ADVANCE_SCORE) {
        cursor = idx + Math.max(1, Math.floor(para.totalTokens * 0.6));
      }
    } else {
      para.timestamp = null;
    }
  }
  return paras;
}

/**
 * The exact moments a *different* speaker starts talking, from AssemblyAI's
 * diarization. Consecutive same-speaker utterances are collapsed so each entry
 * is a real turn boundary. Uses the raw diarization `speaker` label (not the
 * reattributed name), since reattribution renames turns but never moves the
 * acoustic boundary.
 */
function acousticTurnStarts(utterances) {
  const starts = [];
  let prevSpeaker = null;
  for (const u of utterances || []) {
    if (u.start == null) continue;
    if (u.speaker !== prevSpeaker) {
      starts.push(u.start);
      prevSpeaker = u.speaker;
    }
  }
  return starts.sort((a, b) => a - b);
}

/**
 * Word-alignment misses a turn start whenever the proofreader edited its
 * opening words (e.g. "Lipidema" → "Lipedema"). But a speaker turn *is* a
 * speaker switch, and AssemblyAI gives the exact switch time. So fill each
 * un-stamped turn-start paragraph from the diarization boundaries, bounded by
 * its nearest stamped neighbours: collect the run of un-stamped turn-starts
 * between two stamped anchors and zip them, in order, onto the switch times
 * that fall in that interval.
 */
function fillTurnStartsFromUtterances(paras, utterances) {
  const starts = acousticTurnStarts(utterances);
  if (starts.length === 0) return;

  const n = paras.length;
  let i = 0;
  let lastTime = 0;
  while (i < n) {
    if (paras[i].timestamp != null) {
      lastTime = paras[i].timestamp;
      i++;
      continue;
    }
    // A run of consecutive un-stamped paragraphs; collect the turn-starts in it.
    let j = i;
    const runStarts = [];
    while (j < n && paras[j].timestamp == null) {
      if (paras[j].isStart) runStarts.push(j);
      j++;
    }
    const nextTime = j < n ? paras[j].timestamp : Infinity;
    const avail = starts.filter((s) => s > lastTime && s < nextTime);
    // Zip the un-stamped turn-starts onto the available switch times, in order.
    for (let k = 0; k < runStarts.length && k < avail.length; k++) {
      paras[runStarts[k]].timestamp = avail[k];
    }
    i = j;
  }
}

/** Clamp timestamps to be non-decreasing in document order. */
function enforceMonotonic(paras) {
  let last = 0;
  for (const p of paras) {
    if (p.timestamp == null) continue;
    if (p.timestamp < last) p.timestamp = last;
    last = p.timestamp;
  }
}

// ── renderer ───────────────────────────────────────────────────────────────

function renderLine(para) {
  const stamp = para.timestamp != null ? `${formatTimestamp(para.timestamp)} ` : '';
  const name = para.isStart && para.speaker ? `**${para.speaker}:** ` : '';
  return `${stamp}${name}${para.body}`;
}

function render(paras) {
  const turns = [];
  let current = [];

  for (const para of paras) {
    if (para.isStart && current.length) {
      turns.push(current);
      current = [];
    }
    current.push(renderLine(para));
  }
  if (current.length) turns.push(current);

  // Within a turn, join lines with a markdown hard break (trailing "\").
  // Between turns, a blank line.
  return turns.map((lines) => lines.join('\\\n')).join('\n\n') + '\n';
}

function coverage(paras) {
  const significant = paras.filter((p) => p.totalTokens >= SHORT_PARA_TOKENS);
  const matched = significant.filter((p) => p.timestamp != null).length;
  const pct = significant.length ? Math.round((100 * matched) / significant.length) : 100;
  return { matched, total: significant.length, pct };
}

// A clean person-name shape: TWO+ capitalised words (e.g. "Jennifer Milner"),
// optional trailing credentials. Requiring ≥2 words means a one-off single
// capitalised token ("So:", "Then:") is never accepted on shape alone — a
// genuine one-word speaker name must instead recur or be in the known cast.
const CLEAN_NAME = /^[A-Z][\w.'-]*(\s+[A-Z][\w.'-]*)+(,\s*[A-Z.]+)?$/;

/**
 * Discover the real speaker labels actually used in a transcript: name-shaped
 * candidates that either recur (≥2 turns) or have a clean person-name shape.
 * This admits an unlisted co-host who self-identifies (e.g. "Jennifer Milner")
 * while rejecting one-off mid-sentence colon clauses.
 */
function discoverSpeakers(text, stamped) {
  const counts = new Map();
  for (const p of parseParagraphs(text, { stamped, known: null })) {
    if (p.isStart) counts.set(p.speaker, (counts.get(p.speaker) || 0) + 1);
  }
  return new Set(
    [...counts.entries()]
      .filter(([name, n]) => n >= 2 || CLEAN_NAME.test(name))
      .map(([name]) => name)
  );
}

// ── entry points ─────────────────────────────────────────────────────────

/**
 * Align a clean proofread transcript to the raw word stream and format it.
 * @param {string} proofreadText
 * @param {Array<{text:string,start:number}>} rawWords
 * @param {Iterable<string>} [knownSpeakers] - canonical cast names; when given,
 *   only these are treated as speaker labels (prevents mid-sentence colons from
 *   being mistaken for speaker turns).
 * @param {Array<{speaker:string,start:number}>} [utterances] - diarization
 *   utterances; when given, un-stamped speaker-turn starts are filled from the
 *   exact speaker-switch times (robust to proofreader word edits).
 * @returns {{ text: string, matched: number, total: number, pct: number }}
 */
export function alignAndFormat(proofreadText, rawWords, knownSpeakers, utterances) {
  // Recognise the cast we were told about PLUS any other recurring/clean-name
  // labels the proofreader actually used (e.g. an unlisted co-host who
  // self-identified). Mid-sentence colon clauses are excluded by discoverSpeakers.
  const known = new Set([
    ...(knownSpeakers || []),
    ...discoverSpeakers(proofreadText, false),
  ]);
  const paras = parseParagraphs(proofreadText, { stamped: false, known });
  const normRaw = (rawWords || [])
    .filter((w) => w.text && w.start != null)
    .map((w) => ({ text: normalize(w.text), start: w.start }))
    .filter((w) => w.text);
  alignParagraphs(paras, normRaw);
  if (utterances && utterances.length) fillTurnStartsFromUtterances(paras, utterances);
  enforceMonotonic(paras);
  return { text: render(paras), ...coverage(paras) };
}

/**
 * Re-render an already-stamped episode body with current formatting,
 * reusing whatever timestamps are present. No word stream required.
 *
 * Without an explicit cast, speaker labels are recognised by name-shape; we
 * additionally require a candidate to recur (≥2 turns) OR be a clean all-caps
 * name, so a one-off mid-sentence colon is never treated as a speaker.
 * @param {string} bodyText
 * @param {Iterable<string>} [knownSpeakers]
 * @returns {string}
 */
export function reformatExisting(bodyText, knownSpeakers) {
  const known = knownSpeakers
    ? new Set(knownSpeakers)
    : discoverSpeakers(bodyText, true);
  const paras = parseParagraphs(bodyText, { stamped: true, known });
  return render(paras);
}
