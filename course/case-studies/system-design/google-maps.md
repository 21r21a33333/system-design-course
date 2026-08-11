---
title: "Design Google Maps (or Turn-by-Turn Navigation)"
sidebar_position: 13
---

Turn-by-turn navigation is fundamentally a graph problem wearing a maps UI: the hard part isn't showing a map, it's computing the shortest path across tens of millions of road segments in well under a second, and then keeping that answer correct as live traffic changes underneath the driver.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design Google Maps" module.*

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

The hard problem: find the shortest (or fastest) path across a graph with ~700 million edges, in well under a second, using edge weights that are changing hundreds of thousands of times a second underneath the query.

**Core algorithm: Dijkstra/A\* for correctness, Contraction Hierarchies for the speed-up that makes it viable at this scale**

Plain Dijkstra's algorithm, run over the full global graph, would explore tens of millions of nodes for a long cross-country query — nowhere close to a sub-second budget. Two techniques compose to fix this. **A\*** improves on Dijkstra by guiding the search with a heuristic (straight-line distance to the destination is a common admissible heuristic for road networks), so the frontier expands toward the destination rather than uniformly in all directions. That alone still isn't enough at 700-million-edge scale — which is where **Contraction Hierarchies (CH)** comes in, as a distinct *offline precomputation* step, not a smarter online search. CH preprocesses the graph once (and re-preprocesses incrementally as roads change — see Step 4) by "contracting" nodes in an order that leaves behind **shortcut edges**: an edge `(u, v)` with weight equal to the shortest path through some contracted node `w`, so a later search can traverse `u -> v` directly without ever visiting `w`. Doing this for the whole graph builds a hierarchy where important long-distance roads (the highway-equivalent nodes contracted last) become directly reachable from each other via shortcuts, and a live query only needs to search in detail near the origin and destination, "jumping" through the shortcut layer for the long middle stretch. Real open-source routing engines — [OSRM](https://github.com/Project-OSRM/osrm-backend) and [GraphHopper](https://www.graphhopper.com/) — implement CH (or a close variant) as their core speed-up strategy for exactly this reason. The qualitative effect is dramatic: a query that would otherwise touch a large fraction of the graph instead explores a small, bounded neighborhood near each endpoint plus a short hop through shortcuts, turning a search that's infeasible within a sub-second budget into one that comfortably fits it.

The code below implements plain Dijkstra over a small graph — enough to show the actual shortest-path mechanism this design depends on — with comments marking exactly where CH's precomputed shortcuts would let a real query skip work entirely:

```python
import heapq

def dijkstra_shortest_path(graph, source, target):
    """graph: dict[node] -> list[(neighbor, edge_weight)]
    edge_weight here is current best-known travel time: base travel
    time adjusted by the live multiplier from the traffic layer.

    At full scale (~700M edges) this exact algorithm is far too slow
    to run against the raw graph per request -- CH is what makes it
    tractable, by letting the search below "jump" over long stretches
    of local roads via precomputed shortcut edges instead of visiting
    every node in between. This function shows the mechanism CH
    accelerates, not a replacement for CH itself.
    """
    dist = {source: 0}
    prev = {}
    visited = set()
    # (distance, node) min-heap -- CH would additionally let this
    # frontier expand across precomputed shortcut edges, so "next
    # closest node" is often a shortcut hop spanning many real edges
    # rather than a single local road segment.
    frontier = [(0, source)]

    while frontier:
        d, node = heapq.heappop(frontier)
        if node in visited:
            continue
        visited.add(node)
        if node == target:
            break  # bidirectional search (origin + destination) stops even earlier

        for neighbor, weight in graph.get(node, []):
            if neighbor in visited:
                continue
            new_dist = d + weight
            if new_dist < dist.get(neighbor, float("inf")):
                dist[neighbor] = new_dist
                prev[neighbor] = node
                heapq.heappush(frontier, (new_dist, neighbor))

    if target not in dist:
        return None, float("inf")

    path = [target]
    while path[-1] != source:
        path.append(prev[path[-1]])
    path.reverse()
    return path, dist[target]
```

Beyond CH, **bidirectional search** — running the search simultaneously outward from the origin and backward from the destination, stopping when the two frontiers meet — cuts the effective search space further compared to searching from one end only, and composes naturally with CH's shortcut layer.

**Data structures:**
* `road_graph`: adjacency structure, `node -> [(neighbor_node, edge_weight), ...]`, held largely in memory across the routing fleet since it changes rarely relative to read volume
* `shortcut_edges` (CH's offline output): `(node_u, node_v) -> shortcut_weight`, layered on top of the base graph so a query can traverse long stretches without visiting every intermediate node
* `traffic_layer`: `edge_id -> current_speed_estimate`, continuously overwritten (see next use case) and read on every edge-weight lookup during a search
* `contraction_order`: per-node rank recorded during offline preprocessing, used to decide which direction a query is allowed to traverse a given shortcut

**Trade-offs:**
* **The gotcha:** the instinct is to reach for "just run Dijkstra" or "just run A\*" and stop there — but neither one, run naively against the full live graph, meets a sub-second budget at hundreds of millions of edges. The graph-search algorithm is necessary but not sufficient; CH's offline precomputation is what actually makes the online query cheap, by moving the expensive part (finding which long-distance connections matter) out of the request path entirely. Treating CH as an optional optimization rather than a load-bearing part of the design is the specific gap that separates a naive answer from a real one here.
* CH trades a large, periodic offline cost (contracting the graph, redone incrementally as roads change — see Step 4) for a dramatically smaller online query cost — the same "expensive computation done once, ahead of time" shape as [Materialized View](/docs/patterns/storage/materialized-view), applied to a graph structure instead of a table.
* A\*'s heuristic (straight-line distance) is a search *guide*, not a substitute for the graph search itself — see the Additional talking points below for why using it as a standalone distance proxy instead would be a mistake specific to road networks.

See: [Contraction Hierarchies — Wikipedia](https://en.wikipedia.org/wiki/Contraction_hierarchies) for the formal algorithm, and [A* search algorithm — Wikipedia](https://en.wikipedia.org/wiki/A*_search_algorithm) for the heuristic-search half of this design.

**REST API:**

```
$ curl "https://maps.example/api/v1/route?origin=37.7749,-122.4194&destination=37.3382,-121.8863"
```

Response:

```json
{
  "route_id": "r_4471a",
  "distance_meters": 78300,
  "eta_seconds": 3120,
  "steps": [
    {"instruction": "Head south on Market St", "distance_meters": 400},
    {"instruction": "Merge onto US-101 S", "distance_meters": 61200}
  ]
}
```

### Use case: Service ingests live traffic and keeps the traffic layer fresh

**Core spec: async stream aggregation into a continuously-overwritten per-edge estimate**

Every navigating device reports its position on an interval. At the assumed ~560,000 pings/sec, applying each ping synchronously to the shared traffic layer the moment it arrives would create write contention on hot edges (a busy highway segment gets pinged by thousands of concurrent drivers) and would couple ingest throughput directly to how fast the traffic layer can be updated. Instead, pings are published to a **traffic ingestion pipeline** — an asynchronous stream, decoupling "a ping arrived" from "the traffic layer reflects it" — see [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) and [Stream Processing](/docs/patterns/batch-streaming/stream-processing).

```python
class TrafficAggregator:
    """Consumes position pings, map-matches each to the edge the
    device is currently on, and maintains a rolling average speed per
    edge -- overwriting, not appending, so storage stays proportional
    to edge count rather than ping volume.
    """
    WINDOW_SECONDS = 30

    def __init__(self, traffic_layer, road_graph):
        self.traffic_layer = traffic_layer  # edge_id -> (speed_sum, ping_count, window_start)
        self.road_graph = road_graph

    def on_ping(self, device_id, lat, lng, speed, timestamp):
        edge_id = self.road_graph.nearest_edge(lat, lng)  # map-matching
        bucket = self.traffic_layer.get(edge_id)
        if bucket is None or timestamp - bucket.window_start > self.WINDOW_SECONDS:
            self.traffic_layer.set(edge_id, speed_sum=speed, ping_count=1, window_start=timestamp)
        else:
            self.traffic_layer.set(
                edge_id,
                speed_sum=bucket.speed_sum + speed,
                ping_count=bucket.ping_count + 1,
                window_start=bucket.window_start,
            )

    def current_speed_estimate(self, edge_id):
        bucket = self.traffic_layer.get(edge_id)
        if bucket is None or bucket.ping_count == 0:
            return None  # fall back to base_travel_time, no live signal
        return bucket.speed_sum / bucket.ping_count
```

**Data structures:**
* `traffic_layer`: `edge_id -> (speed_sum, ping_count, window_start)` — a rolling-window aggregate per edge, overwritten as new pings arrive, not a growing log
* Map-matching index: a spatial lookup from `(lat, lng)` to nearest `edge_id`, conceptually the same point-to-nearest-structure problem this course's Yelp case study covers for business listings, applied here to road segments instead of static points

**Trade-offs:**
* This design deliberately treats the traffic layer as an eventually-consistent, continuously-overwritten aggregate rather than a durable history: an individual ping that's lost or delayed by a few seconds has no meaningful effect on route quality, since the next ping from any of hundreds of other drivers on the same edge corrects the estimate almost immediately.
* That tolerance for staleness is exactly what makes it acceptable to update the traffic layer asynchronously and in a best-effort way rather than treating every ping as a transaction that must be durably applied before being acknowledged — a strong-durability design here would add latency and coordination cost for a freshness guarantee the product doesn't actually need.
* Road-class-based freshness tuning (a highway's traffic estimate matters more than a quiet residential street's) is a reasonable follow-up, not designed in depth here — see Additional talking points.

### Use case: User follows an active route with live re-routing

**Core spec: bounded-interval re-evaluation, not per-ping recomputation**

While a route is active, the client keeps reporting position pings, and an **ETA/re-route monitor** compares the reported position against the assigned route. Two conditions can trigger a recompute: the driver has physically deviated from the route (missed a turn, took a detour), or the traffic layer has shifted enough along the remaining route that an alternate path is now meaningfully faster — not just marginally faster, since recomputing and switching routes has its own cost in driver confusion and shouldn't fire on noise-level differences.

```python
REROUTE_CHECK_INTERVAL_SECONDS = 20
MIN_IMPROVEMENT_TO_REROUTE = 0.10  # 10% faster, not just nominally faster

def should_reroute(session, current_position, now, routing_service):
    if now - session.last_check < REROUTE_CHECK_INTERVAL_SECONDS:
        return False, None  # throttle: don't re-evaluate on every 5-second ping
    session.last_check = now

    if session.route.distance_from(current_position) > session.DEVIATION_THRESHOLD_METERS:
        new_route = routing_service.compute(current_position, session.destination)
        return True, new_route

    new_route = routing_service.compute(current_position, session.destination)
    if new_route.eta_seconds < session.route.remaining_eta_seconds(now) * (1 - MIN_IMPROVEMENT_TO_REROUTE):
        return True, new_route

    return False, None
```

**Data structures:** `session` — `device_id`, `route` (ordered edge list + per-step ETA), `last_check`, `destination`, `DEVIATION_THRESHOLD_METERS`.

**Trade-offs:**
* Rather than running a full route recomputation on every single position ping (which would multiply the routing service's query load by the ping rate for no benefit, since traffic doesn't meaningfully shift second to second), the monitor evaluates on a coarser interval — the same idea as the [Throttling](/docs/patterns/building-blocks/throttling) pattern applied to an internal decision rather than a client-facing API: bound the rate of an expensive operation to something proportional to how often its answer can actually change.
* The 10% improvement floor exists specifically to avoid rerouting on noise — a route that's marginally faster by a few seconds isn't worth the driver confusion of a sudden new instruction.
* When a recompute is triggered, it's a normal call into the same CH-accelerated routing path described above, just automated rather than user-initiated.

### Use case: Service renders map tiles for the current view

Map tiles are a textbook cacheable, read-heavy workload: a tile for a given area and zoom level is identical for every user looking at that location, changes rarely (road construction, new points of interest), and is requested constantly. Tiles are pre-rendered offline from the underlying map data at each zoom level and served as static assets through a [CDN](/docs/patterns/building-blocks/cdn) — the same slippy-map tile-pyramid convention popularized by OpenStreetMap-based tile servers and widely reused across the mapping industry — nearly all tile requests are served from an edge cache and never reach an origin server. This is architecturally the least novel part of the system, and deliberately so: the interesting engineering budget in this design goes toward the routing and traffic subsystems (skip the REST contract here — it's the same cache-first shape as TinyURL's redirect lookup in this course, keyed by `{zoom}/{x}/{y}` instead of a short code).

## Step 4: Scale the design

![Google Maps scaled architecture](/img/case-studies/google-maps-scaled.svg)

* **The routing service scales by geographic partitioning of the road graph, not by simply adding more identical replicas of a global graph.** A single machine holding the entire 700-million-edge world graph in memory is possible given the storage math above, but query latency and fault isolation both benefit from splitting the graph into regional shards (continent- or country-sized, with some overlap at boundaries so cross-region routes don't require an expensive multi-shard stitch on every query) — see [Sharding](/docs/patterns/storage/sharding). This also bounds blast radius: a routing outage or a bad graph update in one region doesn't take down routing anywhere else, similar in spirit to the per-city independence this course's Uber case study relies on for dispatch.
* **The traffic ingestion pipeline scales by partitioning the ping stream by geography and processing it independently of the query path.** Because aggregation only ever needs pings from drivers physically near a given edge, the same regional partitioning used for the graph applies naturally to traffic ingestion — a burst of pings in one city's rush hour doesn't compete for aggregation capacity with a quiet region elsewhere. See [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption).
* **Precomputed shortcuts age, and recomputing them for the whole world at once doesn't scale as a single batch job.** As roads open and close, the offline CH precomputation needs to be redone — but only for the regions that actually changed, incrementally, rather than reprocessing the entire global graph on every update cycle. This keeps the cost of staying correct proportional to the size of what changed, the same principle behind [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) applied to a graph structure instead of a database table.
* **Read load on the traffic layer is far higher than write load in query terms** — every route computation reads potentially thousands of edges' current traffic state, while any single edge is written to only as often as pings arrive for it. Keeping the traffic layer as an in-memory structure colocated with (or very close to) the routing servers that read it, rather than behind a network hop to a separate durable store on every query, is what makes sub-second routing possible at all — see [Cache-Aside](/docs/patterns/caching/cache-aside) for the general read-heavy access pattern this mirrors, applied here to a continuously-refreshed in-memory layer rather than a cache in front of a slower source of truth.
* **Multi-region failure isolation follows the same regional graph partitioning already in place.** Because a region's routing capability doesn't depend on any other region's graph shard or traffic layer, a regional outage degrades routing only for users physically in or near that region — there's no single global routing dependency to fail over as one unit, the same [Deployment Stamps](/docs/patterns/observability/deployment-stamps) idea this course applies elsewhere to per-region independence.

## Additional talking points

* **Why not just use straight-line (as-the-crow-flies) distance as a cheap pre-filter before running the full graph search?** It's a reasonable heuristic for guiding A\* (informing which direction to expand the frontier first), but it's a poor substitute for the search itself — road networks routinely make straight-line distance a bad proxy for actual travel time (a river, a highway with no nearby crossing, a one-way system). Worth distinguishing "use distance as a search heuristic" from "use distance instead of a real graph search," which are very different design choices.
* **Handling road closures and real-time incidents (accidents, construction) as a distinct signal from routine traffic congestion.** An incident report needs to be reflected in the traffic layer immediately and with much higher confidence than a single ping's speed estimate — worth discussing as a separate, higher-priority ingestion path rather than folding it into the same rolling-average aggregation used for ordinary congestion. It also has a second-order effect worth naming: a closure invalidates any CH shortcut edges that route through the closed segment, which is a stronger correctness requirement than nudging a speed estimate.
* **Alternate-route generation for the initial request.** Real navigation apps typically offer 2-3 route options, not just the single shortest path — generating genuinely different alternatives (not just near-duplicates of the same road with trivial variations) is a harder graph problem than it sounds, since naively re-running shortest-path search after removing the best route's edges can produce a route that's technically different but practically identical.
* **The traffic layer's freshness-versus-cost tradeoff is tunable per road class.** A rarely-traveled residential street doesn't need traffic estimates refreshed as aggressively as a major highway — allocating aggregation freshness proportional to a road's actual traffic-query volume is a reasonable follow-up optimization once the base design is in place.

## Source(s) and further reading

* [Contraction Hierarchies — Wikipedia](https://en.wikipedia.org/wiki/Contraction_hierarchies) — the offline shortcut-precomputation technique this design's routing core spec is built on
* [A\* search algorithm — Wikipedia](https://en.wikipedia.org/wiki/A*_search_algorithm) — the heuristic-guided half of the online query
* [Dijkstra's algorithm — Wikipedia](https://en.wikipedia.org/wiki/Dijkstra%27s_algorithm) — the base shortest-path mechanism both A\* and CH build on
* [OSRM (Open Source Routing Machine)](https://github.com/Project-OSRM/osrm-backend) — a real, widely-used open-source routing engine implementing contraction hierarchies
* [GraphHopper](https://www.graphhopper.com/) — another real routing engine using CH-based speed-ups, with public documentation of the technique
* [Materialized View](/docs/patterns/storage/materialized-view) — the general "precompute once, read cheaply many times" pattern CH is a graph-specific instance of
