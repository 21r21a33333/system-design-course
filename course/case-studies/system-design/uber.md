---
title: "Design Uber (or a Ride-Sharing Dispatch System)"
sidebar_position: 9
---

A ride-sharing dispatch system has to solve a problem most of this course's other case studies don't: both sides of every transaction are physically moving in real time, and the system has seconds, not minutes, to make a good matching decision.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design Uber" module, including a dedicated "Uber Eats System Design (Mock Interview)" sub-lesson.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **Rider** requests a ride by submitting a pickup location and destination
* **Service** finds a nearby available driver and proposes the match
* **Driver** accepts or rejects a ride request
* **Service** tracks the live location of drivers and in-progress trips
* **Rider** and **driver** each see the other's live position and an ETA during an active trip
* **Service** computes a price estimate before the ride and a final fare after the ride, including surge/demand pricing
* **Service** has high availability; a dispatch outage in one city should not affect others

#### Out of scope

* Payments processing and driver payouts
* Driver onboarding, background checks, and vehicle verification
* In-app chat between rider and driver
* Ride pooling / multi-passenger matching (worth mentioning as a follow-up, not designing in depth)
* Fraud and abuse detection beyond a passing mention

### Constraints and assumptions

#### State assumptions

* 20 million daily active riders, 2 million daily active drivers, across many independent metro markets
* An active driver reports its GPS position roughly every 4 seconds while online, whether or not it's on a trip
* Average of 3 ride requests per active rider per day
* A dispatch decision (finding and proposing a driver) must complete in well under a second — riders abandon the app past a few seconds of "finding your driver"
* Live location during a trip needs to feel real-time to a human (low seconds of staleness is fine; sub-second is not required)
* Matching only ever needs to consider drivers within a few kilometers of the rider — global search is never useful
* It's fine for the location index to be slightly stale (a driver that went offline 3 seconds ago might still show as a match candidate momentarily) — this is an availability-over-strict-consistency system for location data, though the trip/payment record itself needs to be strongly consistent
* Each metro market can be operated close to independently; a rider in one city is never matched to a driver in another

#### Calculate usage

* Location pings: 2 million online drivers × 1 ping / 4 sec = **500,000 location writes/sec** at peak globally
    * Each ping: `driver_id` (8 bytes) + `lat`/`lng` (8 bytes each) + `timestamp` (8 bytes) + `heading`/`speed` (8 bytes) ≈ 40 bytes → **~20 MB/sec** of raw location ingest at global peak
* Ride requests: 20 million riders × 3 rides/day = 60 million ride requests/day
    * 60,000,000 / 86,400 sec ≈ **~700 requests/sec average**, but trip demand is extremely peaky by time-of-day and city (commute hours, weekend nights) — design for **5-10x average at peak**, so ~4,000-7,000 dispatch requests/sec
