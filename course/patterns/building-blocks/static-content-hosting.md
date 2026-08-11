---
title: "Static Content Hosting"
sidebar_position: 12
supplementary: true
---

Static content hosting serves files that don't change per request —
HTML, JavaScript, CSS, images, fonts — directly from object storage or a
dedicated static host, instead of routing every request for those files
through an application server that would just read the same bytes from
disk or cache on every hit.

![Static Content Hosting diagram](/img/patterns/static-content-hosting.svg)

## Problem it solves

An application server exists to run business logic: authenticate a
request, query a database, apply rules, assemble a response that
depends on who's asking and what they're asking for. A request for
`app.js` or `logo.png` needs none of that — the bytes returned are
identical for every caller and don't change until the next deploy. If
those requests are routed through the application server anyway, every
one of them still consumes a request-handling thread or process, still
passes through the same middleware stack, and still competes for the
exact capacity that's supposed to be reserved for genuinely dynamic
work — all to return a file that hasn't changed since it was last
built. Static content hosting removes that mismatch: static assets are
pulled out of the application server's request path entirely and served
directly from storage built for exactly this — flat key lookup,
massive read throughput, no compute per request.

## Technical architecture & implementation

**Where assets live and how they're served.** At build or deploy time,
static assets are pushed to a [blob
store](/docs/patterns/building-blocks/blob-store) or a purpose-built
static hosting service, each file addressable by its path as a key. A
client requesting `/assets/app.js` is routed straight to that storage
layer rather than to the application's compute tier, so the file is
served with no application code running at all — no routing logic beyond
"does this key exist," no middleware, no server-side rendering. The
application server is left to handle only what actually needs it — API
calls, form submissions, anything personalized or stateful — while the
static tier absorbs every request for assets that would otherwise have
queued up behind that same compute.

**Fingerprinted URLs and immutable caching.** The single most important
implementation detail is *content-hashed filenames*. A build step names
each asset with a hash of its own bytes — `app.4f9a1c.js`,
`styles.a1b2c3.css` — so the URL changes whenever, and only whenever, the
content changes. This unlocks the strongest possible caching contract:
the asset can be served with `Cache-Control: public, max-age=31536000,
immutable`, telling every browser and cache to keep it for a year and
never revalidate, because a changed file is simply a *different URL* that
no cache has yet. The one file that must *not* be cached this way is the
entry point (typically `index.html`), which references the hashed assets
by name and therefore has to be re-fetched to learn about a new deploy;
it gets a short TTL or a `no-cache` revalidation. Getting this split
right — long-lived immutable assets, short-lived HTML entry point — is
what makes a deploy propagate correctly instead of serving a mismatched
mix of old and new files.

**Origin offload and the CDN in front.** Because fingerprinted files are
immutable, they're maximally cacheable: a
[CDN](/docs/patterns/building-blocks/cdn) sitting in front of the static
host caches each asset at edge locations close to users and serves the
overwhelming majority of requests without ever reaching the origin
storage after the first request for a given file. The static host is the
*origin* (the authoritative copy); the CDN is the *edge cache* (nearby
copies). This is the cleanest possible origin: since assets never change
in place, the CDN's usual staleness worry mostly evaporates — there is no
"the origin updated but the edge is stale" problem when the origin never
mutates a URL's bytes.

**TLS and the single-hostname model.** Static assets are served over
HTTPS like anything else, and terminating TLS at the edge (or at the
static host) is table stakes — browsers refuse to load mixed-content
assets over HTTP from an HTTPS page, so every asset URL has to be
`https://`. Serving assets from a dedicated asset hostname (or a
CDN-provided one) is common both for cache-cookie hygiene (a cookieless
asset domain keeps large auth cookies off every image request) and for
letting the asset domain's TLS and caching config be tuned independently
of the API domain.

