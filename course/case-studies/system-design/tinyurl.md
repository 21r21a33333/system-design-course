---
title: "Design TinyURL (a URL Shortening Service)"
sidebar_position: 16
---

A URL shortener looks trivial — map a short code to a long URL — until the scale numbers force two real engineering problems into the open: generating short codes that never collide without a global lock slowing down every write, and serving redirects fast enough that the shortener is never the reason a click feels slow.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design a URL Shortening Service/TinyURL" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** submits a long URL and receives a short code/URL
* **User** (or anyone on the internet) visits a short URL and is redirected to the original long URL
* **User** optionally supplies a custom alias instead of a generated code
* **User** optionally sets an expiration for a short link
* **Service** tracks basic click counts per short link
* **Service** has high availability; a redirect failing is a broken link from the perspective of everyone who shared it, which is a worse failure mode than most systems' downtime

#### Out of scope

* User accounts, login, and per-user link management dashboards
* Detailed click analytics (referrer, geography, device breakdowns) beyond a raw count
* Spam/malicious-URL detection beyond a passing mention
* Editing a short link's destination after creation (this design treats a short code's mapping as immutable once created, aside from expiration)

### Constraints and assumptions

#### State assumptions

* 500 million new short links created per year, and — the number that actually shapes this design — every one of those links can be clicked repeatedly, for years, by anyone with the link
* Assume a **100:1 read-to-write ratio**: redirects vastly outnumber creations, since a single shared short link (a social post, a text message, a printed QR code) can be clicked thousands of times over its life
* A redirect needs to feel instantaneous — this is on the critical path of someone else's click, often with no visual feedback that anything is happening, so added latency here is maximally noticeable
* Short codes must never collide — two different long URLs must never resolve from the same short code — and this guarantee must hold under concurrent creation from many servers at once, not just from a single writer
* Once created, a mapping from short code to long URL is immutable (aside from expiration/deletion); this is a system that's easy to make eventually consistent on read freshness of click counts, but the code-to-URL mapping itself must be correct on the very first read after creation, with no tolerance for "resolves to the wrong URL," ever
* A reasonable short code length is fixed in advance (this design uses 7 characters) rather than growing over time

#### Calculate usage

* Write volume: 500,000,000 links/year → 500,000,000 / (365 × 86,400) ≈ **~16 writes/sec average**, low enough that write throughput is never the bottleneck in this design — the interesting write-side problem is correctness (no collisions) under concurrency, not raw throughput
* Read volume: applying the 100:1 ratio to the write rate gives **~1,600 redirects/sec average**, peakier around whatever drives link sharing (a viral post, a marketing campaign) — design for at least **~10x average at peak**, so **~16,000 redirects/sec**
* Code space: using `[a-zA-Z0-9]` (62 characters) at 7 characters gives 62^7 ≈ **~3.5 trillion possible codes** — at 500 million new links/year, exhausting this space would take roughly 7,000 years at the current creation rate, so 7 characters is comfortably sized with a lot of headroom, not a tightly-fit number
* Mapping storage: a mapping record (`short_code` 7 bytes, `long_url` — assume an average of 100 bytes, generous for most URLs but some are long — `created_at` 8 bytes, `expires_at` 8 bytes, `click_count` 8 bytes) ≈ **~130 bytes/record** → 500,000,000/year × 130 bytes ≈ **~65 GB/year** of mapping data — small enough on its own that the entire dataset could plausibly fit on a single well-provisioned machine after a few years, meaning storage volume itself is never the driver of this design's architecture; **read latency and throughput under concurrency are**
* Click count updates: 1,600 writes/sec average just to increment counts (before considering the redirect itself), rising to the same ~16,000/sec peak as reads — a much higher-frequency write path than link creation, and one that shouldn't be allowed to add latency to the redirect it's counting

## Step 2: Create a high-level design

![TinyURL high-level architecture](/img/case-studies/tinyurl-overview.svg)

A **shortening service** handles link creation: given a long URL (and optionally a custom alias), it obtains a unique short code and writes the mapping to a durable **mapping store**. A **redirect service** handles the vastly higher-volume read path: given a short code, it resolves the mapping and issues an HTTP redirect to the original URL. Both sit behind a **code generator** — a component specifically responsible for handing out short codes that are guaranteed unique without requiring a global lock or a "check if it exists, then insert" race on every single creation. Click counting is deliberately kept off the redirect's critical path, recorded asynchronously so that counting a click never adds latency to the redirect itself.

