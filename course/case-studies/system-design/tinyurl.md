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

The hard problem: generate a short code that's guaranteed collision-free, without serializing every creation through a single lock.

**Core algorithm: range-based ID allocation + base-62 encoding**

```
# Each app server, on startup or when its local range is exhausted:
1. request_range(server_id) -> (range_start, range_end)
   # a coordinator hands out non-overlapping ranges, durably recorded
   # so a crash mid-range never re-issues an already-owned range
2. next_id = pop next unused integer from [range_start, range_end)
   # purely local after this point — no network call per creation

# Encoding, once an id is obtained:
function base62_encode(num):
    digits = []
    alphabet = "0-9a-zA-Z"          # 62 symbols
    while num > 0:
        digits.push(alphabet[num % 62])
        num = num // 62
    return reverse(digits).left_pad_to(7)   # fixed 7-char code
```

Because the underlying integer IDs are unique by construction and the encoding is a deterministic one-to-one function, **no collision-detection step ever runs on the write path** — this is the entire point of choosing this algorithm over hash-and-truncate (hash a URL, truncate to 7 chars, then have to detect and retry on collision).

**Data structures:**
* `id_ranges` (coordinator-owned table) — `server_id`, `range_start`, `range_end`, `allocated_at`
* `mappings` (main store) — `short_code` (PK), `long_url`, `created_at`, `expires_at`, `click_count`

**Trade-offs:**
* **The gotcha:** hash-and-truncate is the answer most candidates reach for first, and it's the wrong one at scale — truncating a hash to 7 characters makes collisions *inevitable* (not just possible) once enough codes exist, which reintroduces a check-then-write race under concurrent creation. Range-based allocation sidesteps this entirely by making uniqueness a property of construction, not a runtime check — this is the specific decision that separates a working design from a design that silently corrupts data under load.
* Range allocation adds one piece of durable coordination state (who owns which range), but it's requested only when a server's local range runs out — not per creation — so its request volume is orders of magnitude below the write rate.
* Custom aliases don't come from the generator's ID space, so they're the one write path that still needs a uniqueness check (insert-if-absent against `mappings`) — a small minority of total creations, so it doesn't threaten the generated-code majority path's throughput. See [Idempotency](/docs/patterns/reliability/idempotency) for making that write safe to retry after a timeout.

