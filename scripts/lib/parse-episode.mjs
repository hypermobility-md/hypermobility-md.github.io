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

  // Known co-hosts
  const knownCohosts = [
    'Jennifer Milner',
    'Pradeep Chopra',
    'Dacre Knight',
  ];

  // Host name variations to filter out from guest list
  const hostNames = ['linda bluestein', 'dr. linda bluestein'];

  const cohosts = [];
  const guestSpeakers = [];

  for (const guest of guests) {
    const guestLower = guest.toLowerCase();
    // Skip the host if listed as a guest (solo/office hours episodes)
    if (hostNames.some(h => guestLower.includes(h))) continue;
    const isCohost = hasCohostMention && knownCohosts.some(kc => guestLower.includes(kc.toLowerCase()));
    if (isCohost) {
      cohosts.push(guest);
    } else {
      guestSpeakers.push(guest);
    }
  }

  // speakers_expected = 1 (host) + co-hosts + guest speakers
  const speakersExpected = 1 + cohosts.length + guestSpeakers.length;

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
