/**
 * Shared episode-tagging logic.
 *
 * Single source of truth for how episodes get tagged, used by:
 *   - scripts/transcribe-new.mjs  (inline, one episode at a time, in the pipeline)
 *   - scripts/tag-episodes.mjs    (batch / direct re-tagging of the catalog)
 *
 * The canonical tag list lives in src/_data/tagTaxonomy.json. EDS and
 * Hypermobility are deliberately excluded from the taxonomy — they apply to
 * ~70% of episodes (the podcast's whole subject), so they're useless as tags.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export const TAG_MIN = 3;
export const TAG_MAX = 8;

/** Load and parse the canonical taxonomy from a repo root. */
export function loadTaxonomy(root) {
  const path = join(root, 'src', '_data', 'tagTaxonomy.json');
  if (!existsSync(path)) throw new Error(`Taxonomy file not found: ${path}`);
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/** Render the canonical tags as a bulleted list with alias hints. */
export function buildTagList(taxonomy) {
  return taxonomy.tags
    .map(t => {
      const aliases = t.aliases?.length ? ` (also: ${t.aliases.join(', ')})` : '';
      return `- ${t.name}${aliases}`;
    })
    .join('\n');
}

/** System prompt shared by every tagging call. */
export function buildSystemPrompt(taxonomy) {
  return `You are tagging episodes for a medical podcast about hypermobility and Ehlers-Danlos syndromes.

Given an episode's title, description, and transcript, select the tags that apply from the canonical list below. Only use tags from this list — never invent new ones.

Canonical tags:
${buildTagList(taxonomy)}

Rules:
- Select ${TAG_MIN}-${TAG_MAX} tags per episode (most episodes should have 4-6).
- A tag applies only if the episode substantively discusses that topic, not just a passing mention.
- EDS and hypermobility are the subject of the entire podcast, so they are intentionally NOT in the list — tag what makes THIS episode distinct from the others.
- Treat alias names as hints: if the content mentions an alias, return the canonical tag name.
- Return the tags ordered from most central to least central to the episode.

Respond with ONLY a JSON array of tag names, e.g. ["POTS", "Pain", "Physical Therapy"].`;
}

/** Build the user message content for one episode. */
export function buildUserContent({ title, description, transcript }) {
  return `Title: ${title}
Description: ${description || ''}${transcript ? `\n\nTranscript:\n${transcript}` : ''}`;
}

/** Parse a model response into an array of tag strings.
 *  Tolerates code fences and stray prose before/after the JSON array. */
export function parseTagJson(text) {
  const clean = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  try {
    return JSON.parse(clean);
  } catch {
    const m = clean.match(/\[[\s\S]*\]/); // first […] span
    if (m) return JSON.parse(m[0]);
    throw new Error(`No JSON array in response: ${clean.slice(0, 80)}`);
  }
}

/**
 * Validate raw model tags against the taxonomy: map aliases → canonical names,
 * drop anything unknown, de-duplicate, and cap at `max`. Returns { tags, dropped }.
 */
export function resolveTags(rawTags, taxonomy, { max = TAG_MAX } = {}) {
  if (!Array.isArray(rawTags)) return { tags: [], dropped: [] };

  const validNames = new Set(taxonomy.tags.map(t => t.name));
  const aliasMap = new Map();
  for (const t of taxonomy.tags) {
    aliasMap.set(t.name.toLowerCase(), t.name);
    for (const a of t.aliases || []) aliasMap.set(a.toLowerCase(), t.name);
  }

  const dropped = [];
  const resolved = [];
  for (const raw of rawTags) {
    if (typeof raw !== 'string') continue;
    const canonical = validNames.has(raw) ? raw : aliasMap.get(raw.toLowerCase());
    if (canonical) resolved.push(canonical);
    else dropped.push(raw);
  }
  return { tags: [...new Set(resolved)].slice(0, max), dropped };
}

/** Convenience: build the Anthropic request params for one episode. */
export function buildTagRequest(ep, transcript, taxonomy, model = 'claude-haiku-4-5-20251001') {
  return {
    model,
    max_tokens: 256,
    system: [{ type: 'text', text: buildSystemPrompt(taxonomy), cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: buildUserContent({ ...ep, transcript }) }],
  };
}