See: [Snowflake ID](https://en.wikipedia.org/wiki/Snowflake_ID) for a real-world distributed unique-ID scheme built on this same "coordinate rarely, generate locally" shape, and [Base 62 encoding explained](https://www.kerstner.at/2012/07/shortening-strings-using-base-62-encoding/) for the encoding step's mechanics.

**REST API:**

```
$ curl -X POST https://tinyurl.example/api/v1/links \
    -d '{"long_url": "https://example.com/some/very/long/path", "custom_alias": null, "expires_in_days": 30}'
```

Response:

```json
{
  "short_code": "aZ3kP9x",
  "short_url": "https://tny.co/aZ3kP9x",
  "long_url": "https://example.com/some/very/long/path",
  "expires_at": "2026-09-10T00:00:00Z"
}
```

### Use case: User visits a short URL and is redirected

**Core mechanism: cache-first lookup on an immutable key**

* `redirect_service.handle(short_code)`:
  1. Look up `short_code` in cache → hit: return cached `long_url` (see below for status code choice)
  2. Miss → look up in `mappings` store, populate cache, return

**Data structures:** same `mappings` record as above; cache keyed by `short_code`.

**Trade-offs:**
* **The gotcha:** the 301-vs-302 choice looks cosmetic but isn't — a 301 lets browsers cache the redirect client-side, which is *more* efficient but silently breaks click counting, since a browser holding a cached 301 may never ask this service again. A 302 costs more requests but keeps every click visible. This design uses **302**, specifically because Step 1 scopes in click counting as a real requirement — picking 301 "for performance" without checking that constraint is the classic version of this mistake.
* Mapping is immutable once created (aside from expiration) → once cached, a value is never stale, so caching here is a pure TTL/eviction problem with no invalidation logic — see [Cache-Aside](/docs/patterns/caching/cache-aside) and [Read-Through](/docs/patterns/caching/read-through).

See: [HTTP 301](https://en.wikipedia.org/wiki/HTTP_301) vs. [HTTP 302](https://en.wikipedia.org/wiki/HTTP_302) for the formal semantics of each status code.

**REST API:**

```
$ curl -i https://tny.co/aZ3kP9x
```

Response:

```
HTTP/1.1 302 Found
Location: https://example.com/some/very/long/path
```

### Use case: Service tracks click counts

**Core mechanism: async increment against a sharded counter, off the redirect's critical path**

```python
import random

class ClickCounter:
    """Sharded counter: a hot code's count is spread across N shards to
    avoid every click on a viral link serializing on one row's lock.
    """
    SHARDS_PER_KEY = 10

    def __init__(self, store):
        self.store = store  # key: (short_code, shard_id) -> count

    def record_click(self, short_code):
        # Pick a random shard for this write — spreads contention across
        # SHARDS_PER_KEY rows instead of hammering one.
        shard_id = random.randint(0, self.SHARDS_PER_KEY - 1)
        self.store.increment((short_code, shard_id))

    def total_clicks(self, short_code):
        # Reads are rare (an analytics dashboard, not the hot path) so
        # summing shards at read time is the right trade: writes stay
        # cheap and uncontended, at the cost of a fan-out read.
        return sum(
            self.store.get((short_code, shard_id)) or 0
            for shard_id in range(self.SHARDS_PER_KEY)
        )
```

* Redirect service emits a `click_happened` event and returns immediately — does *not* wait for the count to be durably written. See [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture).
* A separate consumer processes `click_happened` events and calls `record_click`.

**Data structures:** `click_counts` keyed by `(short_code, shard_id)` — a wide, sparse table rather than one row per `short_code`.

**Trade-offs:**
* **The gotcha:** a single `UPDATE clicks SET count = count + 1 WHERE short_code = X` looks correct and is correct — right up until one link goes viral and every click serializes on that one row's lock. Sharding the counter is what keeps a single hot link from becoming a write bottleneck for the whole system; see [Sharded Counter](/docs/patterns/building-blocks/sharded-counters).
* Most codes never get enough traffic to need sharding at all — `SHARDS_PER_KEY = 10` is a fixed cost paid on every code for the benefit of the rare hot ones; an adaptive scheme (shard only once a code crosses a traffic threshold) trades implementation complexity for avoiding that fixed cost on the long tail.
* Similar shape to this course's Yelp case study incrementally aggregating rating counts, but here the traffic skew toward a handful of hot keys is more extreme.

### Use case: Link expiration

**Core mechanism: piggyback the check on the existing cached read**

```python
def resolve(short_code, mappings_store, cache, now):
    record = cache.get(short_code) or mappings_store.get(short_code)
    if record is None:
        return None  # unknown code
    if record.expires_at is not None and record.expires_at <= now:
        return None  # expired: treat identically to "not found"
    return record.long_url
```

**Data structures:** reuses the `mappings` record's existing `expires_at` field — no new storage.

**Trade-offs:**
* Checking `expires_at` costs nothing extra on the read path since it's already part of the record the redirect handler fetches — no separate lookup, no separate service.
* Actually reclaiming an expired code (freeing it for reuse) is a separate, lower-urgency background sweep — not something that needs to happen synchronously at expiration time, and not something the hot redirect path should ever wait on.

## Step 4: Scale the design

![TinyURL scaled architecture](/img/case-studies/tinyurl-scaled.svg)

* **Redirect path — caching.** A [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) (Redis or Memcached) sized to hold the working set of popular links absorbs the overwhelming majority of the ~16,000 redirects/sec peak, leaving only cold, long-tail lookups to hit the durable mapping store. Immutability means no invalidation logic — TTL/eviction only.
* **Mapping store — sharding.** Shards evenly by construction if codes come from the sequential-range generator spread across a hash-like encoding. See [Sharding](/docs/patterns/storage/sharding) and [Consistent Hashing](/docs/patterns/storage/consistent-hashing) for rebalancing proportional to what actually changed. Driven by dataset size and read fan-out, not write throughput (~16/sec average is trivial for any single shard).
* **Code generator — isolated, low-volume, strongly-consistent.** Each server only contacts it on range exhaustion, not per creation, so its request volume is orders of magnitude below the creation rate — a natural candidate for a simple, strongly-consistent design even while the rest of the system optimizes for throughput. See [Idempotency](/docs/patterns/reliability/idempotency) for making a range request safe to retry after a crash without two servers believing they own the same range.
* **Redirect service — stateless horizontal scaling.** All state lives in the cache/mapping store, not on any instance, so it scales behind a standard load-balanced edge tier. See [Horizontal Scaling](/docs/patterns/scaling/horizontal-scaling) and [Load Balancing](/docs/patterns/api-edge/load-balancing). Deliberately the least novel part of this design — the engineering budget goes into code-generation correctness and redirect caching, not the routing tier.

## Additional talking points

* **How this design's hard problem differs from this course's Pastebin case study, despite both being "short link to something" systems.** Pastebin's central design tension is storing and serving a variable-sized *content body* (the paste text itself) — a hash-table-like lookup layered on top of a large-object storage concern, where the object being stored can range from trivial to substantial in size. TinyURL's mapping value is always just a URL string — trivially small, uniform in size, and never the bottleneck. TinyURL's actual hard problems are generating collision-free codes under concurrent writes from many servers, and serving redirects at very high read volume with sub-second latency expectations from *someone else's* click — neither of which meaningfully applies to Pastebin, where write volume and content size, not code generation or redirect latency, are the pressure points.
* **Why not just use the full hash as the short code instead of truncating or generating a separate ID?** A full hash (say, 32+ hex characters) is unique enough to avoid collisions on its own, but defeats the entire purpose of a *short* URL — the length constraint is the whole point of the product, which is exactly why this design accepts the extra engineering complexity of a dedicated code generator rather than sidestepping collisions by simply using a longer code.
* **Malicious or spam URLs.** Out of scope to design in depth, but worth naming: a shortener that redirects blindly is an attractive vector for disguising malicious links, and a production system would need some check (a blocklist, a reputation service) in the creation path — which would add latency and complexity specifically to the write path this design otherwise keeps deliberately simple.
* **Custom aliases and the vanity-URL tension.** Allowing user-chosen aliases reintroduces exactly the collision-checking cost the generated-code path was designed to avoid, and a popular alias namespace (short, memorable words) can be contested — worth a brief mention of reserving or auctioning particularly desirable aliases as a product question, not an infrastructure one.

## Source(s) and further reading

* [URL shortening — Wikipedia](https://en.wikipedia.org/wiki/URL_shortening)
* [Snowflake ID](https://en.wikipedia.org/wiki/Snowflake_ID) — a real-world distributed unique-ID scheme built on the same "coordinate rarely, generate locally" shape as this design's code generator
* [Ticket Servers: Distributed Unique Primary Keys on the Cheap — Flickr Engineering](https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/) — a real production write-up of the range-allocation idea this design's code generator is built on
* [Base 62 encoding explained](https://www.kerstner.at/2012/07/shortening-strings-using-base-62-encoding/)
* [HTTP 301](https://en.wikipedia.org/wiki/HTTP_301) vs. [HTTP 302](https://en.wikipedia.org/wiki/HTTP_302)
