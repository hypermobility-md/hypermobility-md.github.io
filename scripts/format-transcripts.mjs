#!/usr/bin/env node

/**
 * Stage 3: Format labeled transcripts into markdown and optionally write to episode files.
 * Reads from scripts/output/labeled/, writes to scripts/output/formatted/
 *
 * Usage:
 *   node scripts/format-transcripts.mjs              # Format all, save to formatted/
 *   node scripts/format-transcripts.mjs --write      # Also write to src/episodes/
 *   node scripts/format-transcripts.mjs --episode 50
 */

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';

const LABELED_DIR = join(import.meta.dirname, 'output', 'labeled');
const FORMATTED_DIR = join(import.meta.dirname, 'output', 'formatted');
const EPISODES_DIR = join(import.meta.dirname, '..', 'src', 'episodes');

const args = process.argv.slice(2);
const writeToEpisodes = args.includes('--write');
const episodeIdx = args.indexOf('--episode');
const singleEpisode = episodeIdx !== -1 ? args[episodeIdx + 1] : null;

// Phrases that mark the start of actual podcast content
const INTRO_PHRASES = [
  'welcome back',
  'hello and welcome',
  'every bendy body',
  'welcome to the bendy bodies',
  'welcome to bendy bodies',
];

// Phrases that indicate inline ad/sponsor content to strip
const INLINE_AD_PHRASES = [
  'brought to you by bauerfeind',
  'brought to you by bowerfine',
  'bauerfeind premium braces',
  'bowerfine promotes mobility',
  'this episode of the bendy bodies podcast is brought to you',
];

/**
 * Strip inline ad content from the beginning of a text block.
 * If the text contains both an ad read and an intro, trim to the intro.
 */
function stripInlineAds(text) {
  const lower = text.toLowerCase();

  // Check if text starts with ad content
  const hasInlineAd = INLINE_AD_PHRASES.some(p => lower.includes(p));
  if (!hasInlineAd) return text;

  // Find where the actual intro starts
  let introIdx = -1;
  for (const phrase of INTRO_PHRASES) {
    const idx = lower.indexOf(phrase);
    if (idx !== -1 && (introIdx === -1 || idx < introIdx)) {
      introIdx = idx;
    }
  }

  if (introIdx > 0) {
    // Trim to start at the intro, capitalize first letter
    const trimmed = text.slice(introIdx);
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  }

  // No intro found — the whole block might be just an ad read
  // Check if it's ONLY ad content (no substantive content after)
  if (text.length < 500 && !INTRO_PHRASES.some(p => lower.includes(p))) {
    return ''; // Pure ad block, remove entirely
  }

  return text;
}

/**
 * Convert labeled utterances to formatted markdown transcript.
 */
function formatTranscript(labeled) {
  const { utterances } = labeled;
  if (!utterances || utterances.length === 0) return '';

  const paragraphs = [];
  let currentSpeaker = null;
  let currentText = [];
  let isFirstUtterance = true;

  for (const u of utterances) {
    let text = u.text;

    // Strip inline ads from early utterances
    if (isFirstUtterance || paragraphs.length === 0) {
      text = stripInlineAds(text);
      if (!text) continue; // Skip pure ad blocks
    }
    isFirstUtterance = false;

    if (u.speakerName === currentSpeaker) {
      // Same speaker continues — merge
      currentText.push(text);
    } else {
      // New speaker — flush previous
      if (currentSpeaker !== null) {
        const joined = currentText.join(' ').trim();
        if (joined) paragraphs.push(`${currentSpeaker}: ${joined}`);
      }
      currentSpeaker = u.speakerName;
      currentText = [text];
    }
  }

  // Flush last speaker
  if (currentSpeaker !== null) {
    const joined = currentText.join(' ').trim();
    if (joined) paragraphs.push(`${currentSpeaker}: ${joined}`);
  }

  return paragraphs.join('\n\n');
}

/**
 * Replace the body content of an episode markdown file (everything after frontmatter).
 */
function writeToEpisodeFile(slug, transcriptMarkdown) {
  const filePath = join(EPISODES_DIR, `${slug}.md`);
  const raw = readFileSync(filePath, 'utf-8');

  // Find the closing --- of frontmatter
  // Frontmatter starts with --- on line 1, ends with --- on a later line
  const lines = raw.split('\n');
  let frontmatterEnd = -1;
  let foundFirst = false;

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (!foundFirst) {
        foundFirst = true;
      } else {
        frontmatterEnd = i;
        break;
      }
    }
  }

  if (frontmatterEnd === -1) {
    throw new Error(`Could not find frontmatter end in ${filePath}`);
  }

  const frontmatter = lines.slice(0, frontmatterEnd + 1).join('\n');
  const newContent = frontmatter + '\n' + transcriptMarkdown + '\n';
  writeFileSync(filePath, newContent);
}

function main() {
  let labeledFiles = readdirSync(LABELED_DIR).filter(f => f.endsWith('.json'));

  if (singleEpisode) {
    labeledFiles = labeledFiles.filter(f => {
      const slug = f.replace('.json', '');
      return slug === singleEpisode || slug === String(singleEpisode).padStart(3, '0');
    });
  }

  if (labeledFiles.length === 0) {
    console.log('No labeled transcripts found. Run label-speakers.mjs first.');
    return;
  }

  console.log(`Formatting ${labeledFiles.length} transcripts...`);
  if (writeToEpisodes) {
    console.log('--write flag set: will also update episode files.\n');
  } else {
    console.log('Preview mode: saving to formatted/ only. Use --write to update episodes.\n');
  }

  let formatted = 0;
  let written = 0;

  for (const file of labeledFiles) {
    const slug = file.replace('.json', '');
    const labeled = JSON.parse(readFileSync(join(LABELED_DIR, file), 'utf-8'));

    const markdown = formatTranscript(labeled);

    if (!markdown) {
      console.log(`SKIP ${slug}: empty transcript`);
      continue;
    }

    // Save formatted markdown
    writeFileSync(join(FORMATTED_DIR, `${slug}.md`), markdown);
    formatted++;

    if (writeToEpisodes) {
      try {
        writeToEpisodeFile(slug, markdown);
        written++;
        console.log(`✓ ${slug} (written to episode)`);
      } catch (err) {
        console.error(`✗ ${slug}: ${err.message}`);
      }
    } else {
      console.log(`✓ ${slug} (formatted)`);
    }
  }

  console.log(`\n=== Summary ===`);
  console.log(`Formatted: ${formatted}`);
  if (writeToEpisodes) {
    console.log(`Written to episodes: ${written}`);
  }
  console.log(`Output: ${FORMATTED_DIR}`);
}

main();
