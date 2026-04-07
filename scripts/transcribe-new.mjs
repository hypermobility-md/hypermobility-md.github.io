#!/usr/bin/env node

/**
 * Transcribe new podcast episodes end-to-end.
 *
 * Pipeline:
 *   1. Submit to AssemblyAI → raw transcript with word-level timestamps
 *   2. Label speakers (map A/B/C → real names)
 *   3. Format as plain text for proofreading
 *   4. Proofread with Haiku (fix speakers, terminology, remove ads + fillers)
 *   5. Add timestamps via word-level alignment
 *   6. Write to episode file
 *
 * Usage:
 *   node scripts/transcribe-new.mjs                # Transcribe all new episodes
 *   node scripts/transcribe-new.mjs --dry-run      # Show what would be transcribed
 *   node scripts/transcribe-new.mjs --max 3        # Limit to 3 episodes per run
 *   node scripts/transcribe-new.mjs --episode 190  # Single episode
 *   node scripts/transcribe-new.mjs --episode 50 --force  # Re-process with existing raw data
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { parseAllEpisodes } from './lib/parse-episode.mjs';
import { submitTranscription } from './lib/assemblyai-helpers.mjs';
import { mapSpeakers } from './lib/speaker-map.mjs';
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

const anthropic = new Anthropic({
  timeout: 20 * 60 * 1000,
});

// ── Proofreading ──────────────────────────────────────────────────────

const PROOFREAD_SYSTEM_PROMPT = `You are a professional transcript editor for the Bendy Bodies Podcast, a medical podcast about hypermobility and Ehlers-Danlos syndromes hosted by Dr. Linda Bluestein (the Hypermobility MD).

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

## Task 3: Proofread and Clean

- Fix obvious transcription errors in medical/scientific terminology (EDS, POTS, MCAS, collagen, proprioception, etc.)
- Fix misspelled proper nouns and speaker names if clearly wrong
- Fix garbled or nonsensical phrases where the intended meaning is clear
- Remove filler words (um, uh) and verbal stammers (e.g., repeated false starts like "I, I, I think"), but keep affirmative responses like "uh-huh" and "mm-hmm"
- Do NOT rewrite for style — preserve the conversational, spoken tone

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

const MAX_RETRIES = 5;

async function proofreadTranscript(slug, text) {
  const estInputTokens = Math.round(text.length / 4);
  const maxTokens = Math.min(64000, Math.max(16000, Math.round(estInputTokens * 1.3)));

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const message = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: maxTokens,
        system: [{ type: 'text', text: PROOFREAD_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
        messages: [{
          role: 'user',
          content: `Here is the transcript for episode ${slug} of the Bendy Bodies Podcast. Please clean, format, and proofread it.\n\n<transcript>\n${text}\n</transcript>`,
        }],
      });

      if (message.stop_reason === 'max_tokens') {
        throw new Error(`Proofread output truncated at ${maxTokens} max_tokens`);
      }

      const responseText = message.content[0].text;
      const transcriptMatch = responseText.match(/<transcript>\s*\n?([\s\S]*?)\n?\s*<\/transcript>/);
      const reportMatch = responseText.match(/<report>\s*\n?([\s\S]*?)\n?\s*<\/report>/);

      if (!transcriptMatch) {
        throw new Error('Could not find <transcript> tags in proofread response');
      }

      let report = {};
      if (reportMatch) {
        try {
          const reportStr = reportMatch[1].trim().replace(/^```json?\n?/, '').replace(/\n?```$/, '');
          report = JSON.parse(reportStr);
        } catch { /* report parsing is best-effort */ }
      }

      return {
        transcript: transcriptMatch[1].trim(),
        report,
        usage: { input_tokens: message.usage.input_tokens, output_tokens: message.usage.output_tokens },
      };
    } catch (err) {
      const isRetryable = err?.status === 429 || err?.status === 529 || err?.status >= 500;
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

// ── Formatting ────────────────────────────────────────────────────────

const INTRO_PHRASES = [
  'welcome back', 'hello and welcome', 'every bendy body',
  'welcome to the bendy bodies', 'welcome to bendy bodies',
];

const INLINE_AD_PHRASES = [
  'brought to you by bauerfeind', 'brought to you by bowerfine',
  'bauerfeind premium braces', 'bowerfine promotes mobility',
  'this episode of the bendy bodies podcast is brought to you',
];

function stripInlineAds(text) {
  const lower = text.toLowerCase();
  if (!INLINE_AD_PHRASES.some(p => lower.includes(p))) return text;

  let introIdx = -1;
  for (const phrase of INTRO_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1 && (introIdx === -1 || idx < introIdx)) introIdx = idx;
  }

  if (introIdx > 0) {
    const trimmed = text.slice(introIdx);
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  if (text.length < 500 && !INTRO_PHRASES.some(p => lower.includes(p))) return '';
  return text;
}

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
 * Format labeled utterances as plain text for proofreading (no timestamps).
 * Merges consecutive same-speaker utterances.
 */
function formatPlainText(utterances) {
  if (!utterances || utterances.length === 0) return '';

  const paragraphs = [];
  let currentSpeaker = null;
  let currentText = [];
  let isFirstUtterance = true;

  for (const u of utterances) {
    let text = u.text;

    if (isFirstUtterance || paragraphs.length === 0) {
      text = stripInlineAds(text);
      if (!text) continue;
    }
    isFirstUtterance = false;

    if (u.speakerName === currentSpeaker) {
      currentText.push(text);
    } else {
      if (currentSpeaker !== null) {
        const joined = currentText.join(' ').trim();
        if (joined) paragraphs.push(`${currentSpeaker}: ${joined}`);
      }
      currentSpeaker = u.speakerName;
      currentText = [text];
    }
  }

  if (currentSpeaker !== null) {
    const joined = currentText.join(' ').trim();
    if (joined) paragraphs.push(`${currentSpeaker}: ${joined}`);
  }

  return paragraphs.join('\n\n');
}

// ── Word-level timestamp alignment ────────────────────────────────────

/**
 * Normalize a word for matching: lowercase, strip punctuation.
 */
function normalizeWord(word) {
  return word.toLowerCase().replace(/[^a-z0-9']/g, '');
}

/**
 * Align proofread transcript turns to raw word-level timestamps.
 *
 * For each speaker turn with enough words (≥ minTurnWords), finds the
 * matching position in the raw word array by sequential word matching.
 * Short backchannels ("Right.", "Yeah.") get no timestamp.
 */
function alignWordTimestamps(proofreadText, rawWords, minTurnWords = 4) {
  const lines = proofreadText.split('\n');
  const speakerRegex = /^([A-Z][^:]{1,60}):\s/;

  // Identify speaker turn start lines and collect full text for each turn
  const turnStarts = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(speakerRegex);
    if (!match) continue;

    const textAfterSpeaker = lines[i].slice(match[0].length);
    let fullText = textAfterSpeaker;
    for (let j = i + 1; j < lines.length; j++) {
      if (speakerRegex.test(lines[j])) break;
      if (lines[j].trim()) fullText += ' ' + lines[j].trim();
    }
    turnStarts.push({ lineIdx: i, fullText });
  }

  // Build normalized raw word list
  const normRaw = rawWords
    .filter(w => w.text && w.start != null)
    .map(w => ({ text: normalizeWord(w.text), start: w.start }));

  // Match each turn via sequential word matching
  let searchPos = 0;
  const QUERY_LEN = 15;
  const MIN_MATCH_RATIO = 0.4;

  for (const turn of turnStarts) {
    const words = turn.fullText.split(/\s+/).map(normalizeWord).filter(Boolean);

    if (words.length < minTurnWords) {
      turn.timestamp = null;
      continue;
    }

    const query = words.slice(0, QUERY_LEN);
    let bestScore = 0;
    let bestStart = null;
    let bestIdx = searchPos;

    const from = Math.max(0, searchPos - 50);

    for (let i = from; i < normRaw.length; i++) {
      let matches = 0;
      let qi = 0;
      const windowEnd = Math.min(i + query.length * 3, normRaw.length);
      for (let ri = i; ri < windowEnd && qi < query.length; ri++) {
        if (normRaw[ri].text === query[qi]) {
          matches++;
          qi++;
        }
      }
      const score = matches / query.length;
      if (score > bestScore) {
        bestScore = score;
        bestStart = normRaw[i].start;
        bestIdx = i;
      }
      if (bestScore > 0.7 && i > bestIdx + 200) break;
    }

    if (bestScore >= MIN_MATCH_RATIO) {
      turn.timestamp = bestStart;
      if (bestIdx >= searchPos) searchPos = bestIdx;
    } else {
      turn.timestamp = null;
    }
  }

  // Enforce monotonic timestamps: if a timestamp is earlier than the previous,
  // use the previous timestamp (they're close enough that it doesn't matter)
  let lastTs = 0;
  for (const turn of turnStarts) {
    if (turn.timestamp != null) {
      if (turn.timestamp < lastTs) {
        turn.timestamp = lastTs;
      }
      lastTs = turn.timestamp;
    }
  }

  // Apply timestamps to speaker lines
  for (const turn of turnStarts) {
    if (turn.timestamp != null) {
      const ts = formatTimestamp(turn.timestamp);
      lines[turn.lineIdx] = `${ts} ${lines[turn.lineIdx]}`;
    }
  }

  const matched = turnStarts.filter(t => t.timestamp != null).length;
  const total = turnStarts.length;
  return { text: lines.join('\n'), matched, total };
}

// ── Auto-tagging ──────────────────────────────────────────────────────

/**
 * Tag a single episode using the canonical taxonomy.
 * Used for new episodes in the pipeline (not batch).
 */
async function tagEpisode(ep, transcript, taxonomy) {
  const tagList = taxonomy.tags.map(t => {
    const aliases = t.aliases?.length ? ` (also: ${t.aliases.join(', ')})` : '';
    return `- ${t.name}${aliases}`;
  }).join('\n');

  const excerpt = transcript.split(/\s+/).slice(0, 500).join(' ');

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Tag this podcast episode using ONLY tags from this list:
${tagList}

Title: ${ep.title}
Description: ${ep.description}
Transcript excerpt: ${excerpt}

Select 3-8 tags that apply. Respond with ONLY a JSON array.`,
    }],
  });

  let text = message.content[0].text.trim()
    .replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const tags = JSON.parse(text);
  const validNames = new Set(taxonomy.tags.map(t => t.name));
  return Array.isArray(tags) ? tags.filter(t => validNames.has(t)) : [];
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

      // Stage 4: Proofread with Haiku
      console.log(`  Proofreading with Haiku...`);
      const proofread = await proofreadTranscript(ep.slug, plainText);

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

      // Stage 5: Align timestamps via word-level matching
      const { text: timestamped, matched, total } = alignWordTimestamps(proofread.transcript, raw.words || []);
      const pct = total > 0 ? Math.round((matched / total) * 100) : 0;
      console.log(`  ✓ Timestamps aligned: ${matched}/${total} turns (${pct}%)`);

      // Stage 6: Auto-tag using taxonomy (if available)
      const taxonomyPath = join(SCRIPTS_DIR, '..', 'src', '_data', 'tagTaxonomy.json');
      let autoTags = [];
      if (existsSync(taxonomyPath)) {
        try {
          const taxonomy = JSON.parse(readFileSync(taxonomyPath, 'utf-8'));
          autoTags = await tagEpisode(ep, timestamped, taxonomy);
          console.log(`  ✓ Tagged: ${autoTags.join(', ')}`);
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
