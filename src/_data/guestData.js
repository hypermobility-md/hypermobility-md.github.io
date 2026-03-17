const fs = require('fs');
const path = require('path');

module.exports = function () {
  // Read guest images map
  const images = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'guestImages.json'), 'utf8')
  );

  // Read individual guest profile files
  const profilesDir = path.join(__dirname, '..', 'guest-profiles');
  const profiles = {};

  if (fs.existsSync(profilesDir)) {
    fs.readdirSync(profilesDir)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        const data = JSON.parse(
          fs.readFileSync(path.join(profilesDir, f), 'utf8')
        );
        if (data.key) {
          const { key, image, ...rest } = data;
          profiles[key] = rest;
          // If profile has a photo, add it to the images map too
          if (image) {
            images[key] = image;
          }
        }
      });
  }

  return { images, profiles };
};
