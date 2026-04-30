const fs = require('fs');
const path = require('path');
const matter = require('gray-matter');

// Normalize a guest image path to an absolute /Guests/Filename.ext path.
// CMS uploads sometimes save without a leading slash, which breaks <img src=>
// rendering on episode pages. This guarantees an absolute, /Guests/-rooted path.
function normalizeImagePath(p) {
  if (!p || typeof p !== 'string') return p;
  let out = p.trim();
  if (!out) return out;
  if (!out.startsWith('/')) out = '/' + out;
  if (!out.startsWith('/Guests/')) {
    const parts = out.split('/');
    out = '/Guests/' + parts[parts.length - 1];
  }
  return out;
}

module.exports = function () {
  // Read guest images map
  const rawImages = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'guestImages.json'), 'utf8')
  );
  const images = {};
  for (const [k, v] of Object.entries(rawImages)) {
    images[k] = normalizeImagePath(v);
  }

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

  return { images, profiles };
};

/** Normalize a guest name to a lookup key (mirrors normalizeGuestKey in eleventy.config.js). */
function normalizeKey(name) {
  if (!name) return '';
  let n = name.replace(/^(Dr\.?|Prof\.?|Professor)\s+/i, '');
  let prev;
  do {
    prev = n;
    n = n.replace(/[,\s]+(M\.?D\.?|Ph\.?D\.?|D\.?P\.?T\.?|D\.?O\.?|P\.?A\.?-?C?|R\.?D\.?N\.?|O\.?T\.?|P\.?T\.?|J\.?D\.?|LICSW|NCPT|ATC|MS|MA|MPT|DMSC|MRCPsych|DDS|D\.?C\.?|FACP|FACS|FAANS|FAAFP|FAAN|FAMSSM|FACOG|FRCPC|IFMCP|ABIHM|CCSP|CEDS-S|FAED|CHT|CYT|CHC|CMTPT|COMT|NCS|OCS|CES|MHCM)\.?\s*$/i, '');
  } while (n !== prev);
  return n.replace(/[,.\s]+$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}
