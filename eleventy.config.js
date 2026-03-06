module.exports = function(eleventyConfig) {
  // Pass through static assets
  eleventyConfig.addPassthroughCopy("src/assets");
  eleventyConfig.addPassthroughCopy("src/Guests");
  eleventyConfig.addPassthroughCopy("src/css");
  eleventyConfig.addPassthroughCopy("src/admin");
  eleventyConfig.addPassthroughCopy("src/Populate");

  // Generate data.js from episode markdown files at build time
  eleventyConfig.addCollection("episodes", function(collectionApi) {
    return collectionApi.getFilteredByGlob("src/episodes/*.md")
      .sort((a, b) => (b.data.num || 0) - (a.data.num || 0));
  });

  // Date formatting filter
  eleventyConfig.addFilter("isoDate", (date) => {
    if (!date) return '';
    if (date === 'now') return new Date().toISOString().split('T')[0];
    if (typeof date === 'string') return date;
    return date.toISOString().split('T')[0];
  });

  // JSON stringify filter
  eleventyConfig.addFilter("jsonify", (obj) => JSON.stringify(obj));

  // Markdown-it for transcript rendering
  eleventyConfig.addFilter("markdownify", (str) => {
    if (!str) return '';
    const md = require("markdown-it")();
    return md.render(str);
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
