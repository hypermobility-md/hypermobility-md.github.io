const HOST_NAME = 'Dr. Linda Bluestein';

// Known non-guest speakers who appear in Office Hours / solo episodes
// Map of name variants to canonical name
const KNOWN_PRODUCERS = {
  'aaron': 'Aron',
  'aron': 'Aron',
  'tessa': 'Tessa',
  'shanti': 'Shanti',
};

/**
 * Extract additional speaker names from episode title/description.
 * Looks for patterns like "joined by producer Aron" or "with Aron from Human Content".
 * Returns an array of names found.
 */
export function extractSpeakersFromDescription(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const found = [];
  for (const [variant, canonical] of Object.entries(KNOWN_PRODUCERS)) {
    if (text.includes(variant)) {
      if (!found.includes(canonical)) found.push(canonical);
    }
  }
  return found;
}

// Phrases the host typically says in the intro
const HOST_INTRO_PHRASES = [
  'welcome back',
  'bendy bodies',
  'hypermobility md',
  'every bendy body',
  'your host',
  'hello and welcome',
];

// Phrases that indicate ad/pre-roll content
const AD_PHRASES = [
  'npr sponsor',
  'paramount+',
  'the madison',
  'taylor sheridan',
  'michelle pfeiffer',
  'kurt russell',
  'peloton',
  'onepeloton.com',
  'cross training tread',
  'brought to you by',
  'bauerfeind',
  'bowerfine',
  'celsius energy',
  'celsius drink',
  'crisp celsius',
  'lowe\'s run',
  'buy 3 bags',
  'you said you were over him',
  'his hoodie',
  'grab your phon',
  'spring is here and the shopping',
  'let yourself run, lift',
  'explore the new peloton',
];

/**
 * Detect where the actual podcast content starts (after pre-roll ads).
 * Returns the index of the first non-ad utterance.
 */
export function findContentStart(utterances) {
  // Look for the first utterance that contains a host intro phrase
  for (let i = 0; i < utterances.length && i < 15; i++) {
    const textLower = utterances[i].text.toLowerCase();
    if (HOST_INTRO_PHRASES.some(p => textLower.includes(p))) {
      return i;
    }
  }

  // Fallback: find the first utterance that is NOT an ad
  for (let i = 0; i < utterances.length && i < 15; i++) {
    const textLower = utterances[i].text.toLowerCase();
    if (!AD_PHRASES.some(p => textLower.includes(p))) {
      return i;
    }
  }

  // If nothing matched, start from the beginning
  return 0;
}

/**
 * Check if an utterance is ad content.
 */
export function isAdContent(text) {
  const lower = text.toLowerCase();
  return AD_PHRASES.some(p => lower.includes(p));
}

/**
 * Given AssemblyAI utterances and episode metadata, map speaker labels to real names.
 * Filters out pre-roll ad content first, then maps speakers.
 * Returns { speakerMap: { A: "Name", B: "Name" }, confidence, flags, adSpeakers, contentStartIndex }
 */
