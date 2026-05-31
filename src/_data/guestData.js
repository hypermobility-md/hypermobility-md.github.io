const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');
const { normalizeKey, normalizeImagePath } = require('../../scripts/lib/guest-keys.cjs');

module.exports = function () {
  // Read guest images map
  const rawImages = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'guestImages.json'), 'utf8')
  );
  const images = {};
  for (const [k, v] of Object.entries(rawImages)) {
    images[normalizeKey(k)] = normalizeImagePath(v);
  }

  // Read individual guest profile files
  const profilesDir = path.join(__dirname, '..', 'guest-profiles');
  // `profiles` is the lookup map (includes alias keys, so an episode credited
  // under an alternative name still resolves). `profilePages` is canonical-only
  // — used to generate one guest page per real profile, so aliases never create
  // duplicate-content pages.
  const profiles = {};
  const profilePages = {};

  if (fs.existsSync(profilesDir)) {
    fs.readdirSync(profilesDir)
      .filter(f => f.endsWith('.json'))
      .forEach(f => {
        const data = JSON.parse(
          fs.readFileSync(path.join(profilesDir, f), 'utf8')
        );
        if (data.key) {
          // Normalize the stored key at read time so profile JSONs can use any
          // casing/spacing (e.g. "Jane Doe", "JANE DOE", "jane doe") and still
          // match the lookup keys produced by normalizeKey().
          const rawKey = String(data.key);
          const { image, ...rest } = data;
          const key = normalizeKey(rawKey);
          rest.key = key;

          // Build links array from the social fields (now grouped under a
          // `socials` object in the CMS; older flat top-level fields still work
          // as a fallback).
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
            const socials = rest.socials || {};
            const links = [];
            socialFields.forEach(({ field, label }) => {
              const url = socials[field] || rest[field];
              if (url) {
                links.push({ url, label });
              }
            });
            if (links.length) rest.links = links;
          }

          profiles[key] = rest;
          profilePages[key] = rest; // canonical only — one page per real profile
          // If profile has a photo, add it to the images map too
          if (image) {
            images[key] = image;
          }

          // Register the profile under each alias too, so an episode that
          // credits the guest by an alternative name (e.g. "Larry Afrin")
          // resolves to this same profile + photo. The canonical key wins;
          // aliases only fill keys not already taken by a real profile.
          (Array.isArray(rest.aliases) ? rest.aliases : []).forEach(alias => {
            const aliasKey = normalizeKey(alias);
            if (!aliasKey || aliasKey === key) return;
            if (!profiles[aliasKey]) profiles[aliasKey] = rest;
            if (image && !images[aliasKey]) images[aliasKey] = image;
          });
        }
      });
  }

  // Merge images from episode frontmatter (CMS uploads via guestImage/guestImages)
  const episodesDir = path.join(__dirname, '..', 'episodes');
  if (fs.existsSync(episodesDir)) {
    fs.readdirSync(episodesDir)
      .filter(f => f.endsWith('.md'))
      .forEach(f => {
        const raw = fs.readFileSync(path.join(episodesDir, f), 'utf8');
        const { data } = matter(raw);
        const guests = data.guests || [];

        // guestImages list (parallel to guests array)
        const epImages = data.guestImages || [];
        guests.forEach((g, i) => {
          if (epImages[i]) {
            const key = normalizeKey(g);
            if (!images[key]) {
              images[key] = epImages[i];
            }
          }
        });

        // Single guestImage (for single-guest episodes)
        if (data.guestImage && guests.length === 1) {
          const key = normalizeKey(guests[0]);
          if (!images[key]) {
            images[key] = data.guestImage;
          }
        }
      });
  }

  return { images, profiles, profilePages };
};
