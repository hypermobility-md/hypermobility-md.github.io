/**
 * Shared guest-name → key/image helpers for the ESM scripts
 * (sync-rss.mjs, backfill-*.mjs, sync-guest-profile-images.mjs).
 *
 * This is a thin ESM re-export of ./guest-keys.cjs — the single CommonJS
 * source of truth that the live Eleventy build also requires. Do not duplicate
 * the implementation here; edit guest-keys.cjs instead.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeKey, normalizeImagePath, findGuestFile } = require('./guest-keys.cjs');

export { normalizeKey, normalizeImagePath, findGuestFile };