The read/write asymmetry here (roughly 100:1, and considerably higher for individual popular links) is extreme even by this course's other read-heavy case studies' standards, and it shapes the design in a specific way: because a mapping is immutable once created and reads vastly dominate, the redirect path is almost entirely a caching and fast-lookup problem, while the creation path's hard problem is entirely about correctness under concurrency, not about handling high write volume — the two paths have almost nothing in common architecturally despite sharing one mapping store.

## Step 3: Design core components

### Use case: User submits a long URL and gets a short code

The core question here is how to generate a short code that's guaranteed collision-free without serializing every creation through a single point. Two broad approaches, with real tradeoffs:

**Hash-and-truncate:** derive a code from a hash of the long URL (and perhaps a timestamp or random salt, so re-shortening the same URL twice can still yield different codes if desired), truncated to the target length. This is simple and needs no coordination between servers, but truncating a hash to 7 characters means collisions are possible — different inputs can hash to the same short code — and the service has to detect that (a lookup against the mapping store before committing the write) and handle it (retry with a different salt), which reintroduces a check-then-write pattern that's awkward to make race-free under concurrent creation of the same collision.

**Pre-generated unique ID range, encoded to a short code:** a **code generator** component hands out globally unique numeric IDs — for instance, by giving each application server a reserved range of IDs to allocate from locally before requesting a new range, so no two servers ever hand out the same ID without needing to coordinate on every single request, similar in spirit to how Twitter's real-world Snowflake ID scheme generates unique IDs across many machines without a per-request coordination step — and each ID is deterministically encoded (base-62, using the 7-character alphabet from Step 1's math) into a short code. This guarantees uniqueness by construction: since the underlying IDs are unique and the encoding is a deterministic one-to-one function, no collision-detection step is ever needed on the write path. The tradeoff is operational complexity (something has to durably track which ID ranges have been allocated to which server, and survive a server crashing mid-range without losing or double-issuing IDs) in exchange for removing collision-checking entirely from the hot path.

This design favors the second approach specifically because it turns "avoid collisions" from a per-request runtime check into a property that's true by construction — which matters more here than it might elsewhere, because a collision in this system isn't a retryable failure, it's silent data corruption (URL A's short link starts resolving to URL B). Range allocation itself is infrequent (a server requests a new range only after exhausting its current one, not per creation), so the coordination cost is amortized across potentially thousands of ID allocations per range request, keeping the write path's steady-state cost low despite the low absolute write volume this design already established isn't the bottleneck.

