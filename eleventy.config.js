// Shared guest-key normalization (mirrors client-side logic)
function normalizeGuestKey(name) {
  if (!name) return '';
  let n = name.replace(/^(Dr\.?|Prof\.?|Professor)\s+/i, '');
  let prev;
  do {
    prev = n;
    n = n.replace(/[,\s]+(M\.?D\.?|Ph\.?D\.?|D\.?P\.?T\.?|D\.?O\.?|P\.?A\.?-?C?|R\.?D\.?N\.?|O\.?T\.?|P\.?T\.?|J\.?D\.?|LICSW|NCPT|ATC|MS|MA|MPT|DMSC|MRCPsych|DDS|D\.?C\.?|FACP|FACS|FAANS|FAAFP|FAAN|FAMSSM|FACOG|FRCPC|IFMCP|ABIHM|CCSP|CEDS-S|FAED|CHT|CYT|CHC|CMTPT|COMT|NCS|OCS|CES|MHCM)\.?\s*$/i, '');
  } while (n !== prev);
  return n.replace(/[,.\s]+$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

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

  // Generate data.js from episode markdown files at build time
  eleventyConfig.addCollection("episodes", function(collectionApi) {
    return collectionApi.getFilteredByGlob("src/episodes/*.md")
      .sort((a, b) => (b.data.num || 0) - (a.data.num || 0));
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

  // JSON stringify filter
  eleventyConfig.addFilter("jsonify", (obj) => JSON.stringify(obj));

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

  // YouTube URL → embed URL
  eleventyConfig.addFilter("youtubeEmbed", (url) => {
    if (!url) return '';
    return url.replace('youtube.com/watch?v=', 'youtube.com/embed/')
              .replace('youtube.com/shorts/', 'youtube.com/embed/')
              .replace('youtu.be/', 'youtube.com/embed/');
  });

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data"
    },
    templateFormats: ["njk", "md", "html"],
    htmlTemplateEngine: "njk",
    markdownTemplateEngine: "njk"
  };
};
