#!/usr/bin/env node

/**
 * Sync podcast episodes from the Megaphone RSS feed.
 *
 * Pass 1 — New episodes:  fetch RSS → parse → match guest via Haiku → write skeleton .md
 * Pass 2 — YouTube backfill: episodes missing videoUrl → search top of YT playlist → add URL + auto-captions
 *
 * Usage:
 *   node scripts/sync-rss.mjs                  # Full sync (RSS + YouTube backfill)
 *   node scripts/sync-rss.mjs --dry-run        # Preview without writing files
 *   node scripts/sync-rss.mjs --rss-only       # Skip YouTube backfill
 *   node scripts/sync-rss.mjs --yt-only        # Skip RSS, only backfill YouTube
 *   node scripts/sync-rss.mjs --no-captions    # Skip pulling YouTube auto-captions
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import matter from 'gray-matter';
import Anthropic from '@anthropic-ai/sdk';

// ── Paths ────────────────────────────────────────────────────────────────────
const ROOT = join(import.meta.dirname, '..');
const EPISODES_DIR = join(ROOT, 'src', 'episodes');
const PROFILES_DIR = join(ROOT, 'src', 'guest-profiles');
const GUEST_IMAGES = join(ROOT, 'src', '_data', 'guestImages.json');

// ── Config ───────────────────────────────────────────────────────────────────
const RSS_URL = 'https://feeds.megaphone.fm/bendybodies';
const YT_PLAYLIST = 'https://www.youtube.com/playlist?list=PLX9StmpQKW33Iak1WJjAnOXPIxq0M_w_L';
const YT_TOP_N = 5; // only check the top N playlist entries for backfill

// ── CLI flags ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RSS_ONLY = args.includes('--rss-only');
const YT_ONLY = args.includes('--yt-only');
const NO_CAPTIONS = args.includes('--no-captions');

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

/** Extract guest name(s) from title like "Topic with Dr. Name & Dr. Name2 (Ep N)". */
function parseGuestFromTitle(title) {
  // Remove episode tags: "(Ep 188)" or leading "95. "
  let cleaned = title.replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/i, '').trim();
  cleaned = cleaned.replace(/^\d+\.\s+/, '');

  // Match "with Guest" or "from Guest" patterns
  const m = cleaned.match(/\b(?:with|from)\s+(.+)$/i);
  if (!m) return [];

  let guestStr = m[1];

  // Handle "Guest Cohost" or "Guest Co-Host" prefix — strip the label but keep the name
  guestStr = guestStr.replace(/\bGuest\s+Co-?[Hh]ost,?\s*/g, '');

  // Split on ", and " or " and " or " & " — but only between guest names
  // First split on " and " / " & " that separate distinct people
  const guests = guestStr.split(/,?\s+(?:&(?:amp;)?|and)\s+/i)
    .map(n => n.trim())
    .filter(Boolean)
    // Filter out descriptive suffixes that aren't guest names
    .filter(n => !n.match(/^(Hand Coach|Guest|Cohost|Co-Host)$/i));

  return guests;
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

