---
title: "Design Yelp (or a Proximity/Nearby-Search Service)"
sidebar_position: 14
---

A nearby-search service answers a question that sounds simple but isn't cheap at scale: "show me the businesses within a couple of kilometers of here, sorted by distance or rating." The core problem is indexing millions of static points on a map so that query is fast — a spatial-indexing problem, not a routing problem.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design a Proximity Service/Yelp" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** searches for businesses near a location (their current position or a searched address), optionally filtered by category (restaurants, coffee, etc.)
* **User** views a business's detail page — name, address, hours, rating, review count
* **User** leaves a rating and a written review for a business
* **Business owner** creates or updates their business listing (name, location, category, hours)
* **Service** ranks search results by a combination of distance and rating, not distance alone
* **Service** has high availability; search should degrade gracefully rather than fail outright under load

#### Out of scope

* Full-text search over review content (worth a one-line mention; treated as a separate search-index concern, not designed in depth)
* Reservation/waitlist booking flows
* Photo uploads and moderation
* Personalized ranking based on a user's individual history (this design ranks by distance and aggregate rating only)

### Constraints and assumptions

#### State assumptions

* 50 million businesses listed worldwide; business locations change extremely rarely (a listing might update its hours or category occasionally, but its coordinates are essentially static once created)
* 30 million daily active users, each performing an average of 4 nearby searches per day
* A typical nearby search asks for businesses within a radius of a few kilometers and returns the top 20-50 ranked results
* Search latency should be well under 300ms — this is a use case (walking down a street, deciding where to eat) where users expect the results to already be there
* Ratings/reviews are read far more often than written — most users who see a business's rating never leave one themselves
* It is acceptable for a brand-new business listing or a just-submitted review to take a short delay (seconds, not minutes) before appearing in search results and rating aggregates — this is an eventually-consistent read path; it is not acceptable for a business's core listing data to be lost or for a review to be attributed to the wrong business
* The set of businesses within any search radius is essentially static between searches — unlike a fleet of moving vehicles, nothing here needs continuous position updates, which is the key structural difference from the location-index problem in this course's Uber case study

#### Calculate usage

