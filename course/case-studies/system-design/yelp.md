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

The hard problem: filter 50 million largely-static points down to "what's near this exact coordinate" in under 300ms, at 7,000 searches/sec peak, without scanning the dataset.

**Core spec: schema + geohash indexing**

```sql
CREATE TABLE businesses (
    business_id   BIGINT PRIMARY KEY,
    name          VARCHAR(200) NOT NULL,
    lat           DECIMAL(9,6) NOT NULL,
    lng           DECIMAL(9,6) NOT NULL,
    geohash       CHAR(7) NOT NULL,        -- precomputed, precision ~150m x 150m cells
    category      VARCHAR(50) NOT NULL,
    avg_rating    DECIMAL(2,1) NOT NULL DEFAULT 0,
    review_count  INT NOT NULL DEFAULT 0,
    updated_at    TIMESTAMP NOT NULL
);

-- The index that makes nearby-search fast: businesses sharing a
-- geohash prefix are physically close, so range/equality queries on
-- this column resolve "what's in this area" without scanning lat/lng.
CREATE INDEX idx_businesses_geohash ON businesses (geohash);
CREATE INDEX idx_businesses_geohash_category ON businesses (geohash, category);
```

A geohash encodes a lat/lng pair into a base-32 string where each additional character narrows the cell to a smaller region — a 7-character geohash covers roughly a 150m x 150m cell, a reasonable precision for "nearby" urban search. Businesses sharing a geohash prefix are geographically close, so `idx_businesses_geohash` turns "what's near this point" into an equality/prefix lookup instead of a full-table distance scan. Google's [S2](https://s2geometry.io/) and Uber's [H3](https://h3geo.org/) are two real, widely-used alternatives to geohash — both cover the sphere with cells too, with different trade-offs around cell shape uniformity, but the indexing idea (map 2D coordinates to a 1D sortable/indexable key) is the same across all three.

The encoding itself works by repeatedly bisecting the lat/lng ranges and recording which half each coordinate fell in — 5 bits per output character, alternating between longitude and latitude bisections:

```python
_BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz"

def geohash_encode(lat, lng, precision):
    lat_range, lng_range = [-90.0, 90.0], [-180.0, 180.0]
    out, bit, ch, even_bit = [], 0, 0, True
    while len(out) < precision:
        if even_bit:
            mid = (lng_range[0] + lng_range[1]) / 2
            if lng >= mid:
                ch |= (1 << (4 - bit)); lng_range[0] = mid
            else:
                lng_range[1] = mid
        else:
            mid = (lat_range[0] + lat_range[1]) / 2
            if lat >= mid:
                ch |= (1 << (4 - bit)); lat_range[0] = mid
            else:
                lat_range[1] = mid
        even_bit = not even_bit
        if bit < 4:
            bit += 1
        else:
            out.append(_BASE32[ch]); bit, ch = 0, 0
    return "".join(out)

def geohash_decode_bbox(geohash):
    """Reverse the bisection to recover the lat/lng box this cell covers."""
    lat_range, lng_range = [-90.0, 90.0], [-180.0, 180.0]
    even_bit = True
    for c in geohash:
        for n in range(4, -1, -1):
            bit = (_BASE32.index(c) >> n) & 1
            if even_bit:
                mid = (lng_range[0] + lng_range[1]) / 2
                lng_range[0 if bit else 1] = mid
            else:
                mid = (lat_range[0] + lat_range[1]) / 2
                lat_range[0 if bit else 1] = mid
            even_bit = not even_bit
    return lat_range, lng_range

def geohash_neighbors(cell):
    """The actual fix for the boundary problem: step just past each edge
    and corner of this cell's bounding box and re-encode at the same
    precision -- gives the 8 real adjacent cells regardless of which
    direction a nearby point crossed the boundary in."""
    lat_range, lng_range = geohash_decode_bbox(cell)
    lat_span, lng_span = lat_range[1] - lat_range[0], lng_range[1] - lng_range[0]
    center_lat = (lat_range[0] + lat_range[1]) / 2
    center_lng = (lng_range[0] + lng_range[1]) / 2
    neighbors = []
    for d_lat in (-1, 0, 1):
        for d_lng in (-1, 0, 1):
            if d_lat == 0 and d_lng == 0:
                continue  # skip the center cell -- already queried separately
            probe_lat = max(-90.0, min(90.0, center_lat + d_lat * lat_span))
            probe_lng = ((center_lng + d_lng * lng_span + 180) % 360) - 180
            neighbors.append(geohash_encode(probe_lat, probe_lng, len(cell)))
    return neighbors
```

With the encoding and its inverse in place, `nearby_search` can actually query the 9-cell neighborhood the gotcha below requires, not just describe it:

```python
def nearby_search(lat, lng, precision, index, radius_km, category=None):
    center_cell = geohash_encode(lat, lng, precision)
    cells_to_query = [center_cell] + geohash_neighbors(center_cell)  # see "the gotcha" below

    candidates = []
    for cell in cells_to_query:
        candidates.extend(index.get(cell, []))

    results = []
    for biz in candidates:
        if category and biz.category != category:
            continue
        d = haversine_distance(lat, lng, biz.lat, biz.lng)
        if d <= radius_km:
            results.append((biz, d))

    return sorted(results, key=lambda r: r[1])

def haversine_distance(lat1, lng1, lat2, lng2):
    """Great-circle distance in km -- the 9-cell candidate set from geohash
    is approximate by construction, so every candidate still needs this
    exact check against the requested radius before being returned."""
    import math
    r = 6371.0  # earth's mean radius, km
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    d_phi = math.radians(lat2 - lat1)
    d_lambda = math.radians(lng2 - lng1)
    a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))
```

**Data structures:**
* `spatial_index`: `geohash_cell -> [business_id, business_id, ...]`, kept largely in memory across the search fleet since it's queried far more than it's updated
* `businesses` table: as in the DDL above, `business_id` primary, `geohash` indexed for cell lookups
* `geohash_neighbors(cell)`: the 8 adjacent cells for a given geohash string, computed above by stepping past each edge/corner of the cell's bounding box and re-encoding — no storage, computed per query

**Trade-offs:**
* **The gotcha — this is "the boundary problem," and it's the specific trap a naive geohash implementation falls into:** two businesses can be meters apart in the real world yet fall into different geohash cells if they're near a cell edge — geohash cells are a rigid grid overlaid on the earth, and physical proximity doesn't respect grid lines. A query that looks up only the searcher's own cell will silently miss real nearby results sitting just across a boundary, and worse, this failure is invisible in testing unless a test case happens to place a point near an edge. The fix, shown in `nearby_search` above, is to always query the current cell **plus its 8 neighboring cells** (`geohash_neighbors`) — 9 cells total — never just one. This is the single most commonly cited gotcha in real geospatial-indexing write-ups for exactly this reason: it's easy to implement a version that passes casual testing and still returns wrong results in production.
* Choosing geohash precision is a real trade-off: coarser cells (fewer characters) mean fewer cells to query but more candidates per cell to filter and rank; finer cells mean the opposite, plus (per the gotcha above) still always 9 cells to check regardless of precision. A reasonable design picks a precision that keeps a typical urban cell's business count in the low hundreds, and may vary precision by known business density (dense downtown cores vs. sparse rural areas) rather than one fixed size worldwide.
* Some general-purpose search/storage systems bolt geo-filtering on as a feature — [PostGIS](https://postgis.net/) for PostgreSQL and Elasticsearch's [`geo_distance` query](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-geo-distance-query.html) are two real, well-known examples — but understanding *why* proximity search needs cell-based indexing (not just "there's a geo feature in the database we already use") is the more durable system-design point than any specific tool choice.

See: [Geohash — Wikipedia](https://en.wikipedia.org/wiki/Geohash) for the encoding scheme itself.

**REST API:**

```
$ curl "https://yelp.example/api/v1/search?lat=37.7749&lng=-122.4194&radius_km=2&category=coffee"
```

Response:

```json
{
  "results": [
    {"business_id": "b_5521", "name": "Corner Coffee Co.", "distance_km": 0.3, "avg_rating": 4.5},
    {"business_id": "b_9012", "name": "Bean There", "distance_km": 0.8, "avg_rating": 4.2}
  ]
}
```

### Use case: Service ranks results by distance and rating

Pure distance ranking is a bad user experience on its own — the absolute nearest coffee shop with a 2-star rating usually isn't what a user wants over a slightly farther 4.5-star one.

**Core spec: weighted scoring over a small, already-filtered candidate set**

```python
def rank_score(distance_km, avg_rating, max_radius_km):
    distance_score = 1 - (distance_km / max_radius_km)     # closer -> higher, in [0, 1]
    rating_score = avg_rating / 5.0                          # normalize to [0, 1]
    return 0.6 * distance_score + 0.4 * rating_score          # tunable weights

def rank_results(candidates, max_radius_km):
    scored = [
        (biz, rank_score(dist, biz.avg_rating, max_radius_km))
        for biz, dist in candidates
    ]
    return sorted(scored, key=lambda r: r[1], reverse=True)
```

**Data structures:** operates directly on the `(business, distance)` candidate list `nearby_search` already produced — no separate storage.

**Trade-offs:**
* This scoring step runs against a small candidate set (the contents of 9 cells, typically a few hundred businesses at most), not the full dataset — which is exactly why getting the candidate set small via the spatial index first matters; the ranking function's cost is proportional to candidates returned, not to total businesses that exist.
* Fixed weights (0.6/0.4 above) are a simplification — a production system would tune these against actual click-through/conversion data rather than a guessed constant, but the *structure* (combine a normalized distance signal with a normalized quality signal) is the durable part of this design.

### Use case: Business owner creates or updates a listing

Listing writes are rare relative to search reads (the calculation above puts read:write pressure at multiple orders of magnitude), so this path is optimized for correctness over raw throughput. A write goes to the durable `businesses` table first; only after that succeeds does the system update the spatial index, published as an event the index-maintenance layer consumes asynchronously — see [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture).

**Trade-offs:**
* A brand-new listing being invisible in search for a few seconds after creation is an acceptable staleness window given this design's assumptions; a listing write that succeeds in the `businesses` table but is silently never reflected in the index would not be, so index updates need at-least-once delivery with idempotent application (re-applying "business X is in cell Y" twice is harmless) — see [Idempotency](/docs/patterns/reliability/idempotency).
* A business that moves or closes needs its old geohash cell entry removed and its new one added — naively "add to new cell, then remove from old" briefly double-lists the business, while the reverse order briefly makes it vanish. Neither is catastrophic given the short staleness window already tolerated, but it's an easy detail to get backwards under review.

### Use case: User leaves a rating and review

* The client submits a rating and optional text to the **review service**, which writes it durably to a `reviews` table (`review_id`, `business_id`, `user_id`, `rating`, `text`, `created_at`, indexed on `business_id`)
* The business's `avg_rating`/`review_count` need to reflect the new review, but recomputing an average over potentially thousands of reviews on every single new submission is wasteful when the vast majority of read traffic is search and detail-page views, not review submissions

```python
def record_review(business_id, rating, store):
    biz = store.get_business(business_id)
    new_count = biz.review_count + 1
    new_avg = (biz.avg_rating * biz.review_count + rating) / new_count
    store.update_business(business_id, avg_rating=new_avg, review_count=new_count)
```

**Data structures:** the incremental update above only needs the business's current `avg_rating` and `review_count` — no read of the full review history required.

**Trade-offs:**
* Rather than storing only raw reviews and averaging at read time, the aggregate is maintained incrementally, and that aggregate is what search ranking and the business detail page read — see [Materialized View](/docs/patterns/storage/materialized-view) for the general idea of maintaining a cheap, continuously-updated summary specifically so the much more frequent read path doesn't pay aggregation cost repeatedly.
* For businesses with unusually high review velocity (a newly viral restaurant), the same kind of write-contention concern this course's Instagram case study discusses for like counters applies here too — a [Sharded Counter](/docs/patterns/building-blocks/sharded-counters)-style approach to `review_count` avoids a single hot row becoming a bottleneck, though at Yelp's assumed review-write volume (tens of writes/sec system-wide) this matters far less than it does for a social feed's like counts, and is more of a per-business hot-spot mitigation than a system-wide necessity.
* An aggregate-rating system that trusts every review equally is gameable — fake reviews and review-bombing are a policy/trust problem layered on top of, not a replacement for, the aggregation mechanism above; out of scope to design in depth here.

## Step 4: Scale the design

![Yelp scaled architecture](/img/case-studies/yelp-scaled.svg)

* **The spatial index scales by geographic sharding, similar in principle to how this course's Uber case study shards its location index — but for a very different reason.** Uber shards by geography because a rider in one city should never match a driver in another; Yelp shards by geography because the *volume* of static business data and search query load in a single dense metro area can exceed what one machine's memory and query throughput can serve, even though the data itself never moves. See [Sharding](/docs/patterns/storage/sharding). Unlike Uber's index, which is under constant write pressure from location pings, Yelp's index shards are overwhelmingly read-heavy and only need to absorb rare listing changes — which means each shard can be replicated more aggressively for read scaling without the write-conflict concerns a high-churn index would have.
* **Search read load is the dominant traffic and is served primarily from cache, in front of the spatial index and the business store both.** A search for a popular area (a downtown core, a busy neighborhood) is requested repeatedly by many different users in a short window, making it a good candidate for [Cache-Aside](/docs/patterns/caching/cache-aside) at the query-result level, not just at the underlying index level — caching "top businesses near cell X" as a unit avoids repeating even the cheap index lookup and ranking work for a popular area on every single request.
* **Business detail pages benefit from a [CDN](/docs/patterns/building-blocks/cdn) for anything static** (photos, hours, address) with only the aggregate rating needing a fresher, non-cached-at-the-edge path — separating what's genuinely dynamic (the rating, which changes with every review) from what isn't (the listing's core facts) keeps the cacheable majority of the page cheap to serve.
* **The review store scales by sharding on `business_id`**, since virtually every review read is scoped to a single business (its detail page) rather than needing to query across businesses — see [Sharding](/docs/patterns/storage/sharding). Combined with [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) for the much higher read volume relative to writes, this keeps review reads cheap without over-provisioning for the comparatively rare write path.
* **Rate limiting protects the search API from abusive or automated scraping traffic** specifically because the underlying dataset (business listings) is valuable and static enough to be worth scraping wholesale — see [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) and [Throttling](/docs/patterns/building-blocks/throttling). This is a lower concern for a system like Uber's dispatch API, where the data is transient and time-sensitive and therefore much less valuable to scrape in bulk.

## Additional talking points

* **Why not use a general full-text search index for location filtering too, since one already exists for review text?** A geospatial cell index and a text search index solve different problems — proximity filtering needs a structure organized by physical space, not by token overlap — and while some search systems (Elasticsearch's `geo_distance` queries and PostgreSQL's PostGIS extension are two real, well-known examples) do support geo-filtering as a bolted-on feature, understanding *why* proximity search needs its own indexing structure (rather than "just use whatever search engine we already have") is the more interesting system-design point than the specific tool choice.
* **Fraud in ratings (fake reviews, review bombing).** Out of scope to design in depth, but worth a mention: an aggregate-rating system that trusts every review equally is gameable, and a production system would need some notion of review-source trust or anomaly detection feeding into how much weight a given review contributes to the aggregate.
* **Search-radius versus fixed-result-count tradeoffs.** A fixed search radius can return zero results in a sparse area and hundreds in a dense one; a fixed result count (e.g., "nearest 30") behaves more consistently for the user but means the effective radius searched varies wildly by location density — worth discussing which behavior actually matches user expectations, since it changes how the neighbor-cell expansion logic in Step 3 needs to behave.
* **S2 and H3 both solve the boundary problem differently than geohash's fixed grid** — worth a brief mention that hexagonal cells (H3) have more uniform neighbor distances than geohash's rectangular cells, which reduces (but doesn't eliminate) the boundary distortion at cell edges; the neighbor-expansion fix in Step 3 is still needed regardless of which cell scheme is chosen.

## Source(s) and further reading

* [Geohash — Wikipedia](https://en.wikipedia.org/wiki/Geohash) — the encoding scheme this design's spatial index is built on
* [S2 Geometry](https://s2geometry.io/) — Google's hierarchical spherical-cell indexing library, a real alternative to geohash
* [H3](https://h3geo.org/) — Uber's hexagonal hierarchical spatial index, another real, widely-used alternative
* [PostGIS](https://postgis.net/) — PostgreSQL's geospatial extension, a real example of geo-filtering bolted onto a general-purpose database
* [Elasticsearch `geo_distance` query](https://www.elastic.co/guide/en/elasticsearch/reference/current/query-dsl-geo-distance-query.html) — a real production geo-filtering feature on a general-purpose search engine
* [Materialized View](/docs/patterns/storage/materialized-view) — the pattern behind this design's incrementally-maintained rating aggregate
