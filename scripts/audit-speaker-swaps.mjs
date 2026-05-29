#!/usr/bin/env node

/**
 * Heuristic detector for guest-label swaps in published transcripts.
 *
 * Speaker attribution is assigned positionally (mapSpeakers zips diarization
 * labels to the guest list by speaking order), so two guests can end up
 * swapped throughout an episode. This script flags likely swaps by looking for
 * direct-address cues: when a turn ends by addressing a cast member by name
 * ("...so, Kasi, what do you think?"), the NEXT turn is almost always that
 * person's answer. If it's labeled someone else, that's a swap signal.
 *
 * Read-only. Prints a ranked list; does not modify anything.
 *
 *   node scripts/audit-speaker-swaps.mjs            # all episodes
 *   node scripts/audit-speaker-swaps.mjs --min 1    # min signals to list (default 1)
 */

import { readFileSync } from 'fs';
import matter from 'gray-matter';
import { parseAllEpisodes, KNOWN_COHOSTS } from './lib/parse-episode.mjs';

const args = process.argv.slice(2);
const minIdx = args.indexOf('--min');
const MIN_SIGNALS = minIdx !== -1 ? parseInt(args[minIdx + 1], 10) : 1;

const HOST = 'Dr. Linda Bluestein';
const SPEAKER = /^(?:\[\d{1,2}:\d{2}(?::\d{2})?\]\s+)?\*{0,2}([A-Z][^:\n*]{1,60}):\*{0,2}\s/;

// First name used for vocative matching: strip title, take first token.
function firstName(name) {
  return name
    .replace(/^(Dr\.?|Prof\.?|Professor|Mr\.?|Ms\.?|Mrs\.?)\s+/i, '')
    .trim()
    .split(/\s+/)[0]
    .toLowerCase();
}

function parseTurns(body) {
  const blocks = body.split(/\n\s*\n/);
  const turns = [];
  let current = null;
  for (const block of blocks) {
    const m = block.match(SPEAKER);
    if (m) {
      if (current) turns.push(current);
      current = { speaker: m[1].trim(), text: block.slice(m[0].length) };
    } else if (current) {
      current.text += ' ' + block.trim();
    }
  }
  if (current) turns.push(current);
  return turns;
}

// Does `text` address one of `names` (by first name) near its end?
// Returns the addressed canonical name, or null.
function addressedName(text, nameByFirst) {
  const tail = text.slice(-160).toLowerCase();
  for (const [fn, canonical] of nameByFirst) {
    // vocative patterns: ", kasi?" / ", kasi." / ", kasi," / "kasi, can you" /
    // "to you, kasi" / "with you, kasi"
    const re = new RegExp(`[,\\s]${fn}[\\s]*[\\?\\.,]|\\b${fn},\\s+(can|could|what|how|tell|do|would|why|when|where)\\b`, 'i');
    if (re.test(tail)) return canonical;
  }
  return null;
}

const episodes = parseAllEpisodes()
  .filter((e) => e.num !== null)
  .sort((a, b) => a.num - b.num);

const results = [];

// Producers (role 'always') read questions but are low-stakes to tell apart
// and diarize poorly, so a Tessa↔Shanti "swap" is permanent noise here. Pass 2
// already covers the producer issue that matters (merged into the host).
const PRODUCERS = new Set(KNOWN_COHOSTS.filter((c) => c.role === 'always').map((c) => c.canonical));

