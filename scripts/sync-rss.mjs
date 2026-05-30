#!/usr/bin/env node

/**
 * Sync podcast episodes from the Megaphone RSS feed.
 *
 * Pass 1 — New episodes:  fetch RSS → parse → match guest via Haiku → write skeleton .md
 * Pass 2 — YouTube backfill: episodes missing videoUrl → match against the YT playlist RSS feed by publish date → add URL
 *
 * Usage:
 *   node scripts/sync-rss.mjs                  # Full sync (RSS + YouTube backfill)
 *   node scripts/sync-rss.mjs --dry-run        # Preview without writing files
 *   node scripts/sync-rss.mjs --rss-only       # Skip YouTube backfill
 *   node scripts/sync-rss.mjs --yt-only        # Skip RSS, only backfill YouTube
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';
import { normalizeKey } from './lib/guest-keys.mjs';

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dirname, '..');
const EPISODES_DIR = join(ROOT, 'src', 'episodes');
const PROFILES_DIR = join(ROOT, 'src', 'guest-profiles');
const GUEST_IMAGES = join(ROOT, 'src', '_data', 'guestImages.json');

// ── Config ───────────────────────────────────────────────────────────────────
const RSS_URL = 'https://feeds.megaphone.fm/bendybodies';
const YT_PLAYLIST = 'https://www.youtube.com/playlist?list=PLX9StmpQKW33Iak1WJjAnOXPIxq0M_w_L';
const YT_TOP_N = 15; // check the most recent N feed entries for backfill (feed returns ~15)

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RSS_ONLY = args.includes('--rss-only');
const YT_ONLY = args.includes('--yt-only');

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Parse an RSS XML string into an array of episode objects. */
function parseRSS(xml) {
  const items = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i'))
        || block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };
    const encMatch = block.match(/<enclosure[^>]+url="([^"]+)"/i);
    items.push({
      title: get('title'),
      description: get('description') || get('content:encoded'),
      pubDate: get('pubDate'),
      duration: parseInt(get('itunes:duration'), 10) || 0,
      audioUrl: encMatch ? encMatch[1] : '',
      guid: get('guid'),
    });
  }
  return items;
}

/** Extract episode number from title. Handles both formats:
 *  - New: "Topic (Ep 188)" or "(BEN 172)"
 *  - Old: "95. Topic with Guest" */
function parseEpNumber(title) {
  // New format: (Ep 188), (EP 171), (BEN 172)
  const newFmt = title.match(/\((?:Ep|EP|BEN)\s*(\d+)\)\s*$/i);
  if (newFmt) return parseInt(newFmt[1], 10);
  // Old format: "95. Topic..." at the start
  const oldFmt = title.match(/^(\d+)\.\s+/);
  if (oldFmt) return parseInt(oldFmt[1], 10);
  return null;
}

// ── Host / cohost filtering ─────────────────────────────────────────────
const HOST_NAME = 'Dr. Linda Bluestein';
const COHOST_NAMES = ['Dr. Dacre Knight', 'Jennifer Milner'];

/** Check if a name refers to the host. */
function isHost(name) {
  const norm = name.toLowerCase().replace(/^(dr\.|prof\.)\s+/i, '').replace(/,?\s*(md|do|phd|dpt|m\.d\.)\b/gi, '').trim();
  return norm.includes('linda bluestein') || norm.includes('bluestein');
}

/** Check if a name refers to a cohost (not the host). */
function isCohost(name) {
  const norm = name.toLowerCase().replace(/^(dr\.|prof\.)\s+/i, '').replace(/,?\s*(md|do|phd|dpt)\b/gi, '').trim();
  for (const cohost of COHOST_NAMES) {
    const cohostNorm = cohost.toLowerCase().replace(/^dr\.\s+/, '');
    if (norm === cohostNorm || norm.includes(cohostNorm)) return true;
  }
  return false;
}

