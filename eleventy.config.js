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
