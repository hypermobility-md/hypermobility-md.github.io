# Guest intake → draft guest profile (Apps Script integration)

The guest intake form (`/guest-form/a8f3x9k2/`) POSTs to a Google Apps Script
that appends a row to the Google Sheet. This adds a second action: the same
submission also writes a **draft guest profile** into the repo, so it shows up
in the CMS for review.

**Lifecycle:** submit → `confirmed: false` profile committed to the repo →
hidden everywhere on the site (the `confirmed` gate in `src/_data/guestData.js`)
→ you review in the CMS and switch **Confirmed** on → it goes live. The guest
*index* lists them once an episode credits them (existing behavior).

**Split of data (privacy):** only PUBLIC fields go to the repo (name,
credentials, affiliation, bio, social/web links). Contact and internal prep
fields (email, phone, questions_topics, hypermobility_hack, plug, additional)
stay in the **Sheet only**. The Sheet remains the durable record / source of
truth.

> The Apps Script file is gitignored and edited by hand in the Apps Script
> editor (see memory: changes can't be committed). This doc is the reference;
> paste the snippet below into the script.

## One-time setup

1. Create a **fine-grained Personal Access Token** (github.com → Settings →
   Developer settings → Fine-grained tokens) scoped to **this repo only**, with
   **Repository permissions → Contents: Read and write**. Copy it.
2. Apps Script editor → **Project Settings → Script properties** → add
   `GITHUB_TOKEN` = the token.
3. Paste the functions below into the script.
4. In `doPost`, **after** you append the row to the Sheet, add:

   ```javascript
   try { createDraftGuestProfile(data); } catch (err) { Logger.log('intake→repo failed: ' + err); }
   ```

   Wrapping in `try/catch` means a GitHub hiccup never breaks the Sheet write.

5. Submit a test entry. A `src/guest-profiles/<slug>.json` with
   `"confirmed": false` should appear on `master`, hidden from the site, ready
   to review.

> `data` must be the parsed submission object whose keys are the form field
> names (`name`, `credentials`, `affiliation`, `bio`, `website`, `linkedin`, …).
> If your `doPost` names it differently, adjust the calls.

## Snippet

```javascript
// ===== Guest intake → draft profile in the repo =====
var GH_OWNER  = 'hypermobility-md';
var GH_REPO   = 'hypermobility-md.github.io';
var GH_BRANCH = 'master';

function createDraftGuestProfile(data) {
  var name = (data.name || '').toString().trim();
  if (!name) return;

  var key = normalizeGuestKey_(name);
  if (!key) return;
  var slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) return;
  var path = 'src/guest-profiles/' + slug + '.json';

  // Don't clobber an existing profile — the first submission is the source of truth.
  if (githubFileExists_(path)) return;

  // Only PUBLIC fields go to the repo.
  var socials = {};
  ['website','website2','linkedin','twitter','substack','instagram','facebook','youtube','tiktok','wikipedia']
    .forEach(function (f) { if (data[f]) socials[f] = data[f].toString().trim(); });

  var profile = { key: key };
  if (name)             profile.name = name;
  if (data.credentials) profile.credentials = data.credentials.toString().trim();
  if (data.affiliation) profile.affiliation = data.affiliation.toString().trim();
  if (data.bio)         profile.bio = data.bio.toString().trim();
  if (Object.keys(socials).length) profile.socials = socials;
  profile.confirmed = false; // hidden on the site until reviewed in the CMS

  var content = Utilities.base64Encode(
    JSON.stringify(profile, null, 2) + '\n', Utilities.Charset.UTF_8);

  var url = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO +
            '/contents/' + encodeURI(path);
  var res = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: ghHeaders_(),
    payload: JSON.stringify({
      message: 'Guest intake submission: ' + name,
      content: content,
      branch: GH_BRANCH
    })
  });
  if (res.getResponseCode() >= 300) {
    Logger.log('GitHub create failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
}

function githubFileExists_(path) {
  var url = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO +
            '/contents/' + encodeURI(path) + '?ref=' + GH_BRANCH;
  var res = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: ghHeaders_() });
  return res.getResponseCode() === 200;
}

function ghHeaders_() {
  return {
    Authorization: 'Bearer ' + PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN'),
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

// Mirror of scripts/lib/guest-keys.cjs normalizeKey() — keep in sync.
function normalizeGuestKey_(name) {
  if (!name) return '';
  var n = name.toString().replace(/^(Dr\.?|Prof\.?|Professor)\s+/i, '');
  var prev;
  do {
    prev = n;
    n = n.replace(/[,\s]+(M\.?D\.?|Ph\.?D\.?|D\.?P\.?T\.?|D\.?O\.?|P\.?A\.?-?C?|R\.?D\.?N\.?|O\.?T\.?|P\.?T\.?|J\.?D\.?|LICSW|NCPT|ATC|MS|MA|MPT|DMSC|MRCPsych|DDS|D\.?C\.?|FACP|FACS|FAANS|FAAFP|FAAN|FAMSSM|FACOG|FRCPC|IFMCP|ABIHM|CCSP|CEDS-S|FAED|CHT|CYT|CHC|CMTPT|COMT|NCS|OCS|CES|MHCM)\.?\s*$/i, '');
  } while (n !== prev);
  n = n.replace(/[,.\s]+$/, '').trim();
  var parts = n.split(/\s+/);
  if (parts.length > 2) {
    n = parts.filter(function (p, i) {
      return i === 0 || i === parts.length - 1 || !/^[A-Za-z]\.?$/.test(p);
    }).join(' ');
  }
  return n.toLowerCase().replace(/\s+/g, ' ');
}
```

## Not included (future)

- **Headshot.** The form has a `headshot` field, but committing the uploaded
  image needs extra handling (base64 of the binary + a second Contents API
  write to `src/Guests/`). For now, add the photo in the CMS during review.
  Can be added later if the manual step is annoying.
