---
title: "CDN (Content Delivery Network)"
sidebar_position: 16
supplementary: true
---

A content delivery network (CDN) is a geographically distributed set
of caching servers that store copies of content close to end users, so
that a request for that content can be answered from a nearby edge
location instead of traveling all the way back to the origin that
produced it.

![CDN diagram](/img/patterns/cdn.svg)

## Problem it solves

Network latency has a hard physical floor set by the speed of light
and the number of network hops a request has to cross, and that floor
gets worse the farther a request has to travel — a user in Singapore
requesting content from an origin server in Virginia pays that
distance in latency on every single request, no matter how fast the
origin itself responds. Serving every user in the world from one
origin location also concentrates all read load onto that one
location's infrastructure, regardless of how far any given requester
is from it. A CDN addresses both at once: by keeping cached copies of
content at many points of presence spread around the world, a user's
request is answered by whichever point of presence is physically
closest to them, cutting the network distance (and therefore latency)
dramatically, while simultaneously removing that request from the
origin's load entirely — the origin only has to serve a given piece of
content once per point of presence, not once per end user.

## Technical architecture & implementation

**Points of presence and request routing.** A CDN operates many edge
locations ("points of presence") distributed across geographic
regions, each capable of caching and serving content independently.
When a request comes in, the CDN's routing layer — commonly DNS-based,
resolving a hostname to the IP of a nearby edge location based on the
requester's approximate location, though anycast routing at the
network layer is also used — directs it to whichever point of presence
can serve it fastest, without the requesting client needing to know
anything about the CDN's internal topology; from the client's
perspective, it's still just making a normal request to a single
hostname. Cloudflare and Amazon CloudFront are two widely used
commercial CDNs that illustrate the anycast and DNS-based approaches
respectively: Cloudflare routes much of its edge traffic via anycast,
where the same IP address is announced from many points of presence
and ordinary internet routing sends a request to the topologically
nearest one, while CloudFront relies more directly on DNS resolution
to steer a request to a nearby edge location.

**Push vs. pull population.** Content gets onto edge locations one of
two ways, and the choice trades storage cost against first-request
latency. With a **push** model, the origin proactively uploads content
to the CDN whenever it's created or changed — the origin owns the
timing and the CDN never has to fetch on demand — which suits content
that changes infrequently and where every byte pushed is expected to
actually be requested later. With a **pull** model, an edge location
only fetches content from the origin the first time a nearby user
requests it, caching it locally for subsequent requests and letting
it expire per a configured time-to-live; storage is used only for
content that's actually been requested, at the cost of the very first
request at each edge location paying the full origin round-trip before
the content is cached there.

**Cache invalidation and staleness.** Every cached copy is a snapshot
that can drift from the origin's current state the moment the origin
changes, and a CDN has to reconcile that against not re-fetching on
every single request, which would defeat the purpose. The standard
mechanism is a time-to-live per object: content is served from cache
without contacting the origin until its TTL expires, after which the
next request triggers a fresh fetch. This means a CDN inherently
trades some staleness window for its latency and load benefits — a
change at the origin isn't instantly visible everywhere, and content
that changes faster than its TTL will occasionally be served stale
until it expires or an explicit invalidation (a purge request issued
to the CDN) forces it out early. This is the same fundamental
trade-off that governs any cache, covered more generally on the
[Distributed Cache](/docs/patterns/building-blocks/distributed-cache)
page — a CDN is, structurally, a cache; what's distinctive about it is
that it's distributed geographically to sit close to end users rather
than close to an application's compute.

**What a CDN can serve.** Immutable, identical-for-every-user
content — images, video segments, JavaScript and CSS bundles, any file
that doesn't vary per requester — is the ideal fit, since a single
cached copy at an edge location can correctly answer every nearby
user's request with no per-user logic involved. Content that varies
per user (a personalized page, an authenticated API response) is a
poor fit for a plain cache-by-URL CDN, though some CDNs support
routing dynamic, uncacheable requests through the same edge network
purely for the network-path benefit, without actually caching the
response — a narrower benefit than the caching case, since it saves
network distance but not origin load.

**CDN vs. Static Content Hosting.** These two are adjacent and
frequently deployed together, which makes them easy to conflate, but
they answer different questions. [Static Content
Hosting](/docs/patterns/building-blocks/static-content-hosting) is
about *where a static asset's authoritative copy lives* — pulling
files out of application-server request paths and into storage built
for flat key lookups, so the origin itself is simple and cheap to
serve from. A CDN is about *caching and serving copies* of that
content geographically close to users, layered in front of whatever
origin holds the authoritative copy, static host or otherwise — a CDN
needs an origin to pull from (or push from), and a static host is one
extremely common origin, but the CDN's job is purely about proximity
and cache distribution, not about being the source of truth for the
content in the first place. A static host with no CDN in front of it
still serves every request from one location; a CDN with no static
host behind it can still cache and distribute content whose origin is
a full application server.