for (const ep of episodes) {
  const guestSpeakers = ep.guestSpeakers || [];
  const cohosts = (ep.cohosts || []).filter((c) => c !== HOST && !PRODUCERS.has(c));
  const cast = [...cohosts, ...guestSpeakers];
  if (cast.length < 2) continue; // swaps need ≥2 non-host speakers

  // Map first name → canonical, skipping ambiguous shared first names.
  const byFirst = new Map();
  const seen = new Map();
  for (const name of cast) {
    const fn = firstName(name);
    seen.set(fn, (seen.get(fn) || 0) + 1);
  }
  for (const name of cast) {
    const fn = firstName(name);
    if (seen.get(fn) === 1) byFirst.set(fn, name);
  }
  if (byFirst.size < 2) continue;

  const body = matter(readFileSync(ep.filePath, 'utf-8')).content;
  const turns = parseTurns(body);

  let mismatches = 0;
  let matches = 0;
  const examples = [];

  for (let i = 0; i < turns.length - 1; i++) {
    const addressed = addressedName(turns[i].text, byFirst);
    if (!addressed) continue;
    const next = turns[i + 1].speaker.replace(/\*/g, '');
    if (next === HOST || next === turns[i].speaker) continue; // host follow-up / same speaker
    // Only consider when next speaker is a known guest (not "Speaker X")
    if (!cast.includes(next)) continue;
    if (next === addressed) {
      matches++;
    } else {
      mismatches++;
      if (examples.length < 2) {
        examples.push(`addressed ${addressed} → next turn labeled ${next}`);
      }
    }
  }

  if (mismatches >= MIN_SIGNALS) {
    results.push({ slug: ep.slug, num: ep.num, mismatches, matches, cast, examples });
  }
}

results.sort((a, b) => b.mismatches - a.mismatches || b.num - a.num);

console.log(`\nLikely speaker swaps (${results.length} episodes, ≥${MIN_SIGNALS} signal):\n`);
console.log('ep    swap/ok  cast');
console.log('--------------------------------------------------');
for (const r of results) {
  console.log(
    `${String(r.num).padEnd(5)} ${String(r.mismatches).padStart(2)}/${String(r.matches).padEnd(2)}    ${r.cast.join(', ')}`
  );
  for (const ex of r.examples) console.log(`        • ${ex}`);
}
console.log(`\n${results.length} flagged. Heuristic — review before re-processing.`);

// ── Pass 2: merged co-hosts / producers ──────────────────────────────────────
//
// The re-proof's cast list comes from each episode's metadata, which omits
// recurring non-guest voices (co-host Jennifer Milner, Office Hours producers
// Tessa/Shanti). When one of them isn't in the cast, the LLM tended to FOLD
// their turns into the host — collapsing a Q&A into one monologue, sometimes
// with no speaker-id flag (e.g. ep 177). This pass catches that: a recurring
// voice (or an explicitly self-identified name) is named in the transcript as
// a participant, but never appears as a speaker label.

