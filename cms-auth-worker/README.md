# Sveltia CMS auth worker

The Cloudflare Worker that brokers GitHub OAuth for the CMS at `/admin/`.

`src/index.js` is the current official
[`sveltia/sveltia-cms-auth`](https://github.com/sveltia/sveltia-cms-auth)
worker, vendored here so the deployed worker never silently drifts out of sync
with the CMS client again.

## Why this exists

The previously-deployed worker was an **old build**. It did not set the
`csrf-token` cookie on `/auth` and returned a legacy `state` format, so the
current `@sveltia/cms` client rejected the OAuth callback with
**"Authentication aborted."** Redeploying this (current) worker fixes it.

## Deploy

You need the Cloudflare account that owns
`sveltia-cms-auth.hypermobility-md.workers.dev` and the GitHub OAuth App's
**client secret**.

```sh
cd cms-auth-worker

# 1. Log in to the correct Cloudflare account (once per machine)
npx wrangler login

# 2. Set the GitHub OAuth App client SECRET (paste it when prompted).
#    The client ID is already in wrangler.toml (it's public).
npx wrangler secret put GITHUB_CLIENT_SECRET

# 3. Deploy — overwrites the stale worker at the same URL
npx wrangler deploy
```

`name = "sveltia-cms-auth"` in `wrangler.toml` guarantees it publishes to the
existing `sveltia-cms-auth.hypermobility-md.workers.dev` URL, so **no CMS config
change is needed** — `src/admin/config.yml` already points there.

## GitHub OAuth App (should already be correct)

In the OAuth App (client id `Ov23li5o3OxXftXIkYZb`), confirm:

- **Authorization callback URL:** `https://sveltia-cms-auth.hypermobility-md.workers.dev/callback`

That's unchanged by the domain cutover, so it should already be set.

## Verify after deploy

```sh
# /auth must now set the csrf-token cookie (this is what was missing):
curl -s -D - -o /dev/null \
  -H "Referer: https://www.hypermobilitymd.com/admin/" \
  "https://sveltia-cms-auth.hypermobility-md.workers.dev/auth?provider=github" \
  | grep -i set-cookie
# Expect: set-cookie: csrf-token=github_<32 hex chars>; ... SameSite=Lax; Secure

# A disallowed domain must now be rejected (ALLOWED_DOMAINS is enforced):
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "Referer: https://evil.example.com/" \
  "https://sveltia-cms-auth.hypermobility-md.workers.dev/auth?provider=github"
# Expect: 403 (was 302 with the old worker)
```

Then open `https://www.hypermobilitymd.com/admin/` and sign in with GitHub.

## Env vars

| Name | Where | Notes |
| --- | --- | --- |
| `GITHUB_CLIENT_ID` | `wrangler.toml` `[vars]` | Public. |
| `GITHUB_CLIENT_SECRET` | `wrangler secret put` | Secret — never commit. |
| `ALLOWED_DOMAINS` | `wrangler.toml` `[vars]` | Comma-separated hostnames; `*` wildcard ok. |
