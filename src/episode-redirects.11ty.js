// Emits redirect stubs to keep old episode URLs working:
//   1. /episodes/{num}/                  → canonical (always, for legacy short URL)
//   2. /episodes/{num}-{derived-slug}/   → canonical (only when the CMS slug
//                                          override differs from the derived slug)
// Generated from the episodes collection at build time, so new episodes get
// stubs automatically.

function slugifyTitle(title) {
  if (!title) return "";
  const cleaned = String(title)
    .replace(/\s*\((?:Ep(?:isode)?|BEN)\.?\s*#?\s*\d+\)\s*$/i, "")
    .replace(/^\d+\.\s+/, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.split("-").reduce((acc, word) => {
    const candidate = acc ? `${acc}-${word}` : word;
    return candidate.length <= 60 ? candidate : acc;
  }, "");
}

// One-off legacy redirects for episodes whose URL changed outside the normal
// {num} pattern (e.g. a bonus slug that was later promoted to a numbered ep).
const EXTRA_REDIRECTS = [
  {
    from: "/episodes/bonus-hypermobility-then-and-now-episode-200/",
    to: "/episodes/200-hypermobility-then-and-now/",
  },
];

function derivedUrl(ep) {
  const num = ep.data.num;
  if (num == null || num === "") return null;
  const slug = slugifyTitle(ep.data.title);
  return slug ? `/episodes/${num}-${slug}/` : `/episodes/${num}/`;
}

function redirectsFor(ep) {
  const urls = new Set();
  const num = ep.data.num;
  if (num != null && num !== "") urls.add(`/episodes/${num}/`);
  const derived = derivedUrl(ep);
  if (derived) urls.add(derived);
  urls.delete(ep.url); // never emit a stub at the canonical URL
  return [...urls];
}

module.exports = class {
  data() {
    return {
      pagination: {
        data: "collections.episodes",
        size: 1,
        alias: "entry",
        before: (episodes) => [
          ...episodes
            .filter((ep) => ep.data.num != null && ep.data.num !== "")
            .flatMap((ep) =>
              redirectsFor(ep).map((from) => ({ from, to: ep.url }))
            ),
          ...EXTRA_REDIRECTS,
        ],
      },
      eleventyExcludeFromCollections: true,
      permalink: (data) => data.entry.from,
    };
  }

  // No `noindex` here: it would contradict the canonical below and can get
  // applied to the canonical target. The canonical alone is the signal.
  render({ entry, site }) {
    const url = entry.to;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting&hellip;</title>
<link rel="canonical" href="${site.url}${url}">
<meta http-equiv="refresh" content="0; url=${url}">
</head>
<body>
<p>This episode has moved to <a href="${url}">${url}</a>.</p>
<script>location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
  }
};
