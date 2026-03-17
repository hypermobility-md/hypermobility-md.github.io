module.exports = {
  eleventyComputed: {
    permalink: (data) => {
      // Episodes with a number get /episodes/{num}/
      if (data.num !== null && data.num !== undefined && data.num !== '') {
        return `/episodes/${data.num}/`;
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
