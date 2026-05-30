/**
 * Canonical guest-name → key/image helpers.
 *
 * This is the SINGLE source of truth for guest-name normalization. It is
 * CommonJS so the live Eleventy build (eleventy.config.js, src/_data/guestData.js)
 * can require() it directly; the ESM scripts re-export it via ./guest-keys.mjs.
 *
 * If you change normalizeKey here, the client-side copies in
 * src/admin/index.html and src/podcast-guests.njk should be kept in sync.
 */

/** Strip titles + trailing credentials and normalize a guest name to a lookup key. */
function normalizeKey(name) {
  if (!name) return '';
  let n = String(name).replace(/^(Dr\.?|Prof\.?|Professor)\s+/i, '');
  let prev;
  do {
    prev = n;
    n = n.replace(/[,\s]+(M\.?D\.?|Ph\.?D\.?|D\.?P\.?T\.?|D\.?O\.?|P\.?A\.?-?C?|R\.?D\.?N\.?|O\.?T\.?|P\.?T\.?|J\.?D\.?|LICSW|NCPT|ATC|MS|MA|MPT|DMSC|MRCPsych|DDS|D\.?C\.?|FACP|FACS|FAANS|FAAFP|FAAN|FAMSSM|FACOG|FRCPC|IFMCP|ABIHM|CCSP|CEDS-S|FAED|CHT|CYT|CHC|CMTPT|COMT|NCS|OCS|CES|MHCM)\.?\s*$/i, '');
  } while (n !== prev);
  n = n.replace(/[,.\s]+$/, '').trim();
  // Drop a single-letter middle initial so e.g. "Brayden P. Yellman" matches a
  // "brayden yellman" profile key. First and last name tokens are kept.
  const parts = n.split(/\s+/);
  if (parts.length > 2) {
    n = parts.filter((p, i) => i === 0 || i === parts.length - 1 || !/^[A-Za-z]\.?$/.test(p)).join(' ');
  }
  return n.toLowerCase().replace(/\s+/g, ' ');
}

/** Normalize any image path to an absolute /Guests/Filename.ext path. */
function normalizeImagePath(p) {
  if (!p) return p;
  let out = String(p).trim();
  if (!out) return out;
  if (!out.startsWith('/')) out = '/' + out;
  if (!out.startsWith('/Guests/')) {
    const parts = out.split('/');
    out = '/Guests/' + parts[parts.length - 1];
  }
  return out;
}

/**
 * Find a /Guests/ image file matching a normalized key, trying common filename
 * variants (Title_Case / kebab / joined, etc.). Returns the '/Guests/<file>'
 * path or null. `guestFiles` is the list of filenames in src/Guests/.
 */
function findGuestFile(key, guestFiles) {
  const words = key.split(/\s+/);
  const variants = new Set([
    words.map(w => w[0].toUpperCase() + w.slice(1)).join('_'),
    words.map(w => w[0].toUpperCase() + w.slice(1)).join('-'),
    words.map(w => w[0].toUpperCase() + w.slice(1)).join(''),
    words.join('_'),
    words.join('-'),
    words.join(''),
  ]);
  for (const f of guestFiles) {
    const stem = f.replace(/\.[^.]+$/, '');
    if (variants.has(stem)) return '/Guests/' + f;
  }
  return null;
}

module.exports = { normalizeKey, normalizeImagePath, findGuestFile };