## Code example

```rust
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct CachedObject {
    body: String,
    cached_at: Instant,
    ttl: Duration,
}

impl CachedObject {
    fn is_fresh(&self, now: Instant) -> bool {
        now.duration_since(self.cached_at) < self.ttl
    }
}

// One edge location's local cache — a real CDN runs many of these,
// each independent, spread across geographic points of presence.
struct EdgeLocation {
    cache: HashMap<String, CachedObject>,
}

impl EdgeLocation {
    // Pull-model fetch: serve from cache if fresh, otherwise fetch
    // from origin and populate the cache for subsequent requests.
    fn get(&mut self, key: &str, now: Instant, fetch_origin: impl Fn(&str) -> String) -> (String, bool) {
        if let Some(obj) = self.cache.get(key) {
            if obj.is_fresh(now) {
                return (obj.body.clone(), true); // cache hit
            }
        }
        let body = fetch_origin(key);
        self.cache.insert(
            key.to_string(),
            CachedObject { body: body.clone(), cached_at: now, ttl: Duration::from_secs(300) },
        );
        (body, false) // cache miss — origin was contacted
    }

    // An explicit purge forces the next request to re-fetch from
    // origin even if the TTL hasn't expired yet.
    fn purge(&mut self, key: &str) {
        self.cache.remove(key);
    }
}
```

`get` returns whether the response was a cache hit alongside the body
itself — in a real CDN this is exactly the signal exposed as a
cache-status response header, and it's what makes the staleness
trade-off visible: a hit never touches the origin, a miss always does,
and `purge` is the only way to force a miss before the TTL would have
expired it naturally.

## When to use it

- Content is largely static or changes infrequently relative to how
  often it's requested, making it safe to cache for a meaningful
  window without serving noticeably stale data.
- Users are geographically distributed, and network latency to a
  single origin location is a measurable part of overall response
  time for a meaningful fraction of them.
- Origin load from serving the same popular content repeatedly is a
  real capacity concern, and offloading that repeated serving to
  cached edge copies would meaningfully reduce it.

## When not to use it

- Content is highly personalized or must reflect the absolute latest
  state on every single request — a CDN's caching benefit doesn't
  apply, and routing such requests through it (without actually
  caching them) only adds a hop for little gain.
- The user base is concentrated in one geographic region close to the
  origin already — there's little network-distance benefit to
  distributing copies to points of presence nobody is actually near.
- Traffic volume is low enough that origin load was never a real
  concern, and the operational cost (and the staleness window a TTL
  introduces) isn't justified by the marginal latency improvement.

## Use-case scenarios

**Global media streaming platform.** A video platform caches
transcoded video segments at edge locations worldwide, so a viewer's
playback requests are served from a nearby point of presence rather
than crossing continents to the origin on every segment — critical for
video specifically, where sustained low latency and high throughput
directly determine playback quality.

**E-commerce site serving a worldwide customer base.** A retail site
pushes product images, its JavaScript bundle, and CSS to a CDN on
every deploy, so customers anywhere in the world load the visual shell
of the site from a nearby edge location while only the genuinely
dynamic parts — cart contents, personalized recommendations — reach
the origin at all, keeping origin load proportional to actual dynamic
traffic rather than every asset on every page view.

**News site handling a sudden traffic spike.** A news publisher's
article pages are cached at the edge with a short TTL (a few minutes),
which is enough to absorb a sudden viral traffic spike — thousands of
readers requesting the same breaking-news article are served entirely
from cached edge copies, with the origin server only fetched once per
edge location rather than once per reader, at the cost of a
short window where a late correction to the article takes a few
minutes to propagate everywhere.

## Related patterns

- [Static Content Hosting](/docs/patterns/building-blocks/static-content-hosting) —
  about where an asset's authoritative copy lives; a CDN caches and
  distributes copies of that content close to users and commonly sits
  in front of a static host as its origin, but answers a different
  question than the static host does.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  the general caching pattern a CDN is a geographically distributed,
  edge-focused specialization of; the TTL and staleness trade-offs are
  shared with any cache.
- [CDN — concept overview](/docs/concepts/cdn) — this site's earlier
  primer-derived treatment of content delivery networks, for further
  background.

## Further reading

- [Content delivery network — Wikipedia](https://en.wikipedia.org/wiki/Content_delivery_network)
- [What is a CDN? — Amazon CloudFront overview, AWS documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Introduction.html)
- DesignGurus' System Design Patterns course covers this as "CDN" in its The Entry Point (API and Edge) module.
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes CDN as a named topic.
