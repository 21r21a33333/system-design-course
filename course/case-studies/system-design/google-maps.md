---
title: "Design Google Maps (or Turn-by-Turn Navigation)"
sidebar_position: 13
---

Turn-by-turn navigation is fundamentally a graph problem wearing a maps UI: the hard part isn't showing a map, it's computing the shortest path across tens of millions of road segments in well under a second, and then keeping that answer correct as live traffic changes underneath the driver.

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **User** requests a route between an origin and a destination and gets turn-by-turn directions
* **User** follows an active route and receives continuous re-routing if they deviate or if traffic conditions change enough to make an alternate route meaningfully faster
* **Service** ingests live traffic conditions from the positions and speeds of devices currently navigating, and factors that into route computation
* **Service** renders map tiles (roads, points of interest, labels) for the area the user is currently viewing
* **Service** estimates time of arrival (ETA) for an active route and updates it as the trip progresses
* **Service** has high availability across geographic regions; a routing outage in one region should not affect others

#### Out of scope

* Points-of-interest search and business listings (that's this course's Yelp case study — a mechanically different, spatial-indexing problem, not a routing problem)
* Public transit, walking, and cycling directions (worth a one-line mention as a variant graph with different edge weights, not designed in depth)
* Satellite/street-level imagery capture and serving
* Voice-guided narration and offline map downloads

### Constraints and assumptions

#### State assumptions

* 200 million daily active navigating users worldwide, with an average active navigation session lasting 20 minutes
* The road network is modeled as a graph: roughly 700 million road segments (edges) globally, with intersections as nodes — a road segment carries a base travel time plus a live traffic multiplier
* A route computation (origin, destination) must return in well under a second — users perceive anything past roughly one second as the app being slow, even before they start driving
* Live traffic data is inherently approximate and constantly changing; a route that's a few percent off optimal because traffic data is 30-60 seconds stale is completely acceptable — this is squarely an availability-and-freshness-over-strict-correctness system
* Map tiles and the base road graph change relatively rarely (road construction, new roads) compared to how often they're read — this is a heavily read-skewed, cacheable dataset at the base-map layer, separate from the highly volatile traffic layer on top of it
* A navigating device reports its position roughly every 5 seconds while a route is active
* Re-routing only needs to run against the graph near the driver's current position and remaining route — it never needs global graph state

#### Calculate usage

* Route requests: 200 million sessions/day, each starting with one initial route computation plus periodic re-route checks. Assume ~1.5 route computations per session on average (one initial, plus occasional re-routes for the fraction of trips with a deviation or a significant traffic shift) → 200,000,000 × 1.5 = 300 million route computations/day
    * 300,000,000 / 86,400 sec ≈ **~3,500 route computations/sec average**, with strong peaking around morning/evening commute windows — design for **~5x average at peak**, so **~17,000 route computations/sec**
* Live position pings: 200 million daily sessions × 20-minute average duration ÷ (24 hours × 60 min) gives an estimate of concurrent active navigators. 200,000,000 sessions/day × 20 min ÷ 1,440 min/day ≈ **~2.8 million concurrent navigating devices** at a representative moment, each reporting every 5 seconds → 2,800,000 / 5 ≈ **~560,000 position pings/sec** globally at that representative load, higher at commute peaks
    * Each ping (`device_id`, `lat`, `lng`, `speed`, `heading`, `timestamp`) ≈ 40 bytes → **~22 MB/sec** of raw traffic-signal ingest at that load
* Road graph storage: ~700 million edges, each with a compact record (`from_node`, `to_node`, `base_travel_time`, `road_class`, `geometry_reference` ≈ 60 bytes) ≈ **~42 GB** for the base graph structure worldwide — small enough that a regional slice of it comfortably fits in memory on a single class of machine, which matters enormously for query latency
* Traffic layer storage: a live speed/volume estimate per edge, refreshed continuously, at roughly 20 bytes/edge (`edge_id`, `current_speed_estimate`, `updated_at`) × 700 million edges ≈ **~14 GB** for a single snapshot of live traffic state worldwide — small relative to the ping ingest volume because it's a continuously-overwritten aggregate per edge, not a log of every ping ever received
* Map tile storage: assume ~20 zoom levels, with the tile count roughly quadrupling per zoom level (a standard slippy-map pyramid); even bounding this to the road-relevant zoom range and compressing tiles to a few KB each, this comfortably reaches the tens-of-terabytes range worldwide — dominated by tile count, not by any single tile's size, and squarely a candidate for blob storage behind a cache rather than a database

## Step 2: Create a high-level design

![Google Maps high-level architecture](/img/case-studies/google-maps-overview.svg)

