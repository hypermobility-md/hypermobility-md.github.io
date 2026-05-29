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
import { parseAllEpisodes } from './lib/parse-episode.mjs';

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

for (const ep of episodes) {
  const guestSpeakers = ep.guestSpeakers || [];
  const cohosts = (ep.cohosts || []).filter((c) => c !== HOST);
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
