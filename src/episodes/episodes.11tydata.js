// Build a URL-safe, ~60-char slug from an episode title.
function slugifyTitle(title) {
  if (!title) return '';
  const cleaned = String(title)
    .replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/i, '') // strip "(Ep 195)" suffix
    .replace(/^\d+\.\s+/, '')                        // strip "95. " prefix
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Truncate to ~60 chars on a word boundary so URLs stay readable.
  return cleaned.split('-').reduce((acc, word) => {
    const candidate = acc ? `${acc}-${word}` : word;
    return candidate.length <= 60 ? candidate : acc;
  }, '');
}

module.exports = {
  eleventyComputed: {
    permalink: (data) => {
      // Numbered episodes: /episodes/{num}-{title-slug}/
      if (data.num !== null && data.num !== undefined && data.num !== '') {
        const slug = slugifyTitle(data.title);
        return slug ? `/episodes/${data.num}-${slug}/` : `/episodes/${data.num}/`;
      }
      // Bonus episodes use file slug (e.g., bonus-welcome → /episodes/bonus-welcome/)
      const slug = data.page && data.page.fileSlug;
      if (slug && slug !== 'null') {
        return `/episodes/${slug}/`;
      }
      return false;
    }
  }
};