// Strong "someone is actively participating" cues that capture a name. These
// are intro/self-ID phrasings, not bare mentions — "co-host Jennifer Milner"
// and "producers Tessa and Shanti" mean a voice in the room, whereas a name in
// the outro credits or referenced as a topic does not.
const CUES = [
  /\bthis is (?:co-?hosts?\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+here\b/g,
  /\bco-?hosts?,?\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g,
  /\b(?:joined|here|along)\s+(?:today\s+)?(?:by|with)\s+(?:co-?hosts?\s+)?([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g,
  /\bproducers?\s+([A-Z][a-z]+)(?:\s+and\s+([A-Z][a-z]+))?\b/g,
];
// "I'm X" is too loose on its own (matches "I'm Bendy Bodies"), so only trust it
// for a name we already know is a recurring non-guest voice.
const KNOWN_NAMES = new Set(KNOWN_COHOSTS.flatMap((c) => [c.canonical, ...c.aliases]));
const I_AM = /\b(?:I'?m|I am)\s+([A-Z][a-z]+\s+[A-Z][a-z]+)\b/g;

const HOST_TOKENS = new Set(['linda', 'bluestein', 'dr']);

function labelMatchesName(label, name) {
  // Lenient: do the label and the candidate share a distinctive (non-host) token?
  const norm = (s) => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  const lt = new Set(norm(label));
  return norm(name).some((tok) => tok.length > 2 && !HOST_TOKENS.has(tok) && lt.has(tok));
}

const mergedResults = [];

for (const ep of episodes) {
  const body = matter(readFileSync(ep.filePath, 'utf-8')).content;
  const turns = parseTurns(body);
  const labels = [...new Set(turns.map((t) => t.speaker.replace(/\*/g, '').trim()))];
  const isLabeled = (name) => labels.some((l) => labelMatchesName(l, name));
  const isHost = (name) => name.toLowerCase().split(/\s+/).every((t) => HOST_TOKENS.has(t));

  const candidates = new Map(); // name → cue snippet
  const consider = (name, snippet) => {
    if (!name || isHost(name) || isLabeled(name)) return;
    candidates.set(name, snippet);
  };

  for (const cue of CUES) {
    for (const m of body.matchAll(cue)) {
      consider(m[1], `"${m[0].trim()}"`);
      consider(m[2], `"${m[0].trim()}"`);
    }
  }
  for (const m of body.matchAll(I_AM)) {
    if (KNOWN_NAMES.has(m[1])) consider(m[1], `"${m[0].trim()}"`);
  }

  if (candidates.size) {
    mergedResults.push({ num: ep.num, slug: ep.slug, candidates: [...candidates.entries()] });
  }
}

mergedResults.sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9));

console.log(`\n\nPossible merged co-hosts / producers (${mergedResults.length} episodes):`);
console.log('named as a participant in the transcript but never used as a speaker label\n');
console.log('ep     missing label (cue)');
console.log('--------------------------------------------------');
for (const r of mergedResults) {
  for (const [name, cue] of r.candidates) {
    console.log(`${String(r.num ?? r.slug).padEnd(6)} ${name} — ${cue}`);
  }
}
console.log(`\n${mergedResults.length} flagged. Heuristic — confirm against the audio/description before fixing.`);

// ── Pass 3: self-ID vs. label mismatch ───────────────────────────────────────
//
// Re-transcribing with speakers_expected recovers a merged voice, but the
// proofread then has to tell two similar co-host voices apart (Linda vs
// Jennifer Milner) — and sometimes transposes them. That swap is invisible to
// Pass 1 (both names appear) and Pass 2 (both are labeled). The tell is a turn
// whose own text self-identifies as someone else: "**Dr. Linda Bluestein:** I'm
// Jennifer Milner, a former professional ballet dancer…". Flag when a turn
// opens with a self-ID naming a *different* cast member than its label.
const SELF_ID_OPEN = /^(?:I'?m|I am|this is)\s+(?:co-?host\s+)?((?:Dr\.\s+)?[A-Z][a-z]+\s+[A-Z][a-z]+)\b/;

const selfIdResults = [];
for (const ep of episodes) {
  const body = matter(readFileSync(ep.filePath, 'utf-8')).content;
  const turns = parseTurns(body);
  const castNames = [HOST, ...(ep.cohosts || []), ...(ep.guestSpeakers || [])];
  const hits = [];
  for (const t of turns) {
    const m = t.text.trim().match(SELF_ID_OPEN);
    if (!m) continue;
    const claimed = m[1];
    // Only trust it when the claimed name is a known cast member for this ep.
    const claimedCast = castNames.find((n) => labelMatchesName(n, claimed));
    if (!claimedCast) continue;
    const label = t.speaker.replace(/\*/g, '').trim();
    if (!labelMatchesName(label, claimed)) {
      hits.push(`labeled "${label}" but says "${m[0].trim()}"`);
    }
  }
  if (hits.length) selfIdResults.push({ num: ep.num, slug: ep.slug, hits });
}
selfIdResults.sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9));
console.log(`\n\nSelf-ID vs. label mismatches (${selfIdResults.length} episodes):`);
console.log('a turn whose text self-identifies as a different cast member than its label\n');
for (const r of selfIdResults) {
  for (const h of r.hits) console.log(`${String(r.num ?? r.slug).padEnd(6)} ${h}`);
}
console.log(`\n${selfIdResults.length} flagged. Likely a two-co-host (Linda/Jennifer) transposition.`);