/** Use Haiku to extract guest names from episode title and description. */
async function extractGuestsWithHaiku(title, description) {
  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `You are extracting podcast guest names from an episode of "Bendy Bodies" hosted by Dr. Linda Bluestein.

Title: "${title}"
Description: "${description.slice(0, 1000)}"

Rules:
- Extract the names of people who appear as GUESTS on this episode
- For solo episodes or Office Hours where Dr. Linda Bluestein is the only speaker (or is joined only by producers like Aron, Tessa, or Shanti), include "Dr. Linda Bluestein" as a guest
- Do NOT include "Dr. Linda Bluestein" when there are other named guests — she is the host
- Do NOT include cohost "Dr. Dacre Knight" unless the title features him as a guest (e.g., "Topic with Dr. Dacre Knight")
- Do NOT include "Jennifer Milner" unless the title explicitly names her as a guest or "Guest Co-Host"
- A "Guest Co-Host" or "Guest Cohost" named in the title IS a guest — include them
- For round table episodes, extract guest names from the description if they are clearly listed
- Only include people clearly identified as appearing on THIS episode
- Do NOT guess or infer guests from general topic mentions

Credential formatting:
- Use "Dr." prefix for MDs/DOs/PhDs (e.g., "Dr. Jane Smith")
- Append other credentials after a comma (e.g., "Jane Smith, DPT" or "Jane Smith, RDN")
- Prefer the name as it appears in the TITLE over the description
- Do NOT include "MD" or "M.D." after "Dr." — the "Dr." replaces it

Respond with ONLY a JSON array of strings (no markdown, no explanation). Examples:
["Dr. Jane Smith"]
["Dr. Jane Smith", "Jane Doe, DPT"]
["Dr. Linda Bluestein"]
[]`,
    }],
  });

  try {
    let text = response.content[0].text.trim();
    // Strip markdown code fences if present
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const guests = JSON.parse(text);
    return Array.isArray(guests) ? guests : [];
  } catch {
    console.error('  ⚠ Failed to parse Haiku guest extraction:', response.content[0].text);
    return [];
  }
}

/** Convert seconds to "Xh Xm" format. */
function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.ceil((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Format a date to YYYY-MM-DD. */
function formatDate(dateStr) {
  const d = new Date(dateStr);
  return d.toISOString().split('T')[0];
}

/** Normalize any date value (Date, ISO string, YYYY-MM-DD) to YYYY-MM-DD. */
function toYMD(value) {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString().split('T')[0];
  const s = String(value);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().split('T')[0];
}

/** Decode the basic XML entities that appear in feed titles. */
function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * Create a stub guest-profile JSON if one doesn't already exist for `displayName`.
 * Stub is intentionally minimal — name (via key) only. The podcast team can fill
 * in bio, credentials, image, links via the CMS or the guest intake form later.
 * Returns true if a file was created, false otherwise.
 */
function ensureGuestProfileStub(displayName, knownKeys) {
  const key = normalizeKey(displayName);
  if (!key) return false;
  if (knownKeys.has(key)) return false;
  const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return false;
  const filePath = join(PROFILES_DIR, `${slug}.json`);
  if (existsSync(filePath)) {
    knownKeys.add(key);
    return false;
  }
  if (!DRY_RUN) {
    writeFileSync(filePath, JSON.stringify({ key }, null, 2) + '\n');
  }
  knownKeys.add(key);
  return true;
}

/** Load all canonical guest names from guest-profiles/*.json. */
function loadGuestProfiles() {
  if (!existsSync(PROFILES_DIR)) return [];
  return readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const data = JSON.parse(readFileSync(join(PROFILES_DIR, f), 'utf-8'));
      return {
        key: data.key || f.replace('.json', ''),
        file: f,
        ...data,
      };
    });
}

