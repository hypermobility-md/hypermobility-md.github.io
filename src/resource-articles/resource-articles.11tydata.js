// Each markdown file in src/resource-articles/ becomes a standalone page at
// /resources/{file-slug}/. The /resources/ index (src/resources.njk) links to
// these. Kept separate from the FAQ "Hypermobility Questions" collection so
// long-form guides/handouts don't mix into the FAQ accordion.
module.exports = {
  layout: "resource.njk",
  activePage: "",
  pageType: "article",
  tags: ["resourceArticles"],
  eleventyComputed: {
    permalink: (data) => `/resources/${data.page.fileSlug}/`
  }
};