**Public vs. private assets — signed URLs.** Not every static file is
world-readable. A user's uploaded invoice PDF or a paid video is
*static* (it doesn't vary per request) but *not public* (only some
callers may fetch it). The standard mechanism is a **signed URL**: the
application, which *does* know who the caller is, generates a
time-limited URL carrying a signature the storage layer verifies, so the
storage tier itself stays dumb — it checks the signature and expiry, not
the caller's identity. This keeps the origin-offload benefit (the bytes
still stream directly from storage, no app compute in the data path)
while restoring access control. It's the same idea as the
[Valet Key](/docs/patterns/api-edge/valet-key) pattern: hand the client a
narrow, expiring token that grants direct access to one specific object.

**Static Content Hosting vs. CDN vs. Blob Store.** These three are
adjacent and easy to conflate. A [blob
store](/docs/patterns/building-blocks/blob-store) is the general-purpose
object storage primitive — put and get opaque bytes by key, with no
notion of "web asset." Static content hosting is a *usage pattern* on top
of storage: it's about *serving web assets directly from that storage*,
adding the web-facing concerns (content types, cache headers, a default
document, HTTPS) that plain blob `get` doesn't imply. A
[CDN](/docs/patterns/building-blocks/cdn) is the *edge-caching layer* that
sits in front of whatever origin serves the assets. Put plainly: the blob
store is *where the bytes are stored*, static content hosting is *the
decision to serve web assets straight from storage instead of through app
servers*, and the CDN is *the layer that caches those served assets close
to users*. The three commonly stack — assets in a blob store, exposed via
static hosting, fronted by a CDN — but each answers a different question.

## Code example

The snippet below models two of the pattern's real decisions: the
`Cache-Control` header a static host emits per asset (immutable for
fingerprinted public files, conservative for the rest), and the signed,
expiring URL that grants direct access to a *private* static asset
without any application code in the data path.

```rust
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

// Whether an asset is public (cacheable by anyone, immutable) or private
// (must be authorized per-request via a signed, expiring URL).
enum Visibility {
    Public,
    Private,
}

struct Asset {
    key: String,
    visibility: Visibility,
    // Set for fingerprinted build artifacts like `app.4f9a1c.js`; these can
    // be cached forever because the URL changes whenever the bytes change.
    fingerprinted: bool,
}

// The Cache-Control header a static host emits per asset. Fingerprinted
// public assets get `immutable` + a one-year max-age; everything else gets
// a conservative TTL so an update is picked up within the window.
fn cache_control(asset: &Asset) -> &'static str {
    match (&asset.visibility, asset.fingerprinted) {
        (Visibility::Public, true) => "public, max-age=31536000, immutable",
        (Visibility::Public, false) => "public, max-age=300",
        (Visibility::Private, _) => "private, no-store",
    }
}

// A private asset is served only through a signed URL: the host appends an
// expiry and a signature bound to the key, and refuses a request whose
// signature or clock don't check out. (Real systems use HMAC; a hash stands
// in here so the example stays std-only.)
fn sign_url(secret: u64, key: &str, expires_at: u64) -> String {
    let mut h = DefaultHasher::new();
    secret.hash(&mut h);
    key.hash(&mut h);
    expires_at.hash(&mut h);
    format!("/{key}?expires={expires_at}&sig={:x}", h.finish())
}

fn verify(secret: u64, key: &str, expires_at: u64, sig: u64, now: u64) -> bool {
    if now >= expires_at {
        return false; // link has expired
    }
    let mut h = DefaultHasher::new();
    secret.hash(&mut h);
    key.hash(&mut h);
    expires_at.hash(&mut h);
    h.finish() == sig
}
```

`cache_control` is the header logic that makes fingerprinted assets
cacheable for a year while keeping the mutable entry point fresh; the
`sign_url` / `verify` pair is how a private static asset is served
directly from storage — the storage tier verifies the signature and
expiry rather than the caller's identity, so no application compute sits
in the byte-serving path even for access-controlled files.

## When to use it

- Serving a single-page application's build output, marketing pages, or
  any HTML/CSS/JS/image assets that are identical for every requester.
- The assets are produced by a build step and are effectively immutable
  once published, making them safe to cache aggressively.
- Application server capacity is being spent on requests that carry no
  per-user logic — a clear sign those requests belong on a static tier
  instead.

## When not to use it