/** Normalize a guest name for matching (strip titles, credentials, lowercase). */
function normalizeGuest(name) {
  return name
    .replace(/^(Dr\.|Prof\.|Professor)\s+/i, '')
    .replace(/,?\s*(MD|DO|PhD|DPT|PT|OT|RN|NP|PA-C|DC|ND|LAc|FACP|FACR|FAAPMR)\b/gi, '')
    .trim()
    .toLowerCase();
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

/** Fetch top N videos from YouTube playlist using yt-dlp. */
function fetchYouTubePlaylist(n = YT_TOP_N) {
  try {
    const output = execSync(
      `yt-dlp --flat-playlist --playlist-items 1:${n} --print "%(id)s\t%(title)s" "${YT_PLAYLIST}"`,
      { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    return output.split('\n').filter(Boolean).map(line => {
      const [id, ...titleParts] = line.split('\t');
      const title = titleParts.join('\t');
      const epNum = parseEpNumber(title);
      return { id, title, epNum };
    });
  } catch (e) {
    console.error('  ⚠  Failed to fetch YouTube playlist:', e.message);
    return [];
  }
}

/** Pull YouTube auto-captions for a video ID using yt-dlp. Returns transcript text or null. */
function fetchYouTubeCaptions(videoId) {
  if (NO_CAPTIONS) return null;
  try {
    // Download auto-generated English subtitles
    const tmpDir = join(ROOT, 'scripts', 'output', 'yt-captions');
    execSync(`mkdir -p "${tmpDir}"`, { stdio: 'pipe' });

    execSync(
      `yt-dlp --write-auto-sub --sub-lang "en-US,en" --skip-download --convert-subs vtt -o "${tmpDir}/${videoId}" "https://www.youtube.com/watch?v=${videoId}"`,
      { encoding: 'utf-8', timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] }
    );

    // Read the VTT file — language code may be "en-US" or "en"
    let vttPath = join(tmpDir, `${videoId}.en-US.vtt`);
    if (!existsSync(vttPath)) vttPath = join(tmpDir, `${videoId}.en.vtt`);
    if (!existsSync(vttPath)) return null;

    const vtt = readFileSync(vttPath, 'utf-8');
    const transcript = vttToPlainText(vtt);

    // Clean up
    execSync(`rm -f "${tmpDir}/${videoId}".*.vtt`, { stdio: 'pipe' });

    return transcript || null;
  } catch (e) {
    console.error(`  ⚠  Failed to fetch captions for ${videoId}:`, e.message);
    return null;
  }
}

/** Convert VTT subtitle content to readable plain text. */
function vttToPlainText(vtt) {
  const lines = vtt.split('\n');
  const textLines = [];
  let prevLine = '';

  for (const line of lines) {
    // Skip headers, timestamps, and empty lines
    if (line.startsWith('WEBVTT') || line.startsWith('Kind:') || line.startsWith('Language:')) continue;
    if (/^\d{2}:\d{2}/.test(line)) continue; // timestamp lines
    if (/^\s*$/.test(line)) continue;
    if (/^\d+$/.test(line.trim())) continue; // cue numbers

    // Strip VTT tags like <c> </c> and duplicate lines
    const clean = line.replace(/<[^>]+>/g, '').trim();
    if (clean && clean !== prevLine) {
      textLines.push(clean);
      prevLine = clean;
    }
  }

  return textLines.join('\n');
}

/** Build the YAML frontmatter + transcript content for an episode. */
function buildEpisodeMarkdown({ num, title, date, duration, description, audioUrl, videoUrl, guests, guestImages, tags, transcript }) {
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
  // Also collect raw keys for matching
  const profileKeys = profiles.map(p => p.key);

  // Load guest images for looking up image paths
  let guestImagesMap = {};
  if (existsSync(GUEST_IMAGES)) {
    guestImagesMap = JSON.parse(readFileSync(GUEST_IMAGES, 'utf-8'));
  }

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

      console.log(`✨ New episode: ${item.title}`);

      // Parse and match guest names
      const rssGuests = parseGuestFromTitle(item.title);
      const matchedGuests = [];
      const matchedImages = [];

      for (const rssGuest of rssGuests) {
        // First try direct key match
        const normalized = normalizeGuest(rssGuest);
        const directMatch = profileKeys.find(k => k === normalized);

        if (directMatch) {
          // Use the guest name format from existing episodes
          const img = guestImagesMap[directMatch] || '';
          matchedGuests.push(rssGuest);
          matchedImages.push(img);
          console.log(`   ✓ Guest matched directly: "${rssGuest}" → "${directMatch}"`);
        } else {
          // Use Haiku for fuzzy matching
          console.log(`   🤖 Asking Haiku to match: "${rssGuest}"`);
          try {
            const result = await matchGuestWithHaiku(rssGuest, canonicalNames);
            if (result.matched) {
              matchedGuests.push(result.canonical);
              const matchedKey = normalizeGuest(result.canonical);
              const img = guestImagesMap[matchedKey] || '';
              matchedImages.push(img);
              console.log(`   ✓ Haiku matched: "${rssGuest}" → "${result.canonical}"`);
            } else {
              matchedGuests.push(rssGuest);
              matchedImages.push('');
              console.log(`   ⚠ No match found, using RSS name: "${rssGuest}"`);
            }
          } catch (e) {
            console.error(`   ✗ Haiku error: ${e.message}`);
            matchedGuests.push(rssGuest);
            matchedImages.push('');
          }
        }
      }

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

      const episode = {
        num: epNum,
        title: item.title,
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

  if (!RSS_ONLY) {
    // Combine new episodes (no video yet) with existing episodes needing video
    const needsVideo = [
      ...newEpisodes.filter(e => !e.videoUrl && e.num !== null),
      ...episodesNeedingVideo,
    ];

    if (needsVideo.length > 0) {
      console.log(`🎬 Checking YouTube playlist (top ${YT_TOP_N}) for ${needsVideo.length} episodes needing video...`);
      const ytVideos = fetchYouTubePlaylist(YT_TOP_N);

      if (ytVideos.length > 0) {
        console.log(`   Found ${ytVideos.length} videos in playlist\n`);

        for (const ep of needsVideo) {
          const ytMatch = ytVideos.find(v => v.epNum === ep.num);
          if (!ytMatch) continue;

          // Skip private videos
          if (ytMatch.title === '[Private video]') continue;

          const videoUrl = `https://youtu.be/${ytMatch.id}`;
          console.log(`   🔗 YouTube match: Ep ${ep.num} → ${videoUrl}`);

          // Is this a new episode from Pass 1?
          const newEp = newEpisodes.find(e => e.num === ep.num);
          if (newEp) {
            newEp.videoUrl = videoUrl;

            // Pull auto-captions if no transcript yet
            if (!newEp.transcript) {
              console.log(`   📝 Pulling auto-captions for Ep ${ep.num}...`);
              const captions = fetchYouTubeCaptions(ytMatch.id);
              if (captions) {
                newEp.transcript = captions;
                console.log(`   ✓ Got ${captions.split('\n').length} lines of captions`);
              }
            }
          } else {
            // Existing episode — update its file
            if (!DRY_RUN) {
              const raw = readFileSync(ep.filePath, 'utf-8');
              const { data, content } = matter(raw);
              data.videoUrl = videoUrl;

              let updatedContent = content;
              // Pull captions if episode has no transcript
              if (!ep.hasTranscript) {
                console.log(`   📝 Pulling auto-captions for Ep ${ep.num}...`);
                const captions = fetchYouTubeCaptions(ytMatch.id);
                if (captions) {
                  updatedContent = captions;
                  console.log(`   ✓ Got ${captions.split('\n').length} lines of captions`);
                }
              }

              writeFileSync(ep.filePath, matter.stringify(updatedContent, data));
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
  console.log(`Episodes with video matched: ${newEpisodes.filter(e => e.videoUrl).length}`);
  console.log(`Episodes with captions: ${newEpisodes.filter(e => e.transcript).length}`);
  if (DRY_RUN) console.log('\n(Dry run — nothing was written)');
  console.log('');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