A navigating client talks to two largely independent subsystems that happen to share a map: a **tile service** that serves the static, rarely-changing visual map (roads, labels, points of interest) the user sees on screen, and a **routing service** that answers the actual hard question — "what's the best path from A to B, right now." The tile service is a classic read-heavy, highly cacheable content-delivery problem. The routing service is the interesting part: it holds an in-memory **road graph** (nodes and edges representing the network) annotated with a continuously-updated **traffic layer**, and runs a shortest-path search over that annotated graph per request. A **traffic ingestion pipeline** consumes position pings from every currently-navigating device, aggregates them into per-edge speed estimates, and pushes updates into the traffic layer — asynchronously, off the request path of any individual user's route computation. An **ETA/re-route monitor** watches each active session's reported position against its assigned route and decides when a deviation or a traffic shift is large enough to warrant recomputing.

The core design tension is between two things that both want to be fast: routing needs the traffic layer to be fresh enough to matter, but computing a shortest path over a graph with 700 million edges on every single request, using traffic data that's changing hundreds of thousands of times a second, means the system cannot afford to either recompute everything from scratch per query or treat the graph as static. The next section is about resolving exactly that tension.

## Step 3: Design core components

### Use case: User requests a route

* The client sends origin and destination coordinates to the **routing service**
* The routing service resolves both points to the nearest graph nodes and runs a shortest-path search over the **road graph**, where each edge's weight is its current best-known travel time — base travel time adjusted by the live multiplier from the **traffic layer**
* The result — an ordered sequence of edges — is converted into turn-by-turn instructions (which requires geometry and street-name data associated with each edge, fetched alongside the graph) and returned to the client along with an initial ETA

Running a plain shortest-path search (conceptually similar to Dijkstra's algorithm) over the full 700-million-edge global graph on every request would be far too slow to meet a sub-second target — the search space is enormous even though any single route only ever touches a tiny fraction of it. Two standard techniques make this tractable. First, **bidirectional search**: running the shortest-path search simultaneously outward from the origin and backward from the destination and stopping when the two frontiers meet cuts the effective search space dramatically compared to searching from just one end. Second, and more importantly at this system's scale, **precomputed hierarchical shortcuts**: offline, the graph is preprocessed to identify "important" long-distance edges (the road-network equivalent of highways connecting regions) and precompute shortcut edges that skip over long stretches of less-important local roads. A live query then only needs to search in detail near the origin and destination, and can "jump" through the precomputed shortcut layer for the long middle stretch of a route — trading a large offline precomputation cost, redone periodically as the road network changes, for a dramatically smaller online query cost. This is a graph-specific realization of a very general idea also seen elsewhere in this course under [Materialized View](/docs/patterns/storage/materialized-view): expensive computation is done once, ahead of time, so that reads pay a much smaller cost repeatedly.

Because the road graph itself changes rarely (new roads, closures) relative to how often it's read, it's held largely in memory across a fleet of routing servers rather than fetched from a durable store per request — see [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) for the general shape of keeping a large, read-heavy, infrequently-updated dataset resident near compute rather than paying storage-layer latency on every query.

### Use case: Service ingests live traffic and keeps the traffic layer fresh

Every navigating device reports its position on an interval. At the assumed ~560,000 pings/sec, applying each ping synchronously to the shared traffic layer the moment it arrives would create write contention on hot edges (a busy highway segment gets pinged by thousands of concurrent drivers) and would couple ingest throughput directly to how fast the traffic layer can be updated. Instead, pings are published to a **traffic ingestion pipeline** — an asynchronous stream, decoupling "a ping arrived" from "the traffic layer reflects it" — see [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) and [Stream Processing](/docs/patterns/batch-streaming/stream-processing). A pool of aggregators consumes that stream, groups pings by the road edge they're currently on (map-matching a raw lat/lng to the nearest edge is itself a small spatial-indexing problem, conceptually similar to what this course's Yelp case study covers for point lookups), and maintains a rolling average speed per edge over a short window (tens of seconds), overwriting the previous estimate rather than appending to an ever-growing log.

This design deliberately treats the traffic layer as an eventually-consistent, continuously-overwritten aggregate rather than a durable history: an individual ping that's lost or delayed by a few seconds has no meaningful effect on route quality, since the next ping from any of hundreds of other drivers on the same edge corrects the estimate almost immediately. That tolerance for staleness is exactly what makes it acceptable to update the traffic layer asynchronously and in a best-effort way rather than treating every ping as a transaction that must be durably applied before being acknowledged.

### Use case: User follows an active route with live re-routing

While a route is active, the client keeps reporting position pings, and an **ETA/re-route monitor** compares the reported position against the assigned route. Two conditions can trigger a recompute: the driver has physically deviated from the route (missed a turn, took a detour), or the traffic layer has shifted enough along the remaining route that an alternate path is now meaningfully faster — not just marginally faster, since recomputing and switching routes has its own cost in driver confusion and shouldn't fire on noise-level differences.