/** Load existing episode numbers and bonus slugs. */
function loadExistingEpisodes() {
  const nums = new Set();
  const slugs = new Set();
  const audioUrls = new Set();
  const episodesNeedingVideo = [];

  for (const f of readdirSync(EPISODES_DIR).filter(f => f.endsWith('.md'))) {
    const raw = readFileSync(join(EPISODES_DIR, f), 'utf-8');
    const { data, content } = matter(raw);
    const slug = f.replace('.md', '');

    if (data.num != null) nums.add(data.num);
    slugs.add(slug);
    if (data.audioUrl) {
      // Normalize: strip query params for comparison (megaphone URLs differ by ?updated= param)
      const baseUrl = data.audioUrl.split('?')[0];
      audioUrls.add(baseUrl);
    }

    // Track episodes that need YouTube backfill (skip ep 0 — intro/trailer)
    if (!data.videoUrl && data.num != null && data.num > 0) {
      episodesNeedingVideo.push({
        num: data.num,
        title: data.title || '',
        date: toYMD(data.date),
        slug,
        filePath: join(EPISODES_DIR, f),
        hasTranscript: content.trim().length > 100,
      });
    }
  }

  return { nums, slugs, audioUrls, episodesNeedingVideo };
}

/** Use Haiku to match a guest name from RSS to canonical guest names. */
async function matchGuestWithHaiku(rssGuestName, canonicalNames) {
  if (!canonicalNames.length) return { matched: false, canonical: rssGuestName };

  const anthropic = new Anthropic();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `You are matching podcast guest names. Given an RSS guest name and a list of canonical guest names from our database, find the best match.

RSS guest name: "${rssGuestName}"

Canonical names (from our database):
${canonicalNames.map(n => `- "${n}"`).join('\n')}

If one of the canonical names clearly refers to the same person (accounting for nicknames like Larry/Lawrence, Bob/Robert, title differences like Dr./Prof., credential differences), respond with ONLY that canonical name, nothing else.

If no match is found, respond with exactly: NO_MATCH`,
    }],
  });

  const result = response.content[0].text.trim();
  if (result === 'NO_MATCH') {
    return { matched: false, canonical: rssGuestName };
  }
  // Verify the result is actually one of our canonical names
  if (canonicalNames.includes(result)) {
    return { matched: true, canonical: result };
  }
  return { matched: false, canonical: rssGuestName };
}

/** Fetch recent videos from the channel's playlist RSS feed.
 *  We use the feed instead of yt-dlp because YouTube bot-blocks yt-dlp on CI
 *  runners ("Sign in to confirm you're not a bot"), which silently zeroed out
 *  every date match. The feed needs no auth, returns the latest ~15 videos with
 *  id/title/publish-date in one request, and omits private videos entirely.
 *  Episodes are matched to videos by publish date — the podcast pubDate and the
 *  YouTube publish date are a clean 1:1 weekly match (verified zero offset). */
