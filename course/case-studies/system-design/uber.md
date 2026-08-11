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

### Use case: Driver reports live location

Every online driver's app pushes a location ping on an interval, over the persistent connection it already holds. These pings don't need the full request/response ceremony of a REST call, and the volume (hundreds of thousands per second) makes a lightweight push channel the right choice — see [WebSockets](/docs/patterns/communication/websockets) for the client-server channel and [Backpressure](/docs/patterns/batch-streaming/backpressure) for why the ingest path needs to shed or buffer load gracefully rather than fall over when a burst of drivers all report at once.

The location index itself doesn't live in the trip store or any durable relational database — it lives in an in-memory structure that supports fast "find nearby" queries. A common approach: divide the map into cells using a hierarchical geospatial grid (each cell is identified by a string-like cell ID at a chosen precision level, and neighboring cells have similar-looking IDs), and maintain a mapping of `cell_id -> [driver_id, driver_id, ...]`. Uber's own open-sourced H3 grid system and Google's S2 library are two well-known real implementations of exactly this hierarchical-cell idea, and either is a reasonable concrete starting point for the indexing scheme described here rather than a bespoke one. A ping updates a driver's cell membership; a "find nearby drivers" query resolves the rider's cell and its immediate neighbor cells (to catch drivers just across a cell boundary) and returns the union of driver lists. This is conceptually the same win that [Consistent Hashing](/docs/patterns/storage/consistent-hashing) gives for key distribution, applied to two spatial dimensions instead of one hash ring: turning an expensive "scan everything and compute distance" query into a cheap, indexed lookup.

Because there are far more drivers per city than any single machine's memory or query throughput can serve at peak, this index is sharded — most naturally by geography, since a cell in one city is never queried by a rider in another. Each shard owns a contiguous region of the grid; see [Sharding](/docs/patterns/storage/sharding) for the general mechanism.

Because location is inherently transient and quickly superseded by the next ping, staleness is tolerated. If a shard falls behind or a ping is dropped, a driver simply doesn't show up as a match candidate for a few seconds and then reappears — it's an availability/staleness tradeoff, not a correctness one, since the trip record itself (owned separately) is what actually needs strong consistency.

### Use case: Rider requests a ride, service finds a driver

* The rider's client sends a ride request with pickup location, destination, and vehicle type to the API layer
* The **dispatch service** resolves the pickup location's cell, queries the location index for nearby available drivers, and ranks candidates — primarily by ETA to pickup (which is a function of road distance and current traffic, not straight-line distance), with driver rating and vehicle-type match as secondary factors
* The dispatch service proposes the ride to the top candidate driver by pushing a ride-request event over that driver's open connection, with a short timeout (a handful of seconds)
* If the driver accepts, the dispatch service marks the driver unavailable in the location index, creates a trip record in the **trip store**, and notifies the rider
* If the driver rejects or the offer times out, dispatch moves to the next-ranked candidate

A useful design decision to call out explicitly: the "propose to one driver, wait, fall through to the next" flow is a sequential offer, not a broadcast to every nearby driver. A broadcast would fill a trip faster on average but creates a race between multiple drivers accepting simultaneously, which then needs a distributed decision about who actually won — solvable, but it trades simplicity for speed. Sequential offering avoids that race by construction, at the cost of slightly higher latency-to-match when the top candidate doesn't respond quickly. Either way, once a match is proposed and being decided, the driver's own record needs a single point of truth for "is this driver currently claimed" — a natural fit for [Leader Election](/docs/patterns/consistency/leader-election)-style single-writer ownership per driver, or more simply, an atomic conditional update on the driver's status row so two dispatch attempts can't both win the same driver.

Marking a trip as accepted is the one step in this whole flow that must not be lost or double-applied — a driver should never be assigned two simultaneous trips, and a rider should never be told "matched" for a trip that silently failed to persist. That write goes through the durable, strongly-consistent trip store, not the ephemeral location index, and should be idempotent so a client retry after a timeout can't create a duplicate trip — see [Idempotency](/docs/patterns/reliability/idempotency).

### Use case: Rider and driver track an active trip

Once a trip is accepted, both apps hold their persistent connection open and receive two kinds of updates: the driver's live position (relayed from the same location pings dispatch already ingests, just narrow-cast to this one rider instead of feeding the matching index) and trip status transitions (driver arrived, trip started, trip completed). Because both parties already have a channel open, this is push, not poll — a client polling every couple of seconds for 20 million concurrent riders would be an enormous amount of wasted request overhead compared to server-initiated updates on an already-open connection. [Server-Sent Events](/docs/patterns/communication/server-sent-events) is a reasonable simpler alternative to a full bidirectional WebSocket here, since most of this traffic is server-to-client.

ETA during a trip and ETA-to-pickup before a trip both depend on a routing/traffic model that's out of scope to design in depth here, but it's worth naming as a real dependency: dispatch's driver ranking and the rider-facing ETA display both call the same underlying service, so they should never visibly disagree.

### Use case: Service computes price estimates and surge pricing

Pricing starts from a base fare formula (a function of distance and estimated time for the route), then applies a multiplier driven by the live ratio of ride requests to available drivers in the rider's geographic cell. That ratio is a natural byproduct of data the dispatch service already has — cell occupancy from the location index, and request volume the dispatch service is already seeing per cell — aggregated over a short rolling window (tens of seconds) rather than computed fresh per request, since per-request computation at dispatch volume would be wasteful and the underlying supply/demand balance doesn't change fast enough to need it. This is a good fit for a [Materialized View](/docs/patterns/storage/materialized-view): a continuously-updated per-cell summary (open requests, available drivers, current multiplier) that pricing and dispatch both read cheaply, rather than each recomputing it from raw pings on every call.

The final fare, computed at trip completion from the actual route taken and actual time elapsed, is a write to the trip store and needs the same durability and idempotency treatment as trip state — a driver's app losing connectivity right as a trip ends should not risk charging a rider twice or not at all.

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