export function mapSpeakers(utterances, episode) {
  const flags = [];

  if (!utterances || utterances.length === 0) {
    return { speakerMap: {}, confidence: 'low', flags: ['no utterances found'], adSpeakers: [], contentStartIndex: 0 };
  }

  // --- Step 0: Find where content starts (skip pre-roll ads) ---
  const contentStartIndex = findContentStart(utterances);
  const contentUtterances = utterances.slice(contentStartIndex);

  if (contentStartIndex > 0) {
    flags.push(`stripped ${contentStartIndex} pre-roll ad utterance(s)`);
  }

  // Identify speakers who ONLY appear in the ad section
  const adOnlyUtterances = utterances.slice(0, contentStartIndex);
  const adSpeakers = new Set(adOnlyUtterances.map(u => u.speaker));
  const contentSpeakers = new Set(contentUtterances.map(u => u.speaker));

  // Ad-only speakers are those who appear in ads but never in content
  const pureAdSpeakers = [...adSpeakers].filter(s => !contentSpeakers.has(s));

  // Get speaker labels from content only
  const speakerLabels = [...contentSpeakers];
  const speakerMap = {};

  if (speakerLabels.length === 0) {
    return { speakerMap: {}, confidence: 'low', flags: ['no content utterances found'], adSpeakers: pureAdSpeakers, contentStartIndex };
  }

  // --- Step 1: Identify the host by intro phrases ---
  let hostLabel = null;

  // Check first 5 content utterances for host intro phrases
  const introUtterances = contentUtterances.slice(0, 5);
  for (const u of introUtterances) {
    const textLower = u.text.toLowerCase();
    if (HOST_INTRO_PHRASES.some(p => textLower.includes(p))) {
      hostLabel = u.speaker;
      break;
    }
  }

  // Fallback: assume first content speaker is the host
  if (!hostLabel) {
    hostLabel = contentUtterances[0].speaker;
    flags.push('host detected by position only (no intro phrase match)');
  }

  speakerMap[hostLabel] = HOST_NAME;

  // --- Step 2: Map remaining speakers ---
  const remainingLabels = speakerLabels.filter(l => l !== hostLabel);
  const allSpeakers = [...episode.cohosts, ...episode.guestSpeakers];

  if (allSpeakers.length === 0) {
    // Try to find additional speaker names from the episode title/description
    const descSpeakers = extractSpeakersFromDescription(episode.title || '', episode.description || '');

    if (descSpeakers.length > 0 && remainingLabels.length > 0) {
      // Map detected speakers to description-extracted names by speaking order
      const labelOrder = remainingLabels.sort((a, b) => {
        const aFirst = contentUtterances.findIndex(u => u.speaker === a);
        const bFirst = contentUtterances.findIndex(u => u.speaker === b);
        return aFirst - bFirst;
      });
      let idx = 0;
      for (const name of descSpeakers) {
        if (idx < labelOrder.length) {
          speakerMap[labelOrder[idx]] = name;
          idx++;
        }
      }
      // Any remaining labels become generic speakers
      while (idx < labelOrder.length) {
        speakerMap[labelOrder[idx]] = `Speaker ${labelOrder[idx]}`;
        idx++;
      }
      flags.push(`extracted speaker name(s) from description: ${descSpeakers.join(', ')}`);
      return { speakerMap, confidence: 'medium', flags, adSpeakers: pureAdSpeakers, contentStartIndex };
    }

    // Solo episode — map any extra detected speakers to host (audio artifacts)
    for (const label of remainingLabels) {
      speakerMap[label] = HOST_NAME;
    }
    return { speakerMap, confidence: 'high', flags, adSpeakers: pureAdSpeakers, contentStartIndex };
  }

  if (remainingLabels.length === 1 && allSpeakers.length === 1) {
    speakerMap[remainingLabels[0]] = allSpeakers[0];
    return { speakerMap, confidence: 'high', flags, adSpeakers: pureAdSpeakers, contentStartIndex };
  }

  if (remainingLabels.length === 1 && allSpeakers.length > 1) {
    speakerMap[remainingLabels[0]] = allSpeakers[0];
    flags.push(`expected ${allSpeakers.length} non-host speakers but detected 1 — may need manual review`);
    return { speakerMap, confidence: 'low', flags, adSpeakers: pureAdSpeakers, contentStartIndex };
  }

  if (remainingLabels.length > 1 && allSpeakers.length === 0) {
    // Try description extraction for multiple unknown speakers
    const descSpeakers = extractSpeakersFromDescription(episode.title || '', episode.description || '');
    const labelOrder = remainingLabels.sort((a, b) => {
      const aFirst = contentUtterances.findIndex(u => u.speaker === a);
      const bFirst = contentUtterances.findIndex(u => u.speaker === b);
      return aFirst - bFirst;
    });
    let idx = 0;
    for (const name of descSpeakers) {
      if (idx < labelOrder.length) {
        speakerMap[labelOrder[idx]] = name;
        idx++;
      }
    }
    while (idx < labelOrder.length) {
      speakerMap[labelOrder[idx]] = `Speaker ${labelOrder[idx]}`;
      idx++;
    }
    if (descSpeakers.length > 0) {
      flags.push(`extracted speaker name(s) from description: ${descSpeakers.join(', ')}`);
    }
    flags.push(`${remainingLabels.length} non-host speakers detected but no guests listed`);
    return { speakerMap, confidence: 'low', flags, adSpeakers: pureAdSpeakers, contentStartIndex };
  }

  // --- Step 3: Multi-speaker mapping ---
  if (episode.cohosts.length > 0 && remainingLabels.length >= 2) {
    const labelOrder = remainingLabels.sort((a, b) => {
      const aFirst = contentUtterances.findIndex(u => u.speaker === a);
      const bFirst = contentUtterances.findIndex(u => u.speaker === b);
      return aFirst - bFirst;
    });

    let idx = 0;
    for (const cohost of episode.cohosts) {
      if (idx < labelOrder.length) {
        speakerMap[labelOrder[idx]] = cohost;
        idx++;
      }
    }
    for (const guest of episode.guestSpeakers) {
      if (idx < labelOrder.length) {
        speakerMap[labelOrder[idx]] = guest;
        idx++;
      }
    }
    while (idx < labelOrder.length) {
      speakerMap[labelOrder[idx]] = `Speaker ${labelOrder[idx]}`;
      idx++;
    }

    flags.push('multi-speaker episode — speaker assignments are best guesses, review recommended');
    return { speakerMap, confidence: 'medium', flags, adSpeakers: pureAdSpeakers, contentStartIndex };
  }

  // General multi-guest: map by speaking order in content
  const labelOrder = remainingLabels.sort((a, b) => {
    const aFirst = contentUtterances.findIndex(u => u.speaker === a);
    const bFirst = contentUtterances.findIndex(u => u.speaker === b);
    return aFirst - bFirst;
  });

  let idx = 0;
  for (const guest of allSpeakers) {
    if (idx < labelOrder.length) {
      speakerMap[labelOrder[idx]] = guest;
      idx++;
    }
  }
  while (idx < labelOrder.length) {
    speakerMap[labelOrder[idx]] = `Speaker ${labelOrder[idx]}`;
    idx++;
  }

  if (allSpeakers.length !== remainingLabels.length) {
    flags.push(`speaker count mismatch: expected ${allSpeakers.length} non-host, detected ${remainingLabels.length}`);
  }

  flags.push('multi-speaker episode — review recommended');

  const confidence = allSpeakers.length === remainingLabels.length ? 'medium' : 'low';
  return { speakerMap, confidence, flags, adSpeakers: pureAdSpeakers, contentStartIndex };
}
