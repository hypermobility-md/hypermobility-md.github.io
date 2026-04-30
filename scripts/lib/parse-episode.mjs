import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';

const EPISODES_DIR = join(import.meta.dirname, '..', '..', 'src', 'episodes');

/**
 * Parse a single episode markdown file.
 * Returns { slug, num, title, description, guests, audioUrl, videoUrl, duration, cohosts, guestSpeakers, speakersExpected, filePath }
 */
export function parseEpisode(filePath) {
  const raw = readFileSync(filePath, 'utf-8');
  const { data, content } = matter(raw);
  const slug = filePath.split('/').pop().replace('.md', '');

  const guests = data.guests || [];
  const title = data.title || '';
  const description = data.description || '';

  // Detect co-hosts from title + description
  const titleAndDesc = (title + ' ' + description).toLowerCase();
  const cohostPattern = /co-?host/i;
  const hasCohostMention = cohostPattern.test(titleAndDesc);

  // Known co-hosts. Each entry has a canonical name and any name variants
  // (alt spellings, with/without title) that should be recognized as the same
  // person — variants are matched against title/description and guest lists,
  // but the canonical name is what gets stored in `cohosts` so the speaker
  // count stays correct (no double-counting of the same person).
  const knownCohosts = [
    { canonical: 'Jennifer Milner', aliases: [] },
    { canonical: 'Pradeep Chopra', aliases: [] },
    { canonical: 'Dacre Knight', aliases: [] },
    { canonical: 'Aron', aliases: ['Aaron'] }, // Human Content producer; transcripts often render as "Aaron"
  ];

  // Word-boundary match — prevents 'Aron' from matching 'macaron' or 'Aaron'.
  // Uses \b which treats apostrophes and hyphens as boundaries (so "Smith's"
  // and "Jo-Anne" still match "Smith" and "Jo" respectively, which is what we
  // want for description text like "Dr. Smith's recent paper").
  function nameRegex(name) {
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`, 'i');
  }
  function cohostMatchesName(kc, lowerName) {
    if (nameRegex(kc.canonical).test(lowerName)) return true;
    return kc.aliases.some(a => nameRegex(a).test(lowerName));
  }
  function alreadyHaveCohost(kc) {
    return cohosts.some(c => c.toLowerCase() === kc.canonical.toLowerCase());
  }

  // Host name variations to filter out from guest list
  const hostNames = ['linda bluestein', 'dr. linda bluestein'];

  const cohosts = [];
  const guestSpeakers = [];

  for (const guest of guests) {
    const guestLower = guest.toLowerCase();
    // Skip the host if listed as a guest (solo/office hours episodes)
    if (hostNames.some(h => guestLower.includes(h))) continue;
    const matchedCohost = hasCohostMention
      ? knownCohosts.find(kc => cohostMatchesName(kc, guestLower))
      : null;
    if (matchedCohost) {
      if (!alreadyHaveCohost(matchedCohost)) cohosts.push(matchedCohost.canonical);
    } else {
      guestSpeakers.push(guest);
    }
  }

  // Also detect known co-hosts mentioned in title/description even if not in guests array
  // (sync-rss correctly excludes co-hosts from guests, but we still need to count them as speakers)
  if (hasCohostMention) {
    for (const kc of knownCohosts) {
      if (cohostMatchesName(kc, titleAndDesc) && !alreadyHaveCohost(kc)) {
        cohosts.push(kc.canonical);
      }
    }
  }

  // Frontmatter override: explicit `cohosts:` array (e.g. for solo/office-hours
  // episodes where the producer joins but isn't in the RSS guests list).
  // Aliases get folded back to the canonical name so we don't double-count.
  const fmCohosts = Array.isArray(data.cohosts) ? data.cohosts : [];
  for (const c of fmCohosts) {
    if (typeof c !== 'string' || !c.trim()) continue;
    const matched = knownCohosts.find(kc => cohostMatchesName(kc, c.toLowerCase()));
    const name = matched ? matched.canonical : c.trim();
    if (!cohosts.some(x => x.toLowerCase() === name.toLowerCase())) {
      cohosts.push(name);
    }
  }

  // speakers_expected = 1 (host) + co-hosts + guest speakers
  // Frontmatter may override via `speakersExpected:` for unusual episodes
  // (e.g. an unnamed panelist, a producer who joins mid-show, audio with
  // significant background voices). Only honored if it's a positive integer.
  let speakersExpected = 1 + cohosts.length + guestSpeakers.length;
  if (Number.isInteger(data.speakersExpected) && data.speakersExpected > 0) {
    speakersExpected = data.speakersExpected;
  }

  return {
    slug,
    num: data.num ?? null,
    title,
    description,
    guests,
    cohosts,
    guestSpeakers,
    speakersExpected,
    audioUrl: data.audioUrl || '',
    videoUrl: data.videoUrl || '',
    duration: data.duration || '',
    existingTranscript: content.trim(),
    filePath,
  };
}

/**
 * Parse all episodes in the episodes directory.
 */
export function parseAllEpisodes() {
  const files = readdirSync(EPISODES_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => join(EPISODES_DIR, f));

  return files.map(parseEpisode).sort((a, b) => (a.num ?? -1) - (b.num ?? -1));
}
