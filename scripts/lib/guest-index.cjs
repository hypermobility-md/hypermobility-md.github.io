/**
 * Server-side Guest Index builder.
 *
 * Renders the full Guest Index grid (grouped alphabetically by surname) at BUILD
 * time so the cards — and the first card's image (the LCP element) — ship in the
 * initial HTML instead of being assembled client-side. The page's inline script
 * then only filters this DOM (search / alphabet), so the card-building logic that
 * used to be duplicated in the browser now lives here only.
 *
 * Ported from the original client code in src/podcast-guests.njk. Guest-name
 * normalization comes from the canonical ./guest-keys.cjs (single source of truth).
 */
const { normalizeKey } = require('./guest-keys.cjs');

const HOST_PATTERNS = [/linda\s+bluestein/i];
const INVALID_GUESTS = [
  'guest host', 'dance injuries', 'physical therapists', 'chronic pain',
  'multisystemic diseases', 'whealth founders', 'royal ballet',
  'orthopedic surgeon', 'physiotherapist', 'immunologist',
  'psychotherapist', 'anesthesiologist',
];

function isHost(name) { return HOST_PATTERNS.some(p => p.test(name)); }
function isInvalidGuest(name) {
  const lower = name.toLowerCase();
  return INVALID_GUESTS.some(inv => lower.startsWith(inv));
}

// HTML-escape for safe interpolation into attributes / text.
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Last name, lowercased, for sorting + the alphabet heading.
function sortLastName(name) {
  const parts = normalizeKey(name).split(' ');
  return parts[parts.length - 1] || '';
}

