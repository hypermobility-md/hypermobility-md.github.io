module.exports = {
  eleventyComputed: {
    permalink: (data) => {
      // Only generate pages for episodes with a real num (including 0)
      if (data.num !== null && data.num !== undefined && data.num !== '') {
        return `/episodes/${data.num}/`;
      }
      return false;
    }
  }
};