async function fetchYouTubePlaylist(n = YT_TOP_N) {
  const playlistId = (YT_PLAYLIST.match(/[?&]list=([^&]+)/) || [])[1];
  if (!playlistId) {
    console.error('  ⚠  Could not parse playlist ID from YT_PLAYLIST');
    return [];
  }
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?playlist_id=${playlistId}`;
  try {
    const res = await fetch(feedUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();

    const videos = [];
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
    let m;
    while ((m = entryRegex.exec(xml)) !== null) {
      const block = m[1];
      const id = (block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/) || [])[1];
      if (!id) continue;
      const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
      const published = (block.match(/<published>([^<]+)<\/published>/) || [])[1] || '';
      const title = decodeXmlEntities(rawTitle).trim();
      videos.push({ id, title, epNum: parseEpNumber(title), uploadDate: toYMD(published) });
    }
    return videos.slice(0, n);
  } catch (e) {
    console.error('  ⚠  Failed to fetch YouTube playlist feed:', e.message);
    return [];
  }
}

/** Build the YAML frontmatter + transcript content for an episode. */
function buildEpisodeMarkdown({ num, title, date, duration, description, audioUrl, videoUrl, guests, guestImages, tags, transcript }) {
  const firstImage = (guestImages || []).find(Boolean) || '';
  const frontmatter = {
    num: num ?? null,
    title,
    date,
    duration,
    description,
    tags: tags || [],
    audioUrl: audioUrl || '',
    videoUrl: videoUrl || '',
    snippets: [],
    guests: guests || [],
    guestImage: firstImage,
    guestImages: guestImages || [],
  };

  // Use gray-matter to stringify
  const md = matter.stringify(transcript || '', frontmatter);
  return md;
}

/** Generate a slug for bonus episodes from title. */
function slugify(title) {
  // Remove episode tag if present
  const cleaned = title.replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/i, '').trim();
  return 'bonus-' + cleaned
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(DRY_RUN ? '🏃 Dry run — no files will be written\n' : '');

  const { nums: existingNums, slugs: existingSlugs, audioUrls: existingAudioUrls, episodesNeedingVideo } = loadExistingEpisodes();
  const profiles = loadGuestProfiles();
  const canonicalNames = profiles.map(p => {
    // Build display name like "Dr. Lawrence Afrin" from key + credentials
    const key = p.key || '';
    // Capitalize each word
    const displayName = key.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    return p.credentials ? `Dr. ${displayName}` : displayName;
  });
  // Collect normalized keys for matching, so a profile stored with any
  // casing/credentials (e.g. "Bonnie Robson, M.D.") still matches the same
  // normalized key the rest of the pipeline produces.
  const profileKeys = profiles.map(p => normalizeKey(p.key));
  // Map each profile alias (e.g. "larry afrin") to its canonical key, so an
  // episode credited under an alternative name matches the existing profile
  // instead of spawning a duplicate stub.
  const aliasToCanonical = {};
  for (const p of profiles) {
    const canonical = normalizeKey(p.key);
    for (const a of (Array.isArray(p.aliases) ? p.aliases : [])) {
      const ak = normalizeKey(a);
      if (ak && ak !== canonical && !aliasToCanonical[ak]) aliasToCanonical[ak] = canonical;
    }
  }
  // Known keys = canonical profile keys + all aliases (so aliases don't create stubs).
  const knownProfileKeys = new Set([...profileKeys, ...Object.keys(aliasToCanonical)]);

  // Load guest images for looking up image paths
  let guestImagesMap = {};
  if (existsSync(GUEST_IMAGES)) {
    guestImagesMap = JSON.parse(readFileSync(GUEST_IMAGES, 'utf-8'));
  }

  // ── Pre-pass: Ensure every guest referenced by an existing episode has a
  // profile stub. Catches guests added via the CMS that bypassed sync-rss. ──
  let stubsCreated = 0;
  for (const f of readdirSync(EPISODES_DIR).filter(f => f.endsWith('.md'))) {
    const { data } = matter(readFileSync(join(EPISODES_DIR, f), 'utf-8'));
    for (const g of (data.guests || [])) {
      if (isHost(g)) continue;
      if (ensureGuestProfileStub(g, knownProfileKeys)) {
        stubsCreated++;
        console.log(`   ➕ Stub guest profile: "${g}" (from ${f})`);
      }
    }
  }
  if (stubsCreated > 0) {
    console.log(`   Created ${stubsCreated} guest profile stub(s)${DRY_RUN ? ' (dry run)' : ''}.\n`);
  }
  profileKeys.length = 0;
  profileKeys.push(...knownProfileKeys);

  // ── Pass 1: RSS → New Episodes ──────────────────────────────────────────

  let newEpisodes = [];

  if (!YT_ONLY) {
    console.log('📡 Fetching RSS feed...');
    const res = await fetch(RSS_URL);
    const xml = await res.text();
    const rssItems = parseRSS(xml);
    console.log(`   Found ${rssItems.length} items in feed\n`);

    let consecutiveSkips = 0;
    for (const item of rssItems) {
      const epNum = parseEpNumber(item.title);
      const isBonus = epNum === null;

      // Check if episode already exists (by number, slug, or audio URL)
      let exists = false;
      if (!isBonus && existingNums.has(epNum)) exists = true;
      if (!exists && isBonus) {
        const slug = slugify(item.title);
        if (existingSlugs.has(slug)) exists = true;
      }
      if (!exists && item.audioUrl) {
        const baseUrl = item.audioUrl.split('?')[0];
        if (existingAudioUrls.has(baseUrl)) exists = true;
      }
      if (exists) {
        consecutiveSkips++;
        // RSS is newest-first — if we've skipped 10 in a row, the rest are old
        if (consecutiveSkips >= 10) {
          console.log(`   Skipped ${consecutiveSkips} existing episodes, stopping early.\n`);
          break;
        }
        continue;
      }
      consecutiveSkips = 0;

      const cleanTitle = item.title
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      console.log(`✨ New episode: ${cleanTitle}`);

      // Clean up description — strip HTML tags and boilerplate
      let cleanDesc = item.description
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      // Trim RSS boilerplate: cut at takeaways, transcript link, or social blocks
      const boilerplateCut = cleanDesc.search(
        /\n\s*(Takeaways?:?\s*\n|Find the episode transcript|Want more Dr\. Linda Bluestein)/i
      );
      if (boilerplateCut > 0) {
        cleanDesc = cleanDesc.slice(0, boilerplateCut).trim();
      }

      // Extract guest names using Haiku (handles multi-guest, host/cohost filtering)
      console.log(`   🤖 Extracting guests with Haiku...`);
      let rssGuests;
      try {
        rssGuests = await extractGuestsWithHaiku(item.title, cleanDesc);
      } catch (e) {
        console.error(`   ✗ Haiku extraction error: ${e.message}`);
        rssGuests = [];
      }

      // If the only "guest" is Linda (solo/Office Hours), keep her.
      // If there are other guests, remove Linda — she's the host.
      // Cohost filtering is handled by the Haiku prompt.
      const hasNonHostGuests = rssGuests.some(g => !isHost(g));
      if (hasNonHostGuests) {
        rssGuests = rssGuests.filter(g => !isHost(g));
      }

      const matchedGuests = [];
      const matchedImages = [];

      for (const rssGuest of rssGuests) {
        // First try direct key match (resolving aliases to the canonical key).
        const normalized = normalizeKey(rssGuest);
        const canonical = aliasToCanonical[normalized] || normalized;
        const directMatch = profileKeys.find(k => k === canonical);

        if (directMatch) {
          // Image is keyed by the canonical guest, not the alias.
          const img = guestImagesMap[directMatch] || guestImagesMap[normalized] || '';
          matchedGuests.push(rssGuest);
          matchedImages.push(img);
          console.log(`   ✓ Guest matched directly: "${rssGuest}" → "${directMatch}"`);
        } else {
          // Use Haiku for fuzzy matching to canonical name
          console.log(`   🤖 Matching: "${rssGuest}"`);
          try {
            const result = await matchGuestWithHaiku(rssGuest, canonicalNames);
            if (result.matched) {
              matchedGuests.push(result.canonical);
              const matchedKey = normalizeKey(result.canonical);
              const img = guestImagesMap[matchedKey] || '';
              matchedImages.push(img);
              console.log(`   ✓ Matched: "${rssGuest}" → "${result.canonical}"`);
              // This was a fuzzy (AI) match, not a direct/alias one. Suggest
              // promoting recurring variants to a deterministic alias so the
              // matcher doesn't have to guess next time.
              if (normalizeKey(rssGuest) !== matchedKey) {
                console.log(`     ↳ Tip: add "${rssGuest}" as an alias on the "${matchedKey}" guest profile to make this match permanent.`);
              }
            } else {
              matchedGuests.push(rssGuest);
              matchedImages.push('');
              if (ensureGuestProfileStub(rssGuest, knownProfileKeys)) {
                console.log(`   ➕ Stub profile created for new guest: "${rssGuest}"`);
              } else {
                console.log(`   ⚠ No match found, using RSS name: "${rssGuest}"`);
              }
            }
          } catch (e) {
            console.error(`   ✗ Haiku error: ${e.message}`);
            matchedGuests.push(rssGuest);
            matchedImages.push('');
          }
        }
      }

      const episode = {
        num: epNum,
        title: cleanTitle,
        date: formatDate(item.pubDate),
        duration: formatDuration(item.duration),
        description: cleanDesc,
        audioUrl: item.audioUrl,
        videoUrl: '',
        guests: matchedGuests,
        guestImages: matchedImages.filter(Boolean),
        tags: [],
        transcript: '',
      };

      newEpisodes.push(episode);
    }

    if (newEpisodes.length === 0) {
      console.log('No new episodes found in RSS feed.\n');
    }
  }

  // ── Pass 2: YouTube Backfill ────────────────────────────────────────────

  let videosMatched = 0;
  if (!RSS_ONLY) {
    // Combine new episodes (no video yet) with existing episodes needing video
    const needsVideo = [
      ...newEpisodes.filter(e => !e.videoUrl && e.num !== null),
      ...episodesNeedingVideo,
    ];

    if (needsVideo.length > 0) {
      console.log(`🎬 Checking YouTube playlist (top ${YT_TOP_N}) for ${needsVideo.length} episodes needing video...`);
      const ytVideos = await fetchYouTubePlaylist(YT_TOP_N);

      if (ytVideos.length > 0) {
        console.log(`   Found ${ytVideos.length} videos in playlist\n`);

        for (const ep of needsVideo) {
          const epDate = toYMD(ep.date);

          // Date-primary match: the podcast pubDate and the YouTube publish date
          // are 1:1 in practice. Episode number is only a fallback for older
          // numbered uploads — many recent video titles have no number.
          let ytMatch = epDate
            ? ytVideos.find(v => v.uploadDate && v.uploadDate === epDate)
            : null;
          let matchedBy = 'date';
          if (!ytMatch && ep.num != null) {
            ytMatch = ytVideos.find(v => v.epNum === ep.num);
            matchedBy = 'number';
          }
          if (!ytMatch) continue;

          const videoUrl = `https://youtu.be/${ytMatch.id}`;
          console.log(`   🔗 YouTube match (by ${matchedBy}): Ep ${ep.num} → ${videoUrl}`);
          videosMatched++;

          // Is this a new episode from Pass 1?
          const newEp = newEpisodes.find(e => e.num === ep.num);
          if (newEp) {
            newEp.videoUrl = videoUrl;
          } else {
            // Existing episode — update its file
            if (!DRY_RUN) {
              const raw = readFileSync(ep.filePath, 'utf-8');
              const { data, content } = matter(raw);
              data.videoUrl = videoUrl;

              writeFileSync(ep.filePath, matter.stringify(content, data));
              console.log(`   ✓ Updated ${ep.slug}.md with videoUrl`);
            } else {
              console.log(`   (dry run) Would update ${ep.slug}.md with videoUrl`);
            }
          }
        }
      } else {
        console.log('   No videos found in playlist.\n');
      }
    }
  }

  // ── Write new episode files ─────────────────────────────────────────────

  if (newEpisodes.length > 0) {
    console.log(`\n📝 Writing ${newEpisodes.length} new episode(s)...\n`);

    for (const ep of newEpisodes) {
      const slug = ep.num !== null ? `${ep.num}` : slugify(ep.title);
      const filePath = join(EPISODES_DIR, `${slug}.md`);
      const md = buildEpisodeMarkdown(ep);

      if (!DRY_RUN) {
        writeFileSync(filePath, md);
        console.log(`   ✓ Wrote ${slug}.md`);
      } else {
        console.log(`   (dry run) Would write ${slug}.md`);
        console.log(`     Title: ${ep.title}`);
        console.log(`     Date: ${ep.date}`);
        console.log(`     Duration: ${ep.duration}`);
        console.log(`     Guests: ${ep.guests.join(', ') || '(none)'}`);
        console.log(`     Video: ${ep.videoUrl || '(none yet)'}`);
        console.log(`     Transcript: ${ep.transcript ? `${ep.transcript.split('\n').length} lines` : '(none yet)'}`);
        console.log('');
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────

  console.log('\n── Summary ─────────────────────────────────────');
  console.log(`New episodes from RSS: ${newEpisodes.length}`);
  console.log(`Episodes with video matched: ${videosMatched}`);
  if (DRY_RUN) console.log('\n(Dry run — nothing was written)');
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
