/**
 * Shared guest-name → key/image helpers for the guest-image sync scripts
 * (backfill-episode-display-fields.mjs, sync-guest-profile-images.mjs).
 *
 * `normalizeKey` mirrors the logic in src/_data/guestData.js — if you add a
 * credential here, add it there too (that file is CommonJS / the live build,
 * so it can't import this module).
 */

/** Strip titles + trailing credentials and normalize a guest name to a lookup key. */
export function normalizeKey(name) {
  if (!name) return '';
  let n = String(name).replace(/^(Dr\.?|Prof\.?|Professor)\s+/i, '');
  let prev;
  do {
    prev = n;
    n = n.replace(/[,\s]+(M\.?D\.?|Ph\.?D\.?|D\.?P\.?T\.?|D\.?O\.?|P\.?A\.?-?C?|R\.?D\.?N\.?|O\.?T\.?|P\.?T\.?|J\.?D\.?|LICSW|NCPT|ATC|MS|MA|MPT|DMSC|MRCPsych|DDS|D\.?C\.?|FACP|FACS|FAANS|FAAFP|FAAN|FAMSSM|FACOG|FRCPC|IFMCP|ABIHM|CCSP|CEDS-S|FAED|CHT|CYT|CHC|CMTPT|COMT|NCS|OCS|CES|MHCM)\.?\s*$/i, '');
  } while (n !== prev);
  return n.replace(/[,.\s]+$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Normalize any image path to an absolute /Guests/Filename.ext path. */
export function normalizeImagePath(p) {
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
export function findGuestFile(key, guestFiles) {
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