* Search volume: 30,000,000 users × 4 searches/day = **120 million searches/day** → 120,000,000 / 86,400 ≈ **~1,400 searches/sec average**, peakier around meal times — design for **~5x average at peak**, so **~7,000 searches/sec**
* Business listing storage: `business_id`, `name`, `lat`, `lng`, `category`, `address`, `hours`, `avg_rating`, `review_count` ≈ 300 bytes/listing → 50,000,000 × 300 bytes ≈ **~15 GB** for the full listing set worldwide — small enough that the entire spatial index is a realistic candidate to fit in memory, which is the single fact that most shapes this design, similar in spirit to how this course's Google Maps case study observes that its (much larger) base road graph is small enough to hold in memory
* Review storage: assume an average of 20 reviews per business over its lifetime, each review (`review_id`, `business_id`, `user_id`, `rating`, `text`, `created_at`) averaging ~500 bytes including text → 50,000,000 businesses × 20 reviews × 500 bytes ≈ **~500 GB** total — an order of magnitude larger than listing data but still comfortably shardable, and growing slowly since new reviews arrive at a small fraction of search volume
* Review write volume: assume 1% of daily searches convert into a new review being written that day (a generous upper bound, since most searches don't even involve a visit) → 120,000,000 × 0.01 = 1.2 million reviews/day → 1,200,000 / 86,400 ≈ **~14 writes/sec average** — several orders of magnitude below search read volume, confirming this is an overwhelmingly read-heavy system at the review layer too
* Spatial index size: indexing 50 million static points is a fundamentally different sizing problem than indexing millions of *moving* points reporting every few seconds (Uber's location index) — here the index is rebuilt or incrementally updated only as often as listings are created or move, which is rare, so the index-maintenance cost is negligible compared to the query volume it serves

## Step 2: Create a high-level design

![Yelp high-level architecture](/img/case-studies/yelp-overview.svg)

A **search service** answers "what's near this point" by querying a **spatial index** that maps geographic cells to the business IDs located in them, rather than scanning a table of business rows and computing distance for each one. Because the index is built over largely static data, it can be precomputed and kept warm in memory across the search fleet, refreshed incrementally as listings change rather than recomputed per query. A separate **business service** owns the authoritative listing data (name, address, hours, category) in a durable **business store**, and a **review service** handles review submission and rating aggregation against a **review store**, publishing rating updates that the search layer picks up asynchronously so search results reflect a recent, not necessarily instantaneous, aggregate rating.

The design's central bet is the mirror image of this course's Google Maps case study: where routing has to solve a hard *traversal* problem over a graph that's cheap to store but expensive to search, nearby-search has to solve a hard *indexing* problem over points that are trivial to search individually but expensive to filter by proximity at scale without the right structure. Neither system needs what the other one is built around — Yelp's businesses don't move and don't need shortest-path computation between them; Google Maps' road segments aren't "nearby-searched," they're traversed.

## Step 3: Design core components

### Use case: User searches for businesses near a location

* The client sends a center point (lat/lng) and optional filters (category, radius) to the **search service**
* The search service resolves the center point to its geographic cell in the **spatial index** and queries that cell plus its immediate neighbors, to catch businesses just across a cell boundary from the search center
* Candidates are filtered by category if specified, ranked, and the top results are returned with distance computed per result

The spatial index is the crux of this design, and it's worth being explicit about why a naive approach fails: scanning all 50 million businesses and computing distance for each one, per search, at 7,000 searches/sec peak, means the full dataset is touched roughly 350 billion times a second worth of comparisons — obviously untenable. Instead, the map is divided into cells using a hierarchical geospatial grid — Geohash, Google's S2, and Uber's H3 are three real, widely-used implementations of this exact idea, each with a compact string or integer key at a chosen precision level and neighboring cells having adjacent-looking keys, letting "give me this area and its neighbors" resolve to a handful of index lookups instead of a scan. The index itself is a straightforward mapping of `cell_id -> [business_id, business_id, ...]`, maintained incrementally as businesses are created, moved, or removed — see [Index Table](/docs/patterns/storage/index-table) for the general pattern of maintaining a secondary structure keyed by something other than a record's primary ID specifically to avoid full scans, applied here with a geographic cell as the secondary key instead of an ordinary field value.

Choosing the cell precision level is a real tradeoff: coarser cells mean fewer cells to query but more candidates per cell to filter and rank (more false-positive "nearby" results that turn out to be outside the actual search radius once precise distance is computed); finer cells mean the opposite, plus more neighbor cells to check near a boundary. A reasonable design picks a precision level that keeps a typical urban cell's business count in the low hundreds, and may vary precision by known business density (dense downtown cores vs. sparse rural areas) rather than using one fixed size worldwide.

Because business locations are effectively static and this index is queried far more than it's updated, it lives largely in memory across the search fleet — see [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) — with the durable **business store** as the source of truth that the index is rebuilt or incrementally patched from, not something queried directly on the hot search path.

### Use case: Service ranks results by distance and rating

Pure distance ranking is a bad user experience on its own — the absolute nearest coffee shop with a 2-star rating usually isn't what a user wants over a slightly farther 4.5-star one. Ranking combines both signals: a candidate list is retrieved by the spatial index (distance-relevant by construction, since it's already limited to nearby cells), then scored by a function that weighs precise distance against the business's aggregate rating, rather than sorting by distance alone and only using rating as a tiebreaker. This scoring step runs against a small candidate set (the contents of a handful of cells, typically a few hundred businesses at most), not the full dataset, which is exactly why getting the candidate set small via the spatial index first matters — the ranking function's cost is proportional to candidates returned, not to total businesses that exist.

### Use case: Business owner creates or updates a listing

Listing writes are rare relative to search reads (the calculation above puts read:write pressure at multiple orders of magnitude), so this path is optimized for correctness over raw throughput. A write goes to the durable **business store** first; only after that succeeds does the system update the spatial index, published as an event the index-maintenance layer consumes asynchronously — see [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture). A brand-new listing being invisible in search for a few seconds after creation is an acceptable staleness window given this design's assumptions; a listing write that succeeds in the business store but is silently never reflected in the index would not be, so index updates need at-least-once delivery with idempotent application (re-applying "business X is in cell Y" twice is harmless).

### Use case: User leaves a rating and review

* The client submits a rating and optional text to the **review service**, which writes it durably to the **review store**
* The business's aggregate rating (`avg_rating`, `review_count`) needs to reflect the new review, but recomputing an average over potentially thousands of reviews on every single new submission is wasteful when the vast majority of read traffic is search and detail-page views, not review submissions

Rather than storing only raw reviews and averaging at read time, the aggregate is maintained incrementally: a new review updates a running sum and count rather than triggering a full recomputation, and that aggregate is what search ranking and the business detail page read — see [Materialized View](/docs/patterns/storage/materialized-view) for the general idea of maintaining a cheap, continuously-updated summary specifically so the much more frequent read path doesn't pay aggregation cost repeatedly. For businesses with unusually high review velocity (a newly viral restaurant), the same kind of write-contention concern this course's Instagram case study discusses for like counters applies here too — a [Sharded Counter](/docs/patterns/building-blocks/sharded-counters)-style approach to the running sum avoids a single hot row becoming a bottleneck, though at Yelp's assumed review-write volume (tens of writes/sec system-wide) this matters far less than it does for a social feed's like counts, and is more of a per-business hot-spot mitigation than a system-wide necessity.

## Step 4: Scale the design

![Yelp scaled architecture](/img/case-studies/yelp-scaled.svg)

**The spatial index scales by geographic sharding, similar in principle to how this course's Uber case study shards its location index — but for a very different reason.** Uber shards by geography because a rider in one city should never match a driver in another; Yelp shards by geography because the *volume* of static business data and search query load in a single dense metro area can exceed what one machine's memory and query throughput can serve, even though the data itself never moves. See [Sharding](/docs/patterns/storage/sharding). Unlike Uber's index, which is under constant write pressure from location pings, Yelp's index shards are overwhelmingly read-heavy and only need to absorb rare listing changes — which means each shard can be replicated more aggressively for read scaling without the write-conflict concerns a high-churn index would have.

**Search read load is the dominant traffic and is served primarily from cache, in front of the spatial index and the business store both.** A search for a popular area (a downtown core, a busy neighborhood) is requested repeatedly by many different users in a short window, making it a good candidate for [Cache-Aside](/docs/patterns/caching/cache-aside) at the query-result level, not just at the underlying index level — caching "top businesses near cell X" as a unit avoids repeating even the cheap index lookup and ranking work for a popular area on every single request.

**Business detail pages benefit from a [CDN](/docs/patterns/building-blocks/cdn) for anything static** (photos, hours, address) with only the aggregate rating needing a fresher, non-cached-at-the-edge path — separating what's genuinely dynamic (the rating, which changes with every review) from what isn't (the listing's core facts) keeps the cacheable majority of the page cheap to serve.

**The review store scales by sharding on `business_id`**, since virtually every review read is scoped to a single business (its detail page) rather than needing to query across businesses — see [Sharding](/docs/patterns/storage/sharding). Combined with [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) for the much higher read volume relative to writes, this keeps review reads cheap without over-provisioning for the comparatively rare write path.

**Rate limiting protects the search API from abusive or automated scraping traffic** specifically because the underlying dataset (business listings) is valuable and static enough to be worth scraping wholesale — see [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) and [Throttling](/docs/patterns/building-blocks/throttling). This is a lower concern for a system like Uber's dispatch API, where the data is transient and time-sensitive and therefore much less valuable to scrape in bulk.

## Additional talking points

* **Why not use a general full-text search index for location filtering too, since one already exists for review text?** A geospatial cell index and a text search index solve different problems — proximity filtering needs a structure organized by physical space, not by token overlap — and while some search systems (Elasticsearch's `geo_distance` queries and PostgreSQL's PostGIS extension are two real, well-known examples) do support geo-filtering as a bolted-on feature, understanding *why* proximity search needs its own indexing structure (rather than "just use whatever search engine we already have") is the more interesting system-design point than the specific tool choice.
* **Handling businesses that move or close.** A listing update needs to remove the business from its old cell and add it to its new one atomically enough that a search never returns a business at a stale location — a small but easy-to-get-wrong detail, since naively "add to new cell, then remove from old cell" briefly double-lists the business, while the reverse order briefly makes it vanish.
* **Fraud in ratings (fake reviews, review bombing).** Out of scope to design in depth, but worth a mention: an aggregate-rating system that trusts every review equally is gameable, and a production system would need some notion of review-source trust or anomaly detection feeding into how much weight a given review contributes to the aggregate — a policy/trust problem layered on top of, not a replacement for, the aggregation mechanism described above.
* **Search-radius versus fixed-result-count tradeoffs.** A fixed search radius can return zero results in a sparse area and hundreds in a dense one; a fixed result count (e.g., "nearest 30") behaves more consistently for the user but means the effective radius searched varies wildly by location density — worth discussing which behavior actually matches user expectations, since it changes how the neighbor-cell expansion logic in Step 3 needs to behave.