function getSocialIcon(url, size) {
  if (!url) return '';
  const s = size || 16;
  const u = url.toLowerCase();
  if (u.includes('wikipedia.org')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M12.09 13.119c-.936 1.932-2.217 4.548-2.853 5.728-.616 1.074-1.127.914-1.5 0-.163-.401-2.199-5.237-4.1-9.87-.472-1.15-.795-1.252-1.44-1.34L1.5 7.5V7c1.094.04 1.645.06 2.784.068 1.14-.008 2.277-.03 3.09-.068v.5l-.495.1c-.576.114-.727.381-.517.932 1.142 3.012 2.304 5.835 2.304 5.835l2.204-4.568s-.705-1.59-1.124-2.587c-.322-.764-.604-.858-1.163-.936L7.5 6.1v-.5c1.02.04 2.01.06 2.97.068.94-.008 1.84-.03 2.7-.068v.5l-.5.1c-.582.126-.702.392-.468.972.704 1.754 1.476 3.626 1.476 3.626l1.41-2.857c.46-.937.39-1.396-.397-1.556L14.1 6.1v-.5c.85.04 1.62.06 2.37.068.76-.008 1.56-.03 2.38-.068v.5l-.55.112c-.773.158-1.14.64-1.74 1.706L14.02 12.86l2.07 4.26c1.78-3.614 3.532-7.228 3.532-7.228.56-1.144.26-1.486-.55-1.614L18.1 8.1v-.5c.87.04 1.64.06 2.34.068.76-.008 1.46-.03 2.06-.068v.5l-.42.084c-.6.12-.934.648-1.41 1.556L16.36 18.85c-.44.852-.71.916-1.12 0l-3.15-5.73z"/></svg>`;
  if (u.includes('substack.com')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z"/></svg>`;
  if (u.includes('linkedin.com')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></svg>`;
  if (u.includes('twitter.com') || u.includes('x.com')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 4s-.7 2.1-2 3.4c1.6 10-9.4 17.3-18 11.6 2.2.1 4.4-.6 6-2C3 15.5.5 9.6 3 5c2.2 2.6 5.6 4.1 9 4-.9-4.2 4-6.6 7-3.8 1.1 0 3-1.2 3-1.2z"/></svg>`;
  if (u.includes('instagram.com')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>`;
  if (u.includes('facebook.com')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>`;
  if (u.includes('youtube.com') || u.includes('youtu.be')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>`;
  if (u.includes('tiktok.com')) return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>`;
  // Globe icon for external links
  return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;
}

function sortSocialLinks(links) {
  if (!links || !links.length) return [];
  function priority(link) {
    const u = (link.url || '').toLowerCase();
    const label = (link.label || '').toLowerCase();
    const isSocial = ['linkedin', 'twitter', 'x.com', 'instagram', 'facebook', 'youtube', 'youtu.be', 'tiktok', 'wikipedia', 'substack'].some(d => u.includes(d));
    if (u.includes('wikipedia.org')) return 0;
    if (!isSocial && (label === 'website' || label === 'site')) return 1;
    if (!isSocial && label === 'site 2') return 2;
    if (u.includes('substack.com')) return 2.5;
    if (u.includes('linkedin.com')) return 3;
    if (u.includes('instagram.com')) return 4;
    if (u.includes('twitter.com') || u.includes('x.com')) return 5;
    if (u.includes('facebook.com')) return 6;
    if (u.includes('youtube.com') || u.includes('youtu.be')) return 7;
    if (u.includes('tiktok.com')) return 8;
    return 9;
  }
  return links.slice().sort((a, b) => priority(a) - priority(b));
}

/**
 * @param {Array} episodes  [{ num, url, title, guests }]
 * @param {Object} guestData { images, profiles }
 * @returns {{ gridHtml: string, letters: string[] }}
 */
function buildGuestIndex(episodes, guestData) {
  const images = (guestData && guestData.images) || {};
  const profiles = (guestData && guestData.profiles) || {};

  const getGuestImage = (name) => images[normalizeKey(name)] || null;
  const getGuestProfile = (name) => profiles[normalizeKey(name)] || null;
  const hasGuestPage = (name) => !!profiles[normalizeKey(name)];
  const guestSlug = (name) => {
    const key = normalizeKey(name);
    const prof = profiles[key];
    return (prof && prof.key ? prof.key : key).replace(/\s+/g, '-');
  };

  // Build guest map (canonical key → { displayName, episodes }).
  const tempMap = {};
  (episodes || []).forEach(ep => {
    if (!ep.guests || ep.guests.length === 0) return;
    ep.guests.forEach(g => {
      if (!g || isHost(g) || isInvalidGuest(g) || g.length < 3) return;
      let key = normalizeKey(g);
      const canonProf = profiles[key];
      if (canonProf && canonProf.key) key = canonProf.key;
      if (key.length < 3) return;
      if (!tempMap[key]) {
        tempMap[key] = { displayName: g, episodes: [] };
      } else {
        const current = tempMap[key].displayName;
        if (g.match(/^Dr\.?\s/i) && !current.match(/^Dr\.?\s/i)) tempMap[key].displayName = g;
        else if (g.length > current.length && !current.match(/^Dr\.?\s/i)) tempMap[key].displayName = g;
      }
      if (!tempMap[key].episodes.find(e => e.title === ep.title)) tempMap[key].episodes.push(ep);
    });
  });

  const guestMap = {};
  Object.values(tempMap).forEach(({ displayName, episodes }) => { guestMap[displayName] = episodes; });

  const allGuests = Object.keys(guestMap).sort((a, b) =>
    sortLastName(a).localeCompare(sortLastName(b)));

  const letters = [...new Set(allGuests.map(g => sortLastName(g)[0].toUpperCase()))].sort();

  function buildGuestCard(name, index) {
    const episodes = guestMap[name];
    const img = getGuestImage(name);
    const profile = getGuestProfile(name);
    const loadAttr = index < 8 ? 'eager' : 'lazy';
    // Hint the first card image as the likely LCP element so the browser fetches it first.
    const priorityAttr = index === 0 ? ' fetchpriority="high"' : '';
    const imgHtml = img
      ? `<img class="guest-card-img" src="${esc(img)}" alt="${esc(name)}" loading="${loadAttr}"${priorityAttr}>`
      : '';
    const affiliationHtml = profile && profile.affiliation
      ? `<div class="guest-card-affiliation">${esc(profile.affiliation)}</div>` : '';
    const bioHtml = profile && profile.bio
      ? `<div class="guest-card-bio">${esc(profile.bio)}</div>` : '';
    let linksHtml = '';
    if (profile && profile.links && profile.links.length) {
      const sorted = sortSocialLinks(profile.links);
      const MAX_SHOW = 3;
      const visibleLinks = sorted.slice(0, MAX_SHOW);
      const hiddenLinks = sorted.slice(MAX_SHOW);
      linksHtml = visibleLinks.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="guest-card-website" title="${esc(l.label || 'Website')}">${getSocialIcon(l.url)}</a>`).join(' ');
      if (hiddenLinks.length > 0 && hasGuestPage(name)) {
        linksHtml += ` <a href="/guests/${esc(guestSlug(name))}/" class="guest-card-website guest-links-more" title="View all links">+${hiddenLinks.length}</a>`;
      } else if (hiddenLinks.length > 0) {
        linksHtml += hiddenLinks.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="guest-card-website" title="${esc(l.label || 'Website')}">${getSocialIcon(l.url)}</a>`).join(' ');
      }
    }
    const epList = episodes.map(ep => {
      const epNum = ep.num ? `<span class="guest-ep-num">Ep ${ep.num}</span> · ` : '';
      const cleanTitle = ep.title.replace(/\s*\((?:Ep|EP|BEN)\s*\d+\)\s*$/, '').replace(/^\d+\.\s+/, '').trim();
      const href = ep.url || '#';
      return `<li><a href="${esc(href)}" style="color: inherit; text-decoration: none; display: block;">${epNum}${esc(cleanTitle)}</a></li>`;
    }).join('');
    const lastName = sortLastName(name);
    const nameHtml = hasGuestPage(name)
      ? `<a href="/guests/${esc(guestSlug(name))}/" style="color:inherit;text-decoration:none;">${esc(name)}</a>`
      : esc(name);
    return `
    <div class="guest-card" id="guest-${esc(lastName)}" data-name="${esc(name.toLowerCase())}">
      <div class="guest-card-header">
        ${imgHtml}
        <h3>${nameHtml} ${linksHtml}</h3>
      </div>
      ${affiliationHtml}
      ${bioHtml}
      <ul class="guest-episodes">${epList}</ul>
    </div>`;
  }

  // Group by surname initial, matching the default (all, no-search) client view.
  const groups = {};
  let index = 0;
  allGuests.forEach(g => {
    const l = sortLastName(g)[0].toUpperCase();
    (groups[l] = groups[l] || []).push(g);
  });
  const gridHtml = Object.keys(groups).sort().map(letter => `
    <div class="alpha-section" data-letter="${esc(letter)}">
      <div class="alpha-section-heading">${esc(letter)}</div>
      <div class="guest-index">${groups[letter].map(g => buildGuestCard(g, index++)).join('')}</div>
    </div>
  `).join('');

  return { gridHtml, letters };
}

module.exports = { buildGuestIndex };
