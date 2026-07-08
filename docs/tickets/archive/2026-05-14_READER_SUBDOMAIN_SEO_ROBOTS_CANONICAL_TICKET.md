# Reader Subdomain SEO, Robots, and Placeholder Page

Date: 2026-05-14
Revised: 2026-05-19
Status: Done — deployed and verified 2026-05-19
Area: Inti Reader / SEO / infrastructure

## Completion

Completed on 2026-05-19.

- `reader.myinti.ai` is served by the `myinti-web` DigitalOcean App Platform app
  as a separate static component sourced from `/landing/reader-subdomain`.
- IONOS DNS points `reader.myinti.ai` to
  `myinti-web-n7skt.ondigitalocean.app`.
- `https://reader.myinti.ai/` returns `200`.
- `https://reader.myinti.ai/robots.txt` returns `200`.
- The placeholder canonical is `https://myinti.ai/reader`.
- The placeholder links to `https://myinti.ai/reader` and uses
  `https://myinti.ai/inti-reader-social.webp` for social/image metadata.
- The old Reader PWA service worker/cache issue was handled with unregistering
  cleanup files at `/sw.js`, `/registerSW.js`, and the placeholder page script.

## Decision

`myinti.ai/reader` is the canonical public landing page for Inti Reader SEO.
`reader.myinti.ai` is the app origin. While the Reader app infrastructure is
paused, the subdomain should serve a lightweight public placeholder that:

- returns `200` at `https://reader.myinti.ai/`
- shows the Inti Reader social/logo image
- explains that the Reader app is being prepared
- links to `https://myinti.ai/reader`
- uses `<link rel="canonical" href="https://myinti.ai/reader" />`
- points Open Graph/Twitter metadata at the Inti Reader social image

The reader subdomain should cooperate with the main site, not compete with it.
Search discovery and ranking signals should consolidate on `myinti.ai/reader`.

## Admin and Private Routes

Admin and authenticated routes should not be part of SEO. They should not appear
in any sitemap and should not be treated as public landing pages.

`robots.txt` is useful hygiene for these paths, but it is not a security control.
Access control still belongs in the application. The SEO goal is simply to avoid
inviting crawlers into private app surfaces such as API, account, CRM, settings,
document, and admin-like routes.

## Current State

`myinti.ai/reader` already has the public SEO surface:

- canonical tag pointing to itself
- meta description and social preview metadata
- Inti Reader social image
- SoftwareApplication, FAQPage, and WebPage JSON-LD
- sitemap entry in `https://myinti.ai/sitemap.xml`

`reader.myinti.ai` is currently a separate app origin. The live subdomain has
recently returned no useful content while the DigitalOcean Reader app service is
down for this development stage. That leaves crawlers with either a `404` or a
thin app shell, neither of which helps discovery.

## Implementation Plan

### 1. Reader app robots file

Update the Reader app `public/robots.txt` so the subdomain root remains
crawlable while private app paths and APIs are discouraged:

```txt
User-agent: *
Allow: /
Disallow: /api/
Disallow: /users
Disallow: /crm
Disallow: /invite
Disallow: /marketing
Disallow: /icons
Disallow: /issues
Disallow: /settings
Disallow: /reader/
Disallow: /*?documentId=

Sitemap: https://myinti.ai/sitemap.xml
```

The sitemap should remain the main-domain sitemap unless the reader subdomain
later gets its own self-canonical public pages.

### 2. Reader app shell metadata

Keep the Reader app root canonicalized to `https://myinti.ai/reader`, and update
stale social/JSON-LD copy so app previews match the current consumer Reader
positioning rather than old enterprise Inti Docs copy.

### 3. Static reader-subdomain placeholder

Add a small static deploy artifact for `reader.myinti.ai` that can be served
while the app is offline. It should use:

- title and description for Inti Reader
- canonical tag to `https://myinti.ai/reader`
- `og:url` for `https://reader.myinti.ai/`
- `og:image` and `twitter:image` for `https://myinti.ai/inti-reader-social.webp`
- visible CTA to `https://myinti.ai/reader`
- secondary link to `https://myinti.ai/`

Do not create a separate reader-subdomain sitemap for the placeholder. It is a
temporary, canonicalized page; the durable indexable URL remains
`https://myinti.ai/reader`.

### 4. Search Console and IndexNow

Search Console for `reader.myinti.ai` is optional manual monitoring. Add it if we
want crawl visibility for the subdomain, but it is not required for this code
change.

IndexNow is deferred. There is no meaningful subdomain URL set to notify while
the subdomain placeholder canonicalizes to the main landing page.

## Acceptance Criteria

- `https://reader.myinti.ai/` returns a crawlable `200` placeholder while the app
  is offline.
- The placeholder visibly shows the Inti Reader social/logo image.
- The placeholder links to `https://myinti.ai/reader`.
- The placeholder canonical is `https://myinti.ai/reader`.
- `https://reader.myinti.ai/robots.txt` returns `200`.
- Reader subdomain robots allows `/` and discourages crawler access to private
  app/API routes.
- Private/admin routes are not added to any sitemap.
- Main-site `https://myinti.ai/reader` remains the canonical SEO landing page.

## Files

- `public/robots.txt` — Reader app robots rules for future app deployment
- `web/index.html` — Reader app shell canonical and social metadata
- `landing/reader-subdomain/index.html` in `MyInti-Site` — temporary static
  placeholder for `reader.myinti.ai`
- `landing/reader-subdomain/robots.txt` in `MyInti-Site` — temporary static
  subdomain robots file
