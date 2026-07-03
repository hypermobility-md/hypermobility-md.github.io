// Shared guest-key normalization — single source of truth in scripts/lib.
const { normalizeKey: normalizeGuestKey } = require("./scripts/lib/guest-keys.cjs");
const { buildGuestIndex } = require("./scripts/lib/guest-index.cjs");

const CleanCSS = require("clean-css");
const fs = require("fs");
const path = require("path");

module.exports = function(eleventyConfig) {
  // Pass through static assets
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/Guests");
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy("src/Populate");
  eleventyConfig.addPassthroughCopy("src/.nojekyll");
  eleventyConfig.addPassthroughCopy("src/js");
  eleventyConfig.addPassthroughCopy("src/favicon.ico");
  eleventyConfig.addPassthroughCopy("src/site.webmanifest");
  eleventyConfig.addPassthroughCopy("src/CNAME");

  // Inline a (minified) stylesheet from src/css/ into <head> (see base.njk) so the
  // CSS is no longer a render-blocking request on the critical path. GitHub Pages
  // caps Cache-Control at ~10min, so external caching buys little; inlining the
  // exact same bytes improves first paint / LCP with no FOUC and no visual change.
  // Results are cached per filename so each stylesheet is read+minified once.
  const _inlineCssCache = {};
  eleventyConfig.addFilter("inlineCssFile", (filename) => {
    if (!filename) return "";
    if (_inlineCssCache[filename] === undefined) {
      const src = fs.readFileSync(path.join(__dirname, "src", "css", filename), "utf8");
      const out = new CleanCSS({ level: 2 }).minify(src);
      _inlineCssCache[filename] = out.styles || src;
    }
    return _inlineCssCache[filename];
  });

  // Post-build: minify CSS and generate transcript files
  eleventyConfig.on("eleventy.after", () => {
    // --- Minify CSS ---
    const cssDir = path.join(__dirname, "_site", "css");
    if (fs.existsSync(cssDir)) {
      const cssFiles = fs.readdirSync(cssDir).filter(f => f.endsWith(".css"));
      const minifier = new CleanCSS({ level: 2 });
      for (const file of cssFiles) {
        const filePath = path.join(cssDir, file);
        const source = fs.readFileSync(filePath, "utf8");
        const output = minifier.minify(source);
        if (output.styles) {
          fs.writeFileSync(filePath, output.styles);
        }
      }
    }

    // --- Generate transcript + description files for lazy loading ---
    const md = require("markdown-it")();
    const matter = require("gray-matter");
    const transcriptsDir = path.join(__dirname, "_site", "transcripts");
    const descriptionsDir = path.join(__dirname, "_site", "descriptions");
    if (!fs.existsSync(transcriptsDir)) fs.mkdirSync(transcriptsDir, { recursive: true });
    if (!fs.existsSync(descriptionsDir)) fs.mkdirSync(descriptionsDir, { recursive: true });

    const episodeFiles = fs.readdirSync(path.join(__dirname, "src", "episodes"))
      .filter(f => f.endsWith(".md"));

    const searchIndex = {};

    for (const file of episodeFiles) {
      const raw = fs.readFileSync(path.join(__dirname, "src", "episodes", file), "utf8");
      const { data: frontmatter, content: body } = matter(raw);

      // Determine episode identifier (num or slug)
      const slug = file.replace(/\.md$/, '');
      const id = frontmatter.num ? String(frontmatter.num) : slug;

      // Generate full description file
      if (frontmatter.description) {
        fs.writeFileSync(
          path.join(descriptionsDir, id + ".json"),
          JSON.stringify({ description: frontmatter.description })
        );
      }

      // Generate transcript file
      const trimmedBody = (body || '').trim();
      if (trimmedBody && trimmedBody.length >= 10) {
        const html = md.render(trimmedBody);
        fs.writeFileSync(
          path.join(transcriptsDir, id + ".json"),
          JSON.stringify({ transcript: html })
        );

        // Plain text for search index (strip HTML)
        const plain = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        searchIndex[id] = { transcript: plain };
      } else {
        searchIndex[id] = {};
      }

      // Add description to search index
      if (frontmatter.description) {
        searchIndex[id].description = frontmatter.description;
      }
    }

    fs.writeFileSync(
      path.join(transcriptsDir, "search-index.json"),
      JSON.stringify(searchIndex)
    );
  });

  // Generate data.js from episode markdown files at build time
  eleventyConfig.addCollection("episodes", function(collectionApi) {
    return collectionApi.getFilteredByGlob("src/episodes/*.md")
      .sort((a, b) => (b.data.num || 0) - (a.data.num || 0));
  });

  // Guest appearances collection — sorted by date descending
  eleventyConfig.addCollection("appearances", function(collectionApi) {
    const toMs = (d) => {
      if (!d) return null;
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? null : t;
    };
    return collectionApi.getFilteredByGlob("src/appearances/*.md")
      .sort((a, b) => {
        const ta = toMs(a.data.date);
        const tb = toMs(b.data.date);
        if (ta !== null && tb !== null) return tb - ta;
        if (ta !== null) return -1;
        if (tb !== null) return 1;
        return 0;
      });
  });

  // Featured guest appearances — ordered by `featuredOrder` (ascending),
  // then by the date-descending order inherited from the appearances
  // collection. Drives the "Featured" row on /podcast-appearances/.
  eleventyConfig.addCollection("featuredAppearances", function(collectionApi) {
    const toMs = (d) => {
      if (!d) return null;
      const t = new Date(d).getTime();
      return Number.isNaN(t) ? null : t;
    };
    return collectionApi.getFilteredByGlob("src/appearances/*.md")
      .filter((a) => a.data.featured)
      .sort((a, b) => {
        const oa = Number.isFinite(a.data.featuredOrder) ? a.data.featuredOrder : Infinity;
        const ob = Number.isFinite(b.data.featuredOrder) ? b.data.featuredOrder : Infinity;
        if (oa !== ob) return oa - ob;
        const ta = toMs(a.data.date);
        const tb = toMs(b.data.date);
        if (ta !== null && tb !== null) return tb - ta;
        if (ta !== null) return -1;
        if (tb !== null) return 1;
        return 0;
      });
  });

  // FAQ items grouped by category, each group sorted by `order`.
  // Categories are defined in src/_data/faqCategories.js; items live in
  // src/faq-items/*.md with frontmatter { question, category, order }.
  eleventyConfig.addCollection("faqByCategory", function(collectionApi) {
    const items = collectionApi.getFilteredByGlob("src/faq-items/*.md");
    const grouped = {};
    items.forEach(item => {
      const cat = item.data.category || "general";
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(item);
    });
    Object.keys(grouped).forEach(cat => {
      grouped[cat].sort((a, b) => (a.data.order || 999) - (b.data.order || 999));
    });
    return grouped;
  });

  // Guest display-name map: normalized key → best display name from episode data
  eleventyConfig.addCollection("guestDisplayNames", function(collectionApi) {
    const episodes = collectionApi.getFilteredByGlob("src/episodes/*.md");
    const map = {};
    episodes.forEach(ep => {
      if (!ep.data.guests) return;
      ep.data.guests.forEach(g => {
        const key = normalizeGuestKey(g);
        if (!key || key.length < 3) return;
        if (!map[key]) {
          map[key] = g;
        } else {
          const current = map[key];
          if (/^Dr\.?\s/i.test(g) && !/^Dr\.?\s/i.test(current)) map[key] = g;
          else if (g.length > current.length && !/^Dr\.?\s/i.test(current)) map[key] = g;
        }
      });
    });
    return map;
  });

  // Guest → most recent episode date (normalized key → 'YYYY-MM-DD').
  // Exposed to the CMS via /cms-data/guest-last-episode.json so saving a guest
  // profile can stamp `lastEpisode` immediately, instead of waiting for the
  // 6-hourly sync backfill (which remains the catch-all for existing guests
  // when new episodes publish).
  eleventyConfig.addCollection("guestLastEpisode", function(collectionApi) {
    const map = {};
    collectionApi.getFilteredByGlob("src/episodes/*.md").forEach(ep => {
      const date = ep.data.date;
      if (!date || !Array.isArray(ep.data.guests)) return;
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) return;
      const iso = d.toISOString().slice(0, 10);
      ep.data.guests.forEach(g => {
        const key = normalizeGuestKey(g);
        if (!key) return;
        if (!map[key] || iso > map[key]) map[key] = iso;
      });
    });
    return map;
  });

  // ---- Filters ----

  // Date formatting filter
  // Build-unique cache buster (changes every build, unlike isoDate which is daily)
  const buildHash = Date.now().toString(36);
  eleventyConfig.addFilter("cacheBust", () => buildHash);

  eleventyConfig.addFilter("isoDate", (date) => {
    if (!date) return '';
    if (date === 'now') return new Date().toISOString().split('T')[0];
    if (typeof date === 'string') return date;
    return date.toISOString().split('T')[0];
  });

  // Full ISO 8601 datetime *with timezone* — required by schema.org
  // VideoObject.uploadDate. Google flags date-only values as "missing a
  // timezone". Noon UTC keeps the calendar date identical in every real-world
  // time zone (UTC-12…UTC+14), so the displayed date never shifts.
  eleventyConfig.addFilter("isoDateTime", (date) => {
    if (!date) return '';
    let dateStr;
    if (date === 'now') dateStr = new Date().toISOString().split('T')[0];
    else if (typeof date === 'string') dateStr = date.split('T')[0];
    else dateStr = date.toISOString().split('T')[0];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
    return `${dateStr}T12:00:00Z`;
  });

  // True when `url` starts with any prefix in `prefixes`. Used by sitemap.njk
  // to keep robots-disallowed paths (site.disallowPaths) out of the sitemap,
  // so the two never drift apart.
  eleventyConfig.addFilter("startsWithAny", (url, prefixes) => {
    if (!url || !Array.isArray(prefixes)) return false;
    return prefixes.some((p) => url.startsWith(p));
  });

  // Human-readable date
  eleventyConfig.addFilter("formatDate", (date) => {
    if (!date) return '';
    let str;
    if (typeof date === 'string') str = date;
    else if (date instanceof Date) str = date.toISOString().split('T')[0];
    else return '';
    const [y, m, d] = str.split('-').map(Number);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${months[m - 1]} ${d}, ${y}`;
  });

  // Truncate text at a sentence boundary near maxChars
  eleventyConfig.addFilter("truncateSentence", (text, maxChars, minChars = 0) => {
    if (!text) return text;
    // Start with the first paragraph, but if it's shorter than minChars keep
    // pulling in following paragraphs so a short opening line isn't clipped at
    // the first blank line. Then cap the result at maxChars on a sentence break.
    const paras = text.split('\n\n');
    let chunk = paras[0] || '';
    for (let p = 1; p < paras.length && chunk.length < minChars; p++) {
      chunk += ' ' + paras[p];
    }
    if (chunk.length <= maxChars) return chunk;
    // Look for sentence end (.!?) between 50% and 150% of maxChars
    const abbrevs = /(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Vol|Ep|Inc|Ltd|M\.?D|Ph\.?D|D\.?P\.?T|P\.?A|R\.?D\.?N|O\.?T|P\.?T|J\.?D)\s*$/i;
    let lastGoodEnd = -1;
    for (let i = Math.floor(maxChars * 0.5); i < Math.min(chunk.length, Math.floor(maxChars * 1.5)); i++) {
      const ch = chunk[i];
      if ((ch === '.' || ch === '!' || ch === '?') && (i + 1 >= chunk.length || chunk[i + 1] === ' ' || chunk[i + 1] === '\n')) {
        const before = chunk.substring(Math.max(0, i - 15), i + 1);
        if (!abbrevs.test(before)) {
          lastGoodEnd = i + 1;
          if (i >= maxChars * 0.8) break;
        }
      }
    }
    if (lastGoodEnd > 0) return chunk.substring(0, lastGoodEnd).trim();
    return chunk.substring(0, maxChars).trim();
  });

  // JSON stringify filter
  eleventyConfig.addFilter("jsonify", (obj) => JSON.stringify(obj));

  // Sort a tag array by global frequency. Default ascending (least → most
  // common) so per-episode displays lead with distinctive tags; pass "desc"
  // for pickers. `counts` is the tagStats.counts map.
  eleventyConfig.addFilter("sortTagsByFreq", (tags, counts, dir) => {
    if (!Array.isArray(tags)) return tags;
    const c = counts || {};
    const sign = dir === "desc" ? -1 : 1;
    return [...tags].sort(
      (a, b) => sign * ((c[a] || 0) - (c[b] || 0)) || a.localeCompare(b)
    );
  });

  // Markdown-it for transcript rendering
  eleventyConfig.addFilter("markdownify", (str) => {
    if (!str) return '';
    const md = require("markdown-it")();
    return md.render(str);
  });

  // Clean episode title — strip "(Ep 124)" suffix and leading number
  eleventyConfig.addFilter("cleanTitle", (title) => {
    if (!title) return '';
    return title.replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/, '').replace(/^\d+\.\s+/, '').trim();
  });

  // Normalize guest name to lookup key
  eleventyConfig.addFilter("guestKey", (name) => normalizeGuestKey(name));

  // Filter episodes to those featuring a specific guest
  eleventyConfig.addFilter("episodesForGuest", (episodes, guestKey) => {
    return episodes.filter(ep =>
      ep.data.guests && ep.data.guests.some(g => normalizeGuestKey(g) === guestKey)
    );
  });

  // Get prev/next episodes relative to a given episode
  // Uses inputPath for unique matching (handles bonus episodes with null num)
  eleventyConfig.addFilter("adjacentEpisodes", (episodes, inputPath) => {
    let prev = null, next = null;
    for (let i = 0; i < episodes.length; i++) {
      if (episodes[i].inputPath === inputPath) {
        if (i > 0) next = episodes[i - 1];           // higher num (collection sorted desc)
        if (i < episodes.length - 1) prev = episodes[i + 1]; // lower num
        break;
      }
    }
    return { prev, next };
  });

  // Sort guest social links: Wikipedia, Website/Site, Site2, LinkedIn, Instagram, Twitter/X, Facebook, YouTube, TikTok, other
  eleventyConfig.addFilter("sortSocialLinks", (links) => {
    if (!links || !links.length) return [];
    const order = [
      'wikipedia.org', '__website__', '__site2__', 'linkedin.com', 'instagram.com',
      'twitter.com', 'x.com', 'facebook.com', 'youtube.com', 'youtu.be', 'tiktok.com'
    ];
    function linkPriority(link) {
      const u = (link.url || '').toLowerCase();
      const label = (link.label || '').toLowerCase();
      if (u.includes('wikipedia.org')) return 0;
      // Website / Site (non-social URLs)
      const isSocial = ['linkedin', 'twitter', 'x.com', 'instagram', 'facebook', 'youtube', 'youtu.be', 'tiktok', 'wikipedia'].some(d => u.includes(d));
      if (!isSocial && !u.includes('substack') && (label === 'website' || label === 'site')) return 1;
      if (!isSocial && !u.includes('substack') && label === 'site 2') return 2;
      if (u.includes('substack.com')) return 2.5;
      if (u.includes('linkedin.com')) return 3;
      if (u.includes('instagram.com')) return 4;
      if (u.includes('twitter.com') || u.includes('x.com')) return 5;
      if (u.includes('facebook.com')) return 6;
      if (u.includes('youtube.com') || u.includes('youtu.be')) return 7;
      if (u.includes('tiktok.com')) return 8;
      return 9;
    }
    return links.slice().sort((a, b) => linkPriority(a) - linkPriority(b));
  });

  // ---- SEO Filters ----

  // Convert "1h 12m" → "PT1H12M" for JSON-LD
  eleventyConfig.addFilter("isoDuration", (dur) => {
    if (!dur) return '';
    const h = dur.match(/(\d+)\s*h/i);
    const m = dur.match(/(\d+)\s*m/i);
    return 'PT' + (h ? h[1] + 'H' : '') + (m ? m[1] + 'M' : '');
  });

  // Extract YouTube video ID from URL
  eleventyConfig.addFilter("youtubeId", (url) => {
    if (!url) return '';
    const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]+)/);
    return m ? m[1] : '';
  });

  // Resolve relative path to absolute URL
  eleventyConfig.addFilter("absoluteUrl", (path, siteUrl) => {
    if (!path) return '';
    if (path.startsWith('http')) return path;
    return (siteUrl || '') + (path.startsWith('/') ? path : '/' + path);
  });

  // Convert guest photo path to OG image path
  // /Guests/Forest_Tennant.jpg → /assets/og-guests/Forest_Tennant.jpg
  eleventyConfig.addFilter("guestOgImage", (imagePath) => {
    if (!imagePath) return '';
    const filename = imagePath.split('/').pop();
    const base = filename.replace(/\.[^.]+$/, '');
    return '/assets/og-guests/' + base + '.jpg';
  });

  // Strip HTML tags for plain-text output (e.g. JSON-LD transcript)
  eleventyConfig.addFilter("stripHtml", (html) => {
    if (!html) return '';
    return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  });

  // Find a collection item by its URL
  eleventyConfig.addFilter("findByUrl", (collection, url) => {
    if (!collection || !url) return null;
    return collection.find(item => item.url === url) || null;
  });

  // Escape string for safe JSON-LD embedding
  eleventyConfig.addFilter("jsonEscape", (str) => {
    if (!str) return '';
    return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '');
  });

  // Build the Guest Index grid server-side (see scripts/lib/guest-index.cjs and
  // src/podcast-guests.njk). Returns { gridHtml, letters }.
  eleventyConfig.addFilter("guestIndex", (episodes, guestData) => {
    const eps = (episodes || []).map(ep => ({
      num: ep.data.num,
      url: ep.url,
      title: ep.data.title,
      guests: ep.data.guests,
    }));
    return buildGuestIndex(eps, guestData);
  });

  // YouTube URL → embed URL
  eleventyConfig.addFilter("youtubeEmbed", (url) => {
    if (!url) return '';
    // Use www.youtube-nocookie.com so no third-party tracking cookies are set
    // until the user actually plays the video (privacy + Lighthouse best-practices).
    // Extract the ID and rebuild rather than string-replacing, so www/non-www and
    // youtu.be/shorts inputs all normalize to the same canonical embed URL.
    const m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]+)/);
    return m ? `https://www.youtube-nocookie.com/embed/${m[1]}` : url;
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    templateFormats: ["njk", "md", "html", "11ty.js"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk"
  };
};
