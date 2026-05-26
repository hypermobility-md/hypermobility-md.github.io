// All files in src/hypermobility-questions/ become pages at
// /faq/{file-slug}/ so URLs match the legacy /faq/<slug>/ pattern that
// external links and SEO already rank for.
module.exports = {
  layout: "hypermobility-question.njk",
  activePage: "faq",
  pageType: "article",
  tags: ["hypermobilityQuestions"],
  eleventyComputed: {
    permalink: (data) => `/faq/${data.page.fileSlug}/`
  }
};
