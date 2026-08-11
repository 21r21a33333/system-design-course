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

## How it works

At build or deploy time, static assets are pushed to a [blob
store](/docs/patterns/building-blocks/blob-store) or a purpose-built
static hosting service, each file addressable by its path as a key. A
client requesting `/assets/app.js` is routed straight to that storage
layer rather than to the application's compute tier, so the file is
served with no application code running at all — no routing logic
beyond "does this key exist," no middleware, no server-side rendering.
Because the files are immutable once published (a new deploy uploads
new files, typically under new, content-hashed names, rather than
overwriting the old ones in place), they're maximally cacheable: a
[CDN](/docs/patterns/building-blocks/cdn) sitting in front of the static host can cache
each asset at edge locations close to users and serve the overwhelming
majority of requests without ever reaching the origin storage after the
first request for a given file. The application server is left to
handle only what actually needs it — API calls, form submissions,
anything personalized or stateful — while the static tier absorbs
every request for assets that would otherwise have queued up behind
that same compute.

## Code example

The snippet below models the routing decision at the edge: a request is
classified as static or dynamic, and only dynamic requests reach
application compute.

```rust
enum Destination {
    StaticHost,
    AppServer,
}

struct Request {
    path: String,
}

// Extensions handled directly by the static host / CDN — never reach
// application compute.
const STATIC_EXTENSIONS: [&str; 5] = ["html", "js", "css", "png", "svg"];

fn route(req: &Request) -> Destination {
    let ext = req.path.rsplit('.').next().unwrap_or("");
    if STATIC_EXTENSIONS.contains(&ext) {
        Destination::StaticHost
    } else {
        Destination::AppServer
    }
}

fn handle(req: &Request) -> String {
    match route(req) {
        // Flat key lookup against object storage — no app code runs.
        Destination::StaticHost => format!("serve bytes for key: {}", req.path),
        // Only requests that actually need logic reach the app tier.
        Destination::AppServer => format!("run application logic for: {}", req.path),
    }
}
```

`route` is the decision a CDN or reverse proxy makes on every request;
in production this classification happens by URL pattern or file
extension at the edge, well before anything resembling `handle`'s
`AppServer` branch ever executes.

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

## Real-world example

A single-page application's compiled bundle (`index.html`, hashed
`app.<hash>.js`, `styles.<hash>.css`) is uploaded to an S3 bucket
configured for static website hosting, fronted by a CDN like CloudFront.
Every asset request is served from the edge cache; the application's
API servers only ever see calls to `/api/*`, never requests for the
JavaScript bundle itself.

## Related patterns

- [Blob Store](/docs/patterns/building-blocks/blob-store) — the storage
  layer static content hosting is typically built on top of.
- [CDN](/docs/patterns/building-blocks/cdn) — the pattern covering caching and
  distributing content at the edge, which pairs naturally in front of a
  static host to push assets even closer to users.

## Further reading

- [Static web page — Wikipedia](https://en.wikipedia.org/wiki/Static_web_page)
- [Amazon S3 static website hosting — AWS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html)