* Trip record storage: `trip_id`, `rider_id`, `driver_id`, `origin`, `destination`, `requested_at`, `accepted_at`, `started_at`, `completed_at`, `fare`, `status`, plus a route polyline (~2 KB compressed for a typical trip's path) ≈ **~2.2 KB/trip**
    * 60 million trips/day × 2.2 KB ≈ **~132 GB/day** of trip records, ~48 TB/year — this is comfortably shardable and the polyline data is the dominant cost, so it's a natural candidate to move to cheaper blob storage instead of living in the primary trip table
* Location history (if retained for ETA-model training, fraud review, support disputes) dwarfs the trip table: 500,000 pings/sec × 86,400 sec × 40 bytes ≈ **~1.7 TB/day** if every ping were kept forever, which argues strongly for treating live location as ephemeral and only persisting a downsampled trip route after the fact

## Step 2: Create a high-level design

![Uber high-level architecture](/img/case-studies/uber-overview.svg)

A rider's client and a driver's client both talk to an API layer over the public internet, but they use it very differently: the driver client is a near-constant stream of location pings, while the rider client mostly makes short bursts of requests around ride request, matching, and trip completion. Both keep a persistent connection open during an active trip so location updates and status changes can push to the client instead of being polled.

The core of the system is a **dispatch service** that answers one question well: "which available drivers are near this rider, right now?" It answers that by querying a **geospatial location index** that's kept in memory and updated continuously from driver pings, rather than by scanning a database of driver rows. Once a candidate driver is found and accepts, a **trip service** takes over and owns the strongly-consistent lifecycle of that trip (accepted → en route → in progress → completed), persisting it to a durable **trip store**. A separate **pricing service** computes estimates and final fares, consulting near-real-time supply/demand signals per geographic cell rather than global averages.

## Step 3: Design core components

### Use case: Driver reports live location, service finds nearby drivers

The hard problem: given a rider's coordinates, find the closest available drivers among millions of moving points, without scanning every driver's position on every request.

**Core algorithm: geohash-based spatial index with expanding-ring search**

A [Geohash](https://en.wikipedia.org/wiki/Geohash) encodes a `(lat, lng)` pair into a short base-32 string where nearby points usually share a prefix — the map is recursively divided into a grid of cells, each identified by a string that gets one character longer (and the cell it names smaller) per unit of added precision. That gives an index that's just a hash map from cell ID to the drivers currently in it, and a "nearby drivers" query becomes a handful of cell lookups instead of a distance calculation against every driver in the city.

```python
import geohash  # a standard geohash encode/decode implementation

class DriverLocationIndex:
    """In-memory spatial index: geohash cell -> set of available driver_ids.

    Precision 6 (~1.2km x 0.6km cells) is a reasonable starting
    resolution for urban ride matching -- coarse enough that most
    rides find candidates in ring 0 or 1, fine enough that a ring
    doesn't sweep in drivers from across town.
    """
    PRECISION = 6

    def __init__(self):
        self.cells = {}              # geohash str -> set(driver_id)
        self.driver_cell = {}        # driver_id -> geohash str (for removal/move)

    def update_location(self, driver_id, lat, lng):
        new_cell = geohash.encode(lat, lng, precision=self.PRECISION)
        old_cell = self.driver_cell.get(driver_id)
        if old_cell == new_cell:
            return  # still in the same cell, nothing to move
        if old_cell is not None:
            self.cells[old_cell].discard(driver_id)
        self.cells.setdefault(new_cell, set()).add(driver_id)
        self.driver_cell[driver_id] = new_cell

    def remove_driver(self, driver_id):
        cell = self.driver_cell.pop(driver_id, None)
        if cell is not None:
            self.cells.get(cell, set()).discard(driver_id)

    def find_nearby(self, lat, lng, min_candidates=5, max_rings=4):
        """Expanding-ring search: start at the rider's own cell, and
        only widen the search to the ring of 8 surrounding cells (then
        16, then 24...) if the current radius doesn't have enough
        candidates yet. Most requests in a dense city resolve at ring
        0 or 1 -- widening further is the exception, not the norm.
        """
        center = geohash.encode(lat, lng, precision=self.PRECISION)
        found = set(self.cells.get(center, ()))
        ring = 0
        while len(found) < min_candidates and ring < max_rings:
            ring += 1
            for cell_id in geohash.neighbors_at_ring(center, ring):
                found |= self.cells.get(cell_id, set())
        return found
```

A ping updates a driver's cell membership in place; a "find nearby drivers" query resolves the rider's cell, checks it, and only pays for wider ring lookups when the immediate cell is sparse — a dense downtown core rarely needs to widen past ring 0, while a driver-scarce suburb might widen to ring 2-3 before finding enough candidates. This is the same "turn a scan into an indexed lookup" idea [Consistent Hashing](/docs/patterns/storage/consistent-hashing) applies to a single hash ring, extended to two spatial dimensions. [Uber's own open-sourced H3 grid](https://h3geo.org/) and [Google's S2 library](https://s2geometry.io/) are two well-known real implementations of a hierarchical-cell index built on this same idea, using hexagonal or quad-tree cells instead of geohash's rectangular ones specifically to avoid the "nearest point is in an adjacent cell, not mine" edge case rectangular grids are more prone to — a reasonable production choice over a bespoke geohash implementation.

**Data structures:**
* `cells`: `geohash_str -> set(driver_id)` — the core spatial index, in memory
* `driver_cell`: `driver_id -> geohash_str` — reverse lookup so a driver's next ping can remove them from their old cell in O(1) rather than scanning
* Each driver's full record (rating, vehicle type, current trip status) lives in a separate keyed store; the index above holds only IDs, kept intentionally small so it can be sharded and rebuilt fast

**Trade-offs:**
* **The gotcha:** geohash cells are rectangular, and a rider sitting a few meters from a cell boundary can have a closer driver sitting in the *adjacent* cell that a naive "just look in my own cell" query would miss entirely — this is exactly why the search has to check neighboring cells, not just the exact-match cell, and it's the detail that separates a working nearest-neighbor design from one that silently returns wrong answers near every cell edge. H3 and S2 reduce (but don't eliminate) this by using cell shapes and multi-resolution indexing designed to make "which cells could plausibly contain the true nearest neighbor" cheaper to compute correctly.
* Precision is a tuning knob with a real trade: coarser cells (shorter geohash prefix) mean fewer, cheaper lookups but more candidates to rank and discard per query; finer cells mean the opposite, and can force more ring expansions in sparse areas. A real system tunes this per city density rather than using one global precision.
* Because location is inherently transient and superseded within seconds by the next ping, staleness here is a deliberate, acceptable trade — an index shard that's a few seconds behind just means a driver briefly doesn't show up as a candidate, not a correctness failure, since the trip record (owned separately by the strongly-consistent trip store) is what actually needs to be right.
* This index is sharded by geography once a single city's driver density exceeds one shard's memory or query throughput — see [Sharding](/docs/patterns/storage/sharding); a cell in one city is never queried by a rider in another, which makes the shard boundary a natural, low-coordination-cost choice.

### Use case: Rider requests a ride, service finds a driver

* The rider's client sends a ride request with pickup location, destination, and vehicle type to the API layer
* The **dispatch service** calls `find_nearby` against the location index, then ranks candidates — primarily by ETA to pickup (a function of road distance and current traffic, not straight-line distance), with driver rating and vehicle-type match as secondary factors
* The dispatch service proposes the ride to the top candidate driver by pushing a ride-request event over that driver's open connection, with a short timeout (a handful of seconds)
* If the driver accepts, the dispatch service marks the driver unavailable in the location index, creates a trip record in the **trip store**, and notifies the rider
* If the driver rejects or the offer times out, dispatch moves to the next-ranked candidate

**Data structures:** trip record — `trip_id` (PK), `rider_id`, `driver_id`, `status` (`requested`/`accepted`/`in_progress`/`completed`/`cancelled`), `origin`, `destination`, `requested_at`, `accepted_at`.

**Trade-offs:**
* **The gotcha:** the "propose to one driver, wait, fall through to the next" flow is a sequential offer, not a broadcast to every nearby driver, and that's a deliberate choice, not an oversight — a broadcast fills a trip faster on average but creates a race between multiple drivers accepting simultaneously, which then needs a distributed decision about who actually won. Sequential offering avoids that race by construction (only one driver is ever "the offer" at a time) at the cost of slightly higher latency-to-match when the top candidate doesn't respond quickly. Whichever shape is chosen, the driver's status needs a single point of truth — an atomic conditional update on the driver's status row (or [Leader Election](/docs/patterns/consistency/leader-election)-style single ownership per driver) so two dispatch attempts can never both win the same driver.
* Marking a trip accepted is the one write in this flow that must not be lost or double-applied — a driver should never be assigned two simultaneous trips, and a rider should never be told "matched" for a trip that silently failed to persist. That write goes through the durable trip store, not the ephemeral location index, and must be idempotent so a client retry after a timeout can't create a duplicate trip — see [Idempotency](/docs/patterns/reliability/idempotency).

**REST API:**

```
$ curl -X POST https://uber.example/api/v1/rides \
    -d '{"pickup": {"lat": 37.7749, "lng": -122.4194}, "destination": {"lat": 37.8044, "lng": -122.2712}, "vehicle_type": "standard"}'
```

Response:

```json
{
  "trip_id": "t_8f3a1c",
  "status": "requested",
  "estimated_fare": {"low": 14.50, "high": 18.00, "surge_multiplier": 1.2}
}
```

### Use case: Rider and driver track an active trip

Once a trip is accepted, both apps hold their persistent connection open and receive two kinds of updates: the driver's live position (relayed from the same location pings dispatch already ingests, just narrow-cast to this one rider instead of feeding the matching index) and trip status transitions (driver arrived, trip started, trip completed). Because both parties already have a channel open, this is push, not poll — a client polling every couple of seconds for 20 million concurrent riders would be an enormous amount of wasted request overhead compared to server-initiated updates on an already-open connection. [Server-Sent Events](/docs/patterns/communication/server-sent-events) is a reasonable simpler alternative to a full bidirectional WebSocket here, since most of this traffic is server-to-client.

**Data structures:** same trip record as above, `status` field driving what's pushed; no separate storage needed for the live position stream itself, since it's relayed, not persisted at full frequency.

**Trade-offs:**
* ETA during a trip and ETA-to-pickup before a trip both depend on a routing/traffic model that's out of scope to design in depth here, but it's worth naming as a real dependency: dispatch's driver ranking and the rider-facing ETA display both call the same underlying service, so they should never visibly disagree.
* Same push-over-poll reasoning as WhatsApp's message delivery elsewhere in this course, but the payload here is different in kind — a continuous position stream rather than discrete messages — so the design doesn't need delivery guarantees as strict as message delivery; a dropped position update is superseded by the next one a few seconds later.

### Use case: Service computes price estimates and surge pricing

The hard problem isn't the base fare formula (distance and time, mechanically simple) — it's computing a demand multiplier per zone that responds to real supply/demand imbalance without creating jarring price cliffs between two adjacent city blocks.

**Core algorithm: per-cell demand/supply ratio with spatial smoothing**

```python
class SurgePricingEngine:
    """Maintains a demand/supply multiplier per geohash cell, updated
    from a short rolling window of dispatch activity, then smoothed
    across neighboring cells so adjacent riders never see a jarring
    multiplier discontinuity at a cell boundary.
    """
    BASE_MULTIPLIER = 1.0
    MAX_MULTIPLIER = 5.0
    SMOOTHING_WEIGHT = 0.4   # how much a cell's multiplier is pulled toward its neighbors' average

    def __init__(self, location_index):
        self.location_index = location_index
        self.open_requests = {}   # cell_id -> count of unmatched requests in the current window

    def record_request(self, lat, lng):
        cell_id = geohash.encode(lat, lng, precision=6)
        self.open_requests[cell_id] = self.open_requests.get(cell_id, 0) + 1

    def raw_multiplier(self, cell_id):
        """Multiplier from this cell's own demand/supply ratio alone,
        before any smoothing. A cell with no drivers and any open
        requests is treated as maximally scarce.
        """
        demand = self.open_requests.get(cell_id, 0)
        supply = len(self.location_index.cells.get(cell_id, ()))
        if demand == 0:
            return self.BASE_MULTIPLIER
        if supply == 0:
            return self.MAX_MULTIPLIER
        ratio = demand / supply
        return min(self.MAX_MULTIPLIER, self.BASE_MULTIPLIER + ratio)

    def smoothed_multiplier(self, cell_id):
        """Pull each cell's multiplier toward the average of its ring-1
        neighbors. Without this, a rider one block from a stadium
        exiting a sold-out event can see a wildly different price than
        someone standing at the stadium's own doorstep, purely because
        they're in different geohash cells -- the smoothing is what
        keeps the surge map from looking like noise.
        """
        own = self.raw_multiplier(cell_id)
        neighbor_cells = geohash.neighbors_at_ring(cell_id, 1)
        neighbor_values = [self.raw_multiplier(c) for c in neighbor_cells]
        if not neighbor_values:
            return own
        neighborhood_avg = sum(neighbor_values) / len(neighbor_values)
        return (1 - self.SMOOTHING_WEIGHT) * own + self.SMOOTHING_WEIGHT * neighborhood_avg
```

The demand/supply ratio is a byproduct of data the dispatch service already has — cell occupancy from the location index, and request volume the dispatch service is already seeing per cell — aggregated over a short rolling window (tens of seconds) rather than computed fresh per request. Smoothing runs on the same schedule, not per-request, since recomputing a full neighborhood average on every ride request would be wasted work when the underlying supply/demand balance doesn't shift that fast. This is a good fit for a [Materialized View](/docs/patterns/storage/materialized-view): a continuously-updated per-cell summary (open requests, available drivers, smoothed multiplier) that pricing and dispatch both read cheaply.

**Data structures:**
* `open_requests`: `cell_id -> count`, reset on a rolling window
* `surge_multipliers` (materialized view, refreshed on the same interval): `cell_id -> smoothed_multiplier`, read by both the estimate endpoint and the final-fare calculation

**Trade-offs:**
* **The gotcha:** computing surge purely per-cell, with no smoothing, is the naive version of this feature and it visibly breaks at cell boundaries — two riders standing 50 meters apart but in different geohash cells can be quoted meaningfully different multipliers for what's obviously the same local supply/demand situation, which reads as arbitrary and erodes trust in the pricing even when each individual cell's number is technically correct. Spatial smoothing (blending each cell's raw ratio with its neighbors') is what turns a noisy per-cell signal into a surge map that changes gradually across a city rather than in visible steps — see [surge pricing](https://en.wikipedia.org/wiki/Surge_pricing) for the general demand-based pricing mechanism this implements.
* The final fare, computed at trip completion from the actual route and time elapsed (using the multiplier locked in at request time, not a possibly-different multiplier by trip's end), is a write to the trip store and needs the same durability and idempotency treatment as trip state — a driver's app losing connectivity right as a trip ends should not risk charging a rider twice or not at all.
* Smoothing trades responsiveness for stability: a real spike in one cell gets diluted by calmer neighbors, which is usually the right behavior (avoids a price spike from one lucky/unlucky cell boundary) but means the multiplier lags a true highly-localized surge by design.

## Step 4: Scale the design

![Uber scaled architecture](/img/case-studies/uber-scaled.svg)

The two components under the most distinct kinds of pressure are the location index (extremely high write volume, tight latency requirement, tolerant of staleness) and the trip store (much lower volume, but must be strongly consistent and durable). Scaling them the same way would be a mistake — they have almost opposite requirements.

**The location index scales by geographic sharding.** Splitting shards by metro area is a natural first cut since cross-city queries never happen, but a single very dense city (say, a major metro at rush hour) can still overload one shard. The fix is the same idea one level down: split that city's grid into more, smaller cells, each still owned by a shard, so no single shard is responsible for an unbounded number of drivers. This is exactly what [Sharding](/docs/patterns/storage/sharding) and [Consistent Hashing](/docs/patterns/storage/consistent-hashing) are for — the harder part in practice is that shard boundaries need to be redrawn as a city's driver density changes over the course of a day (rush hour vs. 3 AM), which argues for dynamic re-partitioning rather than a fixed assignment decided once at deploy time.

**Location writes are the dominant traffic and don't need synchronous handling.** A driver ping doesn't need to be acknowledged with "the index has been updated" before the driver's app moves on — it can be dropped onto a [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue) (Apache Kafka or a cloud-managed equivalent is a common real-world choice for this kind of high-throughput, append-only ingest) and applied to the index asynchronously by a pool of consumers, decoupling ingest rate from index-update rate and letting the index-update side scale independently and absorb bursts. This also gives a natural place to fan the same ping out to two consumers — one updating the matching index, one relaying to any rider currently tracking that driver — without the ingest path needing to know about both.

**The trip store scales by sharding on `trip_id` (or `rider_id`), with primary-replica replication for read scaling.** Trip lookups (a rider checking their current trip status, a support agent pulling up trip history) are far more frequent than trip writes (created once, updated a handful of times over a trip's lifecycle), so [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) handles the read load while all writes go through the primary for that shard to preserve consistency on trip state transitions.

**Matching latency under load benefits from precomputation.** Rather than computing "who's nearby" fresh on every single ride request, the per-cell supply/demand aggregates from pricing can double as a fast pre-filter: a cell already known to have zero available drivers doesn't need a full index query before dispatch decides to check neighboring cells. This is the same materialized-view idea as pricing, reused as a cache-aside optimization in front of the location index — see [Cache-Aside](/docs/patterns/caching/cache-aside).

**Multi-region and disaster recovery follow city boundaries, not a single global failover unit.** Because cities are already operated independently, a regional outage only needs to fail over the cities whose primary shards lived in that region — there's no requirement (and no benefit) to treating the whole system as one global unit that lives or dies together. This keeps blast radius proportional to the outage, which is the same principle behind [Deployment Stamps](/docs/patterns/observability/deployment-stamps).

## Additional talking points

* **What happens if the dispatch service picks a driver who then goes offline (phone dies, tunnel, app crash) mid-offer?** The proposal timeout handles the common case, but a driver who accepted and then drops needs the trip service to detect the failure (missed pings, a heartbeat timeout) and re-open dispatch for that rider — worth walking through as a failure-mode discussion, and a good place to bring up [Timeout](/docs/patterns/reliability/timeout) and [Circuit Breaker](/docs/patterns/reliability/circuit-breaker) for how the trip service treats a driver connection that's gone silent.
* **Why not just use each device's GPS coordinates directly as the index key, skipping cells entirely?** Raw lat/lng pairs don't cluster into anything queryable — "find drivers near (37.77, -122.41)" over raw coordinates means scanning for proximity, which is exactly the cost cells are designed to avoid. The tradeoff is precision: a coarser cell size means cheaper queries but coarser candidate lists (more false-positive "nearby" drivers to rank and discard); a finer cell size means the opposite. Worth discussing how that precision level might even vary by city density.
* **Driver-side vs. rider-side fairness.** Sequential offering (Step 3) optimizes for correctness and simplicity but can systematically favor or disadvantage certain drivers depending on ranking order — a real system has to think about long-run fairness in who gets offered trips, not just per-request optimality. Good to raise even though it's more product/policy than infra.
* **Surge pricing as a supply-shaping signal, not just a demand-dampening one.** The multiplier doesn't only ration scarce rides to riders willing to pay more — it's also the signal that pulls more drivers into a high-demand cell by making it visibly more profitable, which is a feedback loop worth mentioning even though modeling it isn't necessary for the design.

## Source(s) and further reading

* [Geohash — Wikipedia](https://en.wikipedia.org/wiki/Geohash) — the spatial-indexing encoding this design's location index is built on
* [H3: Uber's Hexagonal Hierarchical Spatial Index](https://h3geo.org/) — a real, production-grade hierarchical geospatial index, using hexagonal cells specifically to reduce the boundary-adjacency problem named as this use case's gotcha
* [S2 Geometry Library](https://s2geometry.io/) — Google's comparable hierarchical spatial index, a widely-used alternative to H3 for the same class of problem
* [Surge pricing — Wikipedia](https://en.wikipedia.org/wiki/Surge_pricing) — the general demand-based pricing mechanism this design's `SurgePricingEngine` implements
* [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the general "expensive scan becomes indexed lookup" idea this design's spatial index applies in two dimensions
