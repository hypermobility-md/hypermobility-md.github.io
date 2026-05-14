// Emits a redirect stub at every old /episodes/{num}/ URL pointing to the
// episode's current /episodes/{num}-{slug}/ permalink. Generated from the
// episodes collection at build time, so new episodes get a stub automatically.
module.exports = class {
  data() {
    return {
      pagination: {
        data: "collections.episodes",
        size: 1,
        alias: "ep",
        before: (episodes) =>
          episodes.filter((ep) => ep.data.num != null && ep.data.num !== ""),
      },
      eleventyExcludeFromCollections: true,
      permalink: (data) => {
        const oldUrl = `/episodes/${data.ep.data.num}/`;
        // Guard: if the episode's title produced an empty slug, its canonical
        // URL is already the bare numbered URL — don't emit a self-referential
        // stub that would collide with the real page.
        return data.ep.url === oldUrl ? false : oldUrl;
      },
    };
  }

  render({ ep }) {
    const url = ep.url;
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
