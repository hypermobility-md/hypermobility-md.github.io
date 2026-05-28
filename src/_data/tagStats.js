// Tag-frequency stats, computed at build time from the episode files.
//
// Drives tag ordering across the site:
//   - filters/pickers (episode-page tag search, CMS)  → most → least common
//   - per-episode displays (cards, modal, episode page) → least → most common
//     (so each episode leads with its most distinctive topics, not the common ones)
//
// Exposed as the `tagStats` global:
//   tagStats.counts       → { "Pain": 58, ... }
//   tagStats.byFrequency  → [ { name, count }, ... ] sorted most → least common

const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

const EPISODES_DIR = path.join(__dirname, '..', 'episodes');

module.exports = function () {
  const counts = {};
  for (const file of fs.readdirSync(EPISODES_DIR).filter(f => f.endsWith('.md'))) {
    const { data } = matter(fs.readFileSync(path.join(EPISODES_DIR, file), 'utf-8'));
    for (const tag of data.tags || []) {
      counts[tag] = (counts[tag] || 0) + 1;
    }
  }

  const byFrequency = Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return { counts, byFrequency };
};