Custom aliases are the one case that still needs a uniqueness check against the mapping store, since a user-supplied alias isn't drawn from the generator's guaranteed-unique ID space — but custom aliases are a small fraction of total creations, so a conditional write (insert only if the alias doesn't already exist) on that minority path doesn't threaten the throughput of the generated-code majority path. See [Idempotency](/docs/patterns/reliability/idempotency) for the general shape of making a write safe to retry without double-applying it, relevant here if a client retries a creation request after a timeout.

### Use case: User visits a short URL and is redirected

* The **redirect service** receives the short code, looks up the corresponding long URL, and returns an HTTP redirect
* Because the mapping is immutable once created, this lookup has none of the freshness concerns most read paths in this course worry about — a cached mapping is never stale in a way that matters, since the underlying data can't change (aside from expiration, discussed below)

This immutability is what makes the redirect path almost entirely a caching problem: once a mapping is read once, it can be cached aggressively and indefinitely (until expiration) with no invalidation logic needed beyond a TTL, which is a meaningfully simpler caching story than most of this course's other read-heavy systems have to deal with, since none of them get to assume the underlying data never changes. See [Cache-Aside](/docs/patterns/caching/cache-aside) and [Read-Through](/docs/patterns/caching/read-through) for the general mechanism — a redirect for a popular link is served from cache essentially every time after its first request, and only genuinely long-tail, rarely-clicked links ever touch the durable mapping store repeatedly.

One design choice worth being explicit about: an HTTP redirect can be issued as a permanent (301) or temporary (302) response. A 301 lets browsers and intermediate caches remember the redirect themselves, reducing load on this system even further on repeat visits from the same client — but it also means this service loses visibility into those repeat clicks for the click-counting use case, since a browser that's cached a 301 may never ask again. A 302 keeps every click visible to the service (better for accurate counts) at the cost of not benefiting from client-side caching. This design uses 302 specifically because Step 1 scopes in click counting as a real use case, which makes counting accuracy worth the extra requests.

### Use case: Service tracks click counts

Incrementing a durable counter synchronously on every redirect would add a write, and its latency, to the critical path of a redirect that's supposed to be as fast as possible — directly working against the "redirect must feel instantaneous" constraint from Step 1. Instead, the redirect service fires an asynchronous "click happened" event and returns the redirect immediately, without waiting for that event to be durably counted — see [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture). A separate counting path consumes those events and updates `click_count` for the corresponding short code, similar in shape to the incremental-aggregate approach this course's Yelp case study uses for rating counts, though here the write pattern is even more skewed toward a small number of very popular links receiving the overwhelming majority of click events — which makes a [Sharded Counter](/docs/patterns/building-blocks/sharded-counters)-style approach worth applying specifically to whichever short codes are currently receiving high click volume, rather than uniformly to every code, since most codes never get anywhere near enough traffic to need it.

### Use case: Link expiration

Expired links need to stop resolving without requiring every redirect to run an expensive expiration check against a slow path. Because `expires_at` is stored alongside the mapping and read as part of the same cached lookup the redirect path already does, checking it costs nothing extra on the read path — the redirect service just also checks whether the fetched record's `expires_at` has passed before honoring it. Actually reclaiming the short code and freeing it for reuse (if a design decision is made to allow that) is a separate, lower-urgency background sweep over expired records, not something that needs to happen synchronously at the moment of expiration.

## Step 4: Scale the design

![TinyURL scaled architecture](/img/case-studies/tinyurl-scaled.svg)

**The redirect path is almost entirely solved by aggressive caching, given the mapping's immutability.** A [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) (Redis or Memcached are the two systems most commonly reached for here) sized to hold the working set of currently-popular links absorbs the overwhelming majority of the ~16,000 redirects/sec peak this design calculated, leaving only cold, long-tail lookups to reach the durable mapping store — a much larger cache hit-rate ceiling than most systems get to assume, precisely because there's no invalidation problem to fight, only a TTL/eviction one.

**The mapping store scales by sharding on short code**, which distributes evenly by construction if codes come from the sequential-range generator in Step 3 spread across a hash-like encoding — see [Sharding](/docs/patterns/storage/sharding) and [Consistent Hashing](/docs/patterns/storage/consistent-hashing) for keeping shard rebalancing proportional to what actually changed rather than triggering a wholesale remap when capacity is added. Because writes are low-volume (~16/sec average) relative to what any single shard can handle, sharding here is driven far more by total dataset size and read fan-out than by write throughput.

**The code generator's range-allocation coordination is a small, infrequent, and isolated hot spot — worth designing carefully precisely because it's the one place correctness (no duplicate ranges ever handed out) matters more than throughput.** Because each application server only contacts the generator when it exhausts its current range (not per creation), the generator's own request volume is orders of magnitude below the creation rate, making it a natural candidate for a simple, strongly-consistent design even while the rest of the system optimizes for read throughput — see [Idempotency](/docs/patterns/reliability/idempotency) for making a range request safe to retry if a server crashes mid-request without ending up with two servers believing they own the same range.

**Redirect service instances are stateless and scale horizontally behind a standard load-balanced edge tier**, since all state (the mapping, the cache) lives in shared backing stores rather than any individual server — see [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) and [Load Balancing](/docs/patterns/api-edge/load-balancing). This is the least novel part of this design, deliberately: the interesting engineering budget here goes into code generation correctness and redirect caching, not into the request-routing tier.

## Additional talking points

* **How this design's hard problem differs from this course's Pastebin case study, despite both being "short link to something" systems.** Pastebin's central design tension is storing and serving a variable-sized *content body* (the paste text itself) — a hash-table-like lookup layered on top of a large-object storage concern, where the object being stored can range from trivial to substantial in size. TinyURL's mapping value is always just a URL string — trivially small, uniform in size, and never the bottleneck. TinyURL's actual hard problems are generating collision-free codes under concurrent writes from many servers, and serving redirects at very high read volume with sub-second latency expectations from *someone else's* click — neither of which meaningfully applies to Pastebin, where write volume and content size, not code generation or redirect latency, are the pressure points.
* **Why not just use the full hash as the short code instead of truncating or generating a separate ID?** A full hash (say, 32+ hex characters) is unique enough to avoid collisions on its own, but defeats the entire purpose of a *short* URL — the length constraint is the whole point of the product, which is exactly why this design accepts the extra engineering complexity of a dedicated code generator rather than sidestepping collisions by simply using a longer code.
* **Malicious or spam URLs.** Out of scope to design in depth, but worth naming: a shortener that redirects blindly is an attractive vector for disguising malicious links, and a production system would need some check (a blocklist, a reputation service) in the creation path — which would add latency and complexity specifically to the write path this design otherwise keeps deliberately simple.
* **Custom aliases and the vanity-URL tension.** Allowing user-chosen aliases reintroduces exactly the collision-checking cost the generated-code path was designed to avoid, and a popular alias namespace (short, memorable words) can be contested — worth a brief mention of reserving or auctioning particularly desirable aliases as a product question, not an infrastructure one.