- The "static" file actually needs to vary per request — per-user
  content, server-side personalization, or anything requiring
  authentication checks before the bytes can be returned isn't a fit
  for a plain static host.
- Content changes so frequently, or needs such tight write-then-read
  consistency, that treating it as a build artifact pushed to storage
  doesn't match how it's actually produced.

## Use-case scenarios

**Single-page application bundle.** A SPA's compiled output —
`index.html` plus hashed `app.<hash>.js` and `styles.<hash>.css` — is
uploaded to an object store configured for static website hosting and
fronted by a CDN. The hashed assets are served `immutable` and answered
from the edge cache indefinitely; `index.html` gets a short TTL so a new
deploy is picked up promptly, at which point it references the new hashed
filenames and the browser fetches those fresh. The application's API
servers only ever see `/api/*` calls, never a request for the JavaScript
bundle itself.

**Marketing site and documentation.** A company's public marketing pages
and docs are generated by a static site generator into flat HTML, CSS,
and images, then published to a static host behind a CDN. There is no
application server in the request path for these pages at all — the
entire site is build artifacts on storage — which makes it trivially
cheap to serve, effortless to scale to a traffic spike (it's all cache
hits at the edge), and resilient (a page keeps serving from cache even if
the origin storage is briefly unavailable).

**Private user downloads via signed URLs.** A SaaS product lets each
customer download their own invoices and exported reports — static files
that must not be readable by other customers. The files live in a private
bucket with no public access; when a user clicks "download," the
application generates a short-lived signed URL for exactly that object,
and the browser fetches the bytes straight from storage using that URL.
The origin-offload benefit is fully preserved — no application compute
streams the file — while access control is enforced by the signature and
expiry the storage layer checks, the same narrow-token idea as the
[Valet Key](/docs/patterns/api-edge/valet-key) pattern.

## Production libraries & getting started

You either self-host a static web server or, more commonly, hand assets to a managed platform (object store + CDN, or a Jamstack host) that does the serving, caching, and TLS for you.

Self-hosted web servers:

| Tool | What it gives you | Getting started |
| --- | --- | --- |
| Nginx | High-performance static file serving and reverse proxy | [Nginx beginner's guide](https://nginx.org/en/docs/beginners_guide.html) |
| Caddy | Static file server with automatic HTTPS | [Caddy: serve static files](https://caddyserver.com/docs/quick-starts/static-files) |

Managed hosting platforms:

| Platform | What it gives you | Getting started |
| --- | --- | --- |
| Amazon S3 + CloudFront | Object-store hosting fronted by a global CDN | [S3 static website hosting](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html) |
| Netlify | Git-driven build + deploy for static/Jamstack sites | [Netlify get started](https://docs.netlify.com/get-started/) |
| Vercel | Static + frontend framework hosting with edge network | [Vercel getting started](https://vercel.com/docs/getting-started-with-vercel) |
| Cloudflare Pages | Static hosting on Cloudflare's edge | [Cloudflare Pages get started](https://developers.cloudflare.com/pages/get-started/) |
| GitHub Pages | Free static hosting straight from a repo | [GitHub Pages getting started](https://docs.github.com/en/pages/getting-started-with-github-pages) |

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — the
  general-purpose object storage primitive static content hosting is
  built on top of; the blob store is *where the bytes live*, static
  hosting is *the decision to serve web assets straight from it*.
- [CDN](/docs/patterns/building-blocks/cdn) — the edge-caching layer that
  pairs naturally in front of a static host to push assets even closer to
  users; a CDN caches what a static host serves.
- [Valet Key](/docs/patterns/api-edge/valet-key) — the pattern behind
  signed URLs for private assets: hand the client a narrow, expiring
  token that grants direct access to one specific object without routing
  the bytes through application compute.

## Further reading

- [Static web page — Wikipedia](https://en.wikipedia.org/wiki/Static_web_page)
- [Amazon S3 static website hosting — AWS documentation](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html)
- [Cache-Control — MDN Web Docs](https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control)
- [Serving private content with signed URLs — Amazon CloudFront documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PrivateContent.html)
