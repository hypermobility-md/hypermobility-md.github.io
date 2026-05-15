// Emits redirect stubs to keep old episode URLs working:
//   1. /episodes/{num}/                  → canonical (always, for legacy short URL)
//   2. /episodes/{num}-{derived-slug}/   → canonical (only when the CMS slug
//                                          override differs from the derived slug)
// Generated from the episodes collection at build time, so new episodes get
// stubs automatically.

function slugifyTitle(title) {
  if (!title) return "";
  const cleaned = String(title)
    .replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/i, "")
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
        before: (episodes) =>
          episodes
            .filter((ep) => ep.data.num != null && ep.data.num !== "")
            .flatMap((ep) =>
              redirectsFor(ep).map((from) => ({ ep, from }))
            ),
      },
      eleventyExcludeFromCollections: true,
      permalink: (data) => data.entry.from,
    };
  }

  render({ entry }) {
    const url = entry.ep.url;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Redirecting&hellip;</title>
<link rel="canonical" href="${url}">
<meta http-equiv="refresh" content="0; url=${url}">
<meta name="robots" content="noindex">
</head>
<body>
<p>This episode has moved to <a href="${url}">${url}</a>.</p>
<script>location.replace(${JSON.stringify(url)});</script>
</body>
</html>`;
  }
};
