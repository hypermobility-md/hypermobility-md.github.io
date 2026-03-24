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

          // Build links array from individual social fields (if not already present)
          if (!rest.links) {
            const socialFields = [
              { field: 'website', label: 'Website' },
              { field: 'website2', label: 'Site 2' },
              { field: 'linkedin', label: 'LinkedIn' },
              { field: 'twitter', label: 'Twitter' },
              { field: 'substack', label: 'Substack' },
              { field: 'instagram', label: 'Instagram' },
              { field: 'facebook', label: 'Facebook' },
              { field: 'youtube', label: 'YouTube' },
              { field: 'tiktok', label: 'TikTok' },
              { field: 'wikipedia', label: 'Wikipedia' },
            ];
            const links = [];
            socialFields.forEach(({ field, label }) => {
              if (rest[field]) {
                links.push({ url: rest[field], label });
              }
            });
            if (links.length) rest.links = links;
          }

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