Rather than running a full route recomputation on every single position ping (which would multiply the routing service's query load by the ping rate for no benefit, since traffic doesn't meaningfully shift second to second), the monitor evaluates the "is the current route still good" check on a coarser interval — a period of tens of seconds is enough to catch a real traffic shift without adding meaningful load. This is the same idea as the [Throttling](/docs/patterns/building-blocks/throttling) pattern applied to an internal decision rather than a client-facing API: bound the rate of an expensive operation to something proportional to how often its answer can actually change, not to how often new data technically arrives.

When a recompute is triggered, it's a normal call into the same routing path described above, just automated rather than user-initiated, and the ETA is updated to match the new route.

### Use case: Service renders map tiles for the current view

Map tiles are a textbook cacheable, read-heavy workload: a tile for a given area and zoom level is identical for every user looking at that location, changes rarely (road construction, new points of interest), and is requested constantly. Tiles are pre-rendered offline from the underlying map data at each zoom level and served as static assets through a [CDN](/docs/patterns/building-blocks/cdn) — nearly all tile requests are served from an edge cache and never reach an origin server. This is architecturally the least novel part of the system, and deliberately so: the interesting engineering budget in this design goes toward the routing and traffic subsystems, not tile serving.

## Step 4: Scale the design

![Google Maps scaled architecture](/img/case-studies/google-maps-scaled.svg)

**The routing service scales by geographic partitioning of the road graph, not by simply adding more identical replicas of a global graph.** A single machine holding the entire 700-million-edge world graph in memory is possible given the storage math above, but query latency and fault isolation both benefit from splitting the graph into regional shards (continent- or country-sized, with some overlap at boundaries so cross-region routes don't require an expensive multi-shard stitch on every query) — see [Sharding](/docs/patterns/storage/sharding). This also bounds blast radius: a routing outage or a bad graph update in one region doesn't take down routing anywhere else, similar in spirit to the per-city independence this course's Uber case study relies on for dispatch.

**The traffic ingestion pipeline scales by partitioning the ping stream by geography and processing it independently of the query path.** Because aggregation only ever needs pings from drivers physically near a given edge, the same regional partitioning used for the graph applies naturally to traffic ingestion — a burst of pings in one city's rush hour doesn't compete for aggregation capacity with a quiet region elsewhere. See [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption).

**Precomputed shortcuts age, and recomputing them for the whole world at once doesn't scale as a single batch job.** As roads open and close, the offline hierarchy precomputation needs to be redone — but only for the regions that actually changed, incrementally, rather than reprocessing the entire global graph on every update cycle. This keeps the cost of staying correct proportional to the size of what changed, the same principle behind [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) applied to a graph structure instead of a database table.

**Read load on the traffic layer is far higher than write load in query terms** — every route computation reads potentially thousands of edges' current traffic state, while any single edge is written to only as often as pings arrive for it. Keeping the traffic layer as an in-memory structure colocated with (or very close to) the routing servers that read it, rather than behind a network hop to a separate durable store on every query, is what makes sub-second routing possible at all — see [Cache-Aside](/docs/patterns/caching/cache-aside) for the general read-heavy access pattern this mirrors, applied here to a continuously-refreshed in-memory layer rather than a cache in front of a slower source of truth.

**Multi-region failure isolation follows the same regional graph partitioning already in place.** Because a region's routing capability doesn't depend on any other region's graph shard or traffic layer, a regional outage degrades routing only for users physically in or near that region — there's no single global routing dependency to fail over as one unit, the same [Deployment Stamps](/docs/patterns/observability/deployment-stamps) idea this course applies elsewhere to per-region independence.

## Additional talking points

* **Why not just use straight-line (as-the-crow-flies) distance as a cheap pre-filter before running the full graph search?** It's a reasonable heuristic for guiding a search (informing which direction to expand the frontier first, similar in spirit to A* search), but it's a poor substitute for the search itself — road networks routinely make straight-line distance a bad proxy for actual travel time (a river, a highway with no nearby crossing, a one-way system). Worth distinguishing "use distance as a search heuristic" from "use distance instead of a real graph search," which are very different design choices.
* **Handling road closures and real-time incidents (accidents, construction) as a distinct signal from routine traffic congestion.** An incident report needs to be reflected in the traffic layer immediately and with much higher confidence than a single ping's speed estimate — worth discussing as a separate, higher-priority ingestion path rather than folding it into the same rolling-average aggregation used for ordinary congestion.
* **Alternate-route generation for the initial request.** Real navigation apps typically offer 2-3 route options, not just the single shortest path — generating genuinely different alternatives (not just near-duplicates of the same road with trivial variations) is a harder graph problem than it sounds, since naively re-running shortest-path search after removing the best route's edges can produce a route that's technically different but practically identical.
* **The traffic layer's freshness-versus-cost tradeoff is tunable per road class.** A rarely-traveled residential street doesn't need traffic estimates refreshed as aggressively as a major highway — allocating aggregation freshness proportional to a road's actual traffic-query volume is a reasonable follow-up optimization once the base design is in place.
