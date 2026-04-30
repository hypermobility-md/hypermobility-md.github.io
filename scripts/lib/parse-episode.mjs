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

  // Known co-hosts. Each entry has a canonical name, any name variants
  // (alt spellings or with/without title), and a "role" hint:
  //   - "always": always classify as cohost when their name appears anywhere
  //     (e.g. Aron, the producer — never a guest of the show)
  //   - "contextual": cohost when they appear *alongside* another guest, OR
  //     when they're mentioned in title/description but NOT in the guests
  //     array. Treated as the featured guest when they're the only guest in
  //     the guests array (e.g. Dr. Dacre Knight is a recurring cohost, but
  //     ep 184 ["…with Dr. Dacre Knight"] features him as guest).
  //   - "keyword" (default): the original conservative behavior — only
  //     classified as cohost if the title/description explicitly says
  //     "co-host" / "cohost" near their name.
  // Variants are matched against title/description and guest lists, but the
  // canonical name is what gets stored in `cohosts` so the speaker count
  // stays correct (no double-counting of the same person).
  const knownCohosts = [
    { canonical: 'Jennifer Milner', aliases: [], role: 'keyword' },
    { canonical: 'Pradeep Chopra', aliases: [], role: 'keyword' },
    { canonical: 'Dacre Knight', aliases: [], role: 'contextual' },
    { canonical: 'Aron', aliases: ['Aaron'], role: 'always' }, // Human Content producer
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

  // First pass: how many of the named guests are *actual* guests (not host,
  // not always-cohost producer)? "Contextual" cohosts switch role based on
  // whether other guests are present, so we need this count up front.
  const nonHostGuests = guests.filter(g => {
    const lower = g.toLowerCase();
    return !hostNames.some(h => lower.includes(h));
  });
  const otherGuestsCount = (kc) => nonHostGuests.filter(g => !cohostMatchesName(kc, g.toLowerCase())).length;

  for (const guest of guests) {
    const guestLower = guest.toLowerCase();
    if (hostNames.some(h => guestLower.includes(h))) continue;

    const kc = knownCohosts.find(c => cohostMatchesName(c, guestLower));
    let isCohost = false;
    if (kc) {
      if (kc.role === 'always') {
        isCohost = true;
      } else if (kc.role === 'contextual') {
        // Cohost when there's at least one other guest besides them, or when
        // the description explicitly says "co-host". Sole-guest episodes
        // (e.g. "with Dr. Dacre Knight" as a feature interview) → guest.
        isCohost = otherGuestsCount(kc) > 0 || hasCohostMention;
      } else {
        isCohost = hasCohostMention;
      }
    }

    if (isCohost) {
      if (!alreadyHaveCohost(kc)) cohosts.push(kc.canonical);
    } else {
      guestSpeakers.push(guest);
    }
  }

  // Also detect known co-hosts mentioned in title/description even if not in
  // the guests array (sync-rss correctly excludes co-hosts from guests, but
  // we still need to count them as speakers). For "always" / "contextual"
  // cohosts, the keyword "co-host" isn't required — a name mention is enough.
  for (const kc of knownCohosts) {
    if (alreadyHaveCohost(kc)) continue;
    const inGuests = nonHostGuests.some(g => cohostMatchesName(kc, g.toLowerCase()));
    if (inGuests) continue; // already handled in the guests loop above
    const nameInDesc = cohostMatchesName(kc, titleAndDesc);
    if (!nameInDesc) continue;
    const shouldAdd =
      kc.role === 'always' ||
      kc.role === 'contextual' ||
      (kc.role === 'keyword' && hasCohostMention);
    if (shouldAdd) cohosts.push(kc.canonical);
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
