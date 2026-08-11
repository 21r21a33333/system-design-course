---
title: "Design a Data Infrastructure Platform (Ingestion, Warehousing, Analytics)"
sidebar_position: 21
---

Most of this course's case studies build one product-facing system with one clear read/write shape. A data infrastructure platform is different: its "users" are every other system in the company, its input is whatever those systems happen to emit, and its job is to turn a firehose of raw, heterogeneous events into a warehouse that a human analyst can query in seconds — a pipeline problem more than a request/response problem, where the hard constraints are ingestion durability, schema evolution, and keeping a slow analytical workload from ever touching the systems still serving live production traffic.

*Educative's Grokking Modern System Design Interview course covers this same system in its "Design a Data Infrastructure System" module.*

## Step 1: Outline use cases and constraints

### Use cases

#### We'll scope the problem to handle the following use cases

* **Producer service** emits structured or semi-structured events (order placed, page viewed, payment processed) that the platform ingests durably, without ever blocking or slowing down the producing service itself
* **Platform** organizes ingested raw events into a queryable, structured **data warehouse**, handling schema differences and late-arriving or out-of-order events along the way
* **Platform** supports both **batch** processing (recompute a full historical aggregate on a schedule) and **streaming** processing (keep a small set of time-sensitive metrics current with minutes, not hours, of lag) over the same underlying event data
* **Analyst** runs ad-hoc SQL-style queries against the warehouse and gets a result without needing to know which of dozens of underlying source systems the data originally came from
* **Dashboard** displays a small set of frequently-viewed aggregate metrics that refresh on a regular schedule, without re-running an expensive query from scratch on every page view
* **Platform** enforces data retention and access-control policies so that raw and derived data is deleted or restricted according to compliance requirements, not kept indefinitely by default
* **Platform** has high ingestion durability — an event accepted by the platform is never silently dropped, even if a downstream processing stage is temporarily behind or unavailable

#### Out of scope

* The internal query-execution engine itself (how a distributed SQL engine plans and executes a join across billions of rows) — treated as an existing, adopted component this design integrates around, not something designed here
* Machine learning model training pipelines that consume warehouse data (a natural downstream consumer, but its own separate system)
* Real-time, sub-second operational dashboards driven directly by production databases (a different problem from this design's analytical, warehouse-backed dashboards)
* Data catalog / lineage UI tooling beyond a brief mention

### Constraints and assumptions

#### State assumptions

* Roughly 10,000 distinct event-producing sources across the company (backend services, mobile and web clients, third-party integrations), collectively producing a high-volume, continuous stream of events, not a small number of huge sources
* Ingestion must never apply backpressure onto a producing service — a producer's own request path (placing an order, loading a page) must never wait on or be slowed by this platform accepting its event
* Some analytics (fraud signals, live operational metrics) need results within minutes of an event occurring; the large majority of analytics (historical trend reports, monthly business reviews) tolerate hours of lag — this is a bimodal latency requirement, not a single uniform one, and the design treats it as two distinct paths rather than forcing everything through the faster path's cost
* An event, once durably accepted, must be recoverable and reprocessable — a bug discovered in a transformation job needs to be fixable by re-running that transformation against retained raw history, not by trying to patch already-derived, already-aggregated data by hand
* Events can and do arrive out of order and can arrive late (a mobile client offline for hours, then reconnecting) — correctness of aggregates can't assume in-order, on-time arrival
* Query latency for the dashboard path is expected to be near-instant (dashboards read pre-computed results, not raw events); ad-hoc analyst queries are expected to take seconds to low minutes, since they scan much larger, less pre-aggregated data

#### Calculate usage

* Ingestion volume: 10,000 sources × an average of 20 events/sec/source (most sources are quiet most of the time, a handful are very high-volume — 20/sec is a blended average across all of them) → **~200,000 events/sec average**, with ingestion traffic realistically peaking around business hours and specific triggered events (a marketing campaign, a product launch) at roughly **5x average**, so **~1,000,000 events/sec at peak** — this event-count figure, not raw bandwidth, is the number that most shapes the ingestion tier's design, since the tier has to durably accept a very high rate of small, independent writes, not a moderate rate of large ones
* Daily and yearly raw volume: 200,000 events/sec × 86,400 sec/day ≈ **~17.3 billion events/day**; at an average of 500 bytes/event (a JSON-like event with a handful of typed fields plus metadata) → 17,280,000,000 × 500 bytes ≈ **~8.6 TB/day** of raw ingested data, **~3.15 PB/year** before any compression
* Warehouse storage after compression: analytical column-store formats routinely achieve 4-6x compression on this kind of repetitive, typed event data (most columns have low cardinality relative to row count) — assuming a conservative **5x**, that's 3.15 PB/year ÷ 5 ≈ **~630 TB/year** of compressed warehouse storage, the number that actually governs warehouse capacity planning, not the raw pre-compression figure
* Analytics query load: assume 500 analysts running roughly 20 ad-hoc queries/day each (10,000 ad-hoc queries/day) plus 2,000 dashboards refreshing every 5 minutes across an 8-hour business day (2,000 × (8 × 60 / 5) = 192,000 dashboard-refresh queries/day) → 10,000 + 192,000 = **~202,000 analytics queries/day**, spread over an 8-hour business window (28,800 sec) ≈ **~7 queries/sec average** — a genuinely low number compared to ingestion's ~200,000 events/sec, which is the single fact that most shapes this design's read path: dashboard queries are so infrequent relative to ingestion volume that pre-computing their answers ahead of time, rather than scanning raw data live, comfortably keeps up

## Step 2: Create a high-level design

![Data Infrastructure Platform high-level architecture](/img/case-studies/data-infrastructure-overview.svg)

Every producing service publishes events to an **ingestion layer** — a durable, append-only log that accepts writes at very high volume and immediately acknowledges the producer (Apache Kafka is the canonical real-world system built around exactly this durable-log role, and a common concrete choice for this layer), decoupling "the event has been durably captured" from "the event has been processed," so a producer's own request path never waits on anything downstream. From there, two processing paths read the same underlying event log independently: a **stream processor** consumes events continuously and maintains a small set of time-sensitive aggregates with minutes of lag, while a **batch processor** runs on a schedule (typically hourly or nightly) over complete historical partitions, recomputing full, authoritative aggregates without the approximations or edge cases a continuously-updating stream job has to accept. Both paths write their results into a **data warehouse** (a columnar analytical store like Snowflake, BigQuery, or Redshift is a typical real-world fit for this role), organized into layers — raw ingested events, cleaned and conformed tables, and business-level aggregate tables — that an analyst queries directly, or that a **dashboard service** pre-materializes into cached results a page load reads instantly rather than triggering a fresh warehouse scan.

The structural bet this design makes is that **ingestion durability and processing correctness are separable concerns from query latency**, and each deserves its own tier tuned for its own workload rather than one monolithic pipeline trying to be good at all three. The ingestion layer is optimized for accepting a very high volume of small writes without ever rejecting or slowing a producer; the processing layers are optimized for correctly handling out-of-order and late data over both a fast and a slow path; and the query-serving layer is optimized for a comparatively low, bursty read volume against data that's almost always pre-aggregated rather than scanned raw. Conflating any two of these — for instance, making analysts query the raw ingestion log directly — would force one tier's constraints onto a workload it was never designed for.

## Step 3: Design core components

### Use case: Producer service emits events without ever being blocked by this platform

A production service placing an order or logging a page view cannot be made to wait on a downstream analytics pipeline's health.

**Core spec: durable append-only log as the synchronous contract boundary**

```
producer.publish(event) -> ack
  1. event is appended to the ingestion log, replicated across a small
     number of nodes for durability
  2. ack is returned to the producer as soon as the append is durable
     — nothing downstream of this point is on the producer's critical path
  3. cleaning, transformation, aggregation, warehouse loading all happen
     asynchronously, reading from the log at their own pace
```

**Data structures:**
* `ingestion_log` record — `event_id`, `event_type`, `producer_id`, `payload` (raw, as sent), `event_time`, `ingested_at`, `offset` (monotonically increasing, per-partition)

**Trade-offs:**
* Everything downstream of the ack is decoupled from the producer's own request path, in the same spirit as [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling): the producer's write rate and the platform's processing rate are allowed to differ, with the durable log absorbing the difference rather than forcing them to match in real time.
* [Backpressure](/docs/patterns/batch-streaming/backpressure) is applied between the log and its downstream consumers (stream and batch processors read at their own sustainable pace, buffered by the log's retention window), not between producers and the log itself — pushing backpressure back onto producers is exactly the coupling this design exists to avoid. Apache Kafka's [durability semantics](https://kafka.apache.org/documentation/#semantics) are a real, well-documented version of this exact append-ack-then-decouple contract.

### Use case: Platform organizes ingested events into a queryable warehouse, handling schema differences and late data

Raw events arrive with whatever shape their producing service happens to emit, and that shape drifts over time as services evolve independently.

**Core spec: layered tables (raw → conformed → aggregated), partitioned by event time**

```
raw_events            (event_time-partitioned, schema-on-read, append-only)
    │  transform stage: normalize field names, coerce types,
    │  resolve multiple schema versions of the same event_type
    ▼
conformed_events       (explicit versioned schema, event_time-partitioned)
    │  aggregation stage: batch or stream, per Lambda/Kappa below
    ▼
business_marts         (pre-aggregated to the grain analysts/dashboards query)
```

* A late event (something that happened three hours ago but arrived just now) is written into the *event-time* partition for three hours ago, not the partition for now
* An aggregate covering a partition is either held open for a bounded grace window before being considered final, or explicitly recomputed once enough late data has trickled in

**Data structures:**
* `conformed_events` — `event_id`, `event_type`, `schema_version`, normalized typed fields, `event_time` (partition key), `ingested_at`
* `business_marts` table — pre-aggregated rows at a fixed grain (e.g. `date`, `region`, `metric_name`, `value`)

**Trade-offs:**
* The raw layer preserves exactly what the producer sent, since that's the only copy that can be reprocessed later if a downstream transformation turns out to be wrong — this is the same underlying idea [Event Sourcing](/docs/patterns/storage/event-sourcing) relies on: the raw, ordered log is the durable source of truth, and every derived table is a replayable view built from it, not an independently-maintained copy that can silently drift.
* Partitioning by event time rather than arrival time is what makes late data correct instead of merely accepted — an aggregate that partitioned by arrival time would silently attribute a delayed mobile-client event to the wrong hour's numbers.

### Use case: Platform supports both batch and streaming processing over the same event data

Step 1 treats latency as bimodal: a small set of metrics genuinely need minutes-fresh answers, while the overwhelming majority of analytics tolerate — and actually prefer — the completeness of a full recomputation over the raw log. Real systems name this tradeoff directly as **[Lambda architecture](https://en.wikipedia.org/wiki/Lambda_architecture) vs. Kappa architecture**, and it's worth naming both explicitly rather than picking one silently.

**Lambda architecture** runs two separate processing paths against the same raw event log: a **batch layer** ([MapReduce](/docs/patterns/batch-streaming/mapreduce)-style jobs, commonly on a framework like Apache Spark) that periodically recomputes complete, authoritative aggregates from full historical partitions, and a **speed/stream layer** ([Stream Processing](/docs/patterns/batch-streaming/stream-processing), commonly Apache Flink or Kafka Streams) that maintains a much smaller set of windowed, continuously-updating aggregates for the handful of metrics that need minutes-fresh answers. A serving layer merges the two: recent numbers come from the fast, approximate stream path; anything the batch layer has already recomputed supersedes it.

**Kappa architecture** drops the batch path entirely and treats the stream processor as the only processing model — a "batch recompute" is just replaying the same durable log from an earlier offset through the identical stream-processing logic, not a separately maintained job.

**The gotcha:** Lambda's two-path shape has a specific, well-known failure mode — **the batch codebase and the stream codebase can silently diverge in their business logic**. A filter, a join condition, or a rounding rule gets fixed in the stream job during an incident but the equivalent fix never lands in the batch job (or lands differently), and the two paths start producing different numbers for the same underlying data depending on which one processed it — a discrepancy that's easy to ship unnoticed because both paths still run and both still produce *a* number, just not the *same* number. This divergence risk is exactly why most real systems now default to **Kappa**: reprocessing-from-log through one shared code path can't diverge from itself. Below is a simplified Kappa-style stream processor with a genuine replay/reprocess capability — the same `transform_fn` and windowing logic serve both live traffic and historical reprocessing:

```python
class WindowedAggregate:
    """A single time-windowed aggregate (e.g. orders per 5-minute window),
    keyed by window start. Holds only current computed state — state is
    always re-derivable from the log at a given offset, never a second
    independently-maintained copy.
    """

    def __init__(self, window_size_seconds):
        self.window_size_seconds = window_size_seconds
        self.windows = {}  # window_start -> running count

    def _window_start(self, event_time):
        return event_time - (event_time % self.window_size_seconds)

    def apply(self, event):
        w = self._window_start(event.event_time)
        self.windows[w] = self.windows.get(w, 0) + 1
        return w, self.windows[w]


class KappaStreamProcessor:
    """Stream-only processing: one code path handles both live traffic and
    historical reprocessing. Reprocessing = replaying the durable log from
    an earlier offset through the *same* transform_fn, not a second,
    separately-maintained batch job that can drift from this one.
    """

    def __init__(self, log, transform_fn, window_size_seconds=300):
        self.log = log                      # append-only, offset-addressable event log
        self.transform_fn = transform_fn    # business logic, shared by both modes
        self.aggregate = WindowedAggregate(window_size_seconds)
        self.committed_offset = -1

    def process_one(self, event):
        """The single shared code path for both live consumption and replay."""
        transformed = self.transform_fn(event)
        if transformed is None:
            self.committed_offset = event.offset
            return None
        window_start, count = self.aggregate.apply(transformed)
        self.committed_offset = event.offset
        return (window_start, count)

    def run_live(self, poll_batch):
        """Live mode: consume newly-arrived events from the log's current tail."""
        return [self.process_one(event) for event in poll_batch]

    def reprocess(self, from_offset, to_offset=None):
        """Batch-equivalent: replay historical events from the durable log
        through the identical transform_fn used in run_live. This is the
        Kappa answer to 'redo what the batch layer would have done' —
        there's no second codebase to keep in sync, just a different
        starting offset into the same log and a fresh aggregate state.
        """
        self.aggregate = WindowedAggregate(self.aggregate.window_size_seconds)
        for event in self.log.read_range(from_offset, to_offset):
            self.process_one(event)
        return self.aggregate.windows
```

**Data structures:**
* `Event` — `event_id`, `event_type`, `payload`, `event_time`, `offset` (position in the durable log)
* `WindowedAggregate.windows` — `window_start -> count`, the only persisted state, always rebuildable from the log

**Trade-offs:**
* Kappa's single-codepath guarantee only holds if reprocessing genuinely re-runs the *same* `transform_fn` — a design that keeps a "quick patch" path for live traffic and a slower, separately-maintained reprocessing script has quietly reintroduced Lambda's divergence risk under a different name.
* Kappa asks the stream layer to also be the system of record for full historical correctness, including replaying years of retained history through logic built for minutes-old data — this is why log retention (how far back `reprocess` can actually go) becomes a first-class capacity constraint under Kappa in a way it isn't under Lambda, where the batch layer reads from separately-retained historical storage instead of the stream's own retention window.
* This design defaults to Kappa's shape specifically because most of Step 1's query volume tolerates the latency of a full reprocess run, and a single shared code path removes an entire class of "which path is right" incidents; a Lambda-style dedicated batch layer is still the better trade for a platform whose historical-correctness jobs need to reach further back than any affordable stream-log retention window would allow. See [Lambda & Kappa Architecture](/docs/patterns/batch-streaming/lambda-kappa-architecture) and Confluent's [engineering discussion of the Kappa shape](https://milinda.pathirage.org/kappa-architecture.com/) for the original framing.

### Use case: Analyst runs ad-hoc queries against the warehouse

**Core spec: query targets the layer whose grain matches the question**

```
$ curl -X POST https://data-platform.example/api/v1/query \
    -d '{"sql": "SELECT region, SUM(revenue) FROM business_marts.daily_revenue WHERE date >= '\''2026-08-01'\'' GROUP BY region"}'
```

An analyst's query is a read against `conformed_events` or `business_marts`, never against `raw_events` directly — a query about daily active users by region reads from a table already aggregated to that grain, rather than re-scanning billions of raw events every time the same shape of question is asked.

**Data structures:** same layered tables as above; no new storage for this use case.

**Trade-offs:**
* This layered-table structure is the same underlying idea as [Materialized View](/docs/patterns/storage/materialized-view): expensive aggregation work happens once, on a schedule, off the interactive query path, and an analyst's query reads an already-computed result rather than triggering that aggregation itself.
* An analyst who genuinely needs raw-grain data (an investigation, not a standard report) can still query `raw_events` directly — the layering is a default routing choice for the common case, not a hard access restriction.

### Use case: Dashboard displays frequently-viewed metrics without re-running an expensive query per page view

Step 1's math makes this explicit: roughly 192,000 of the platform's ~202,000 daily analytics queries are scheduled dashboard refreshes hitting a comparatively small, well-known set of metrics, not novel ad-hoc questions.

**Core spec: pre-compute once per refresh interval, cache the result (not the query)**

```
1. business_marts is refreshed once per interval by the batch/stream
   aggregation jobs already producing the warehouse's aggregated tables
2. dashboard_cache[metric_id] = latest computed value + computed_at
3. GET /dashboard/:id -> read dashboard_cache, no warehouse scan triggered
```

**Data structures:** `dashboard_cache` — `metric_id`, `value`, `computed_at`, `refresh_interval_seconds`.

**Trade-offs:**
* Running a fresh warehouse scan on every one of ~192,000 daily refreshes would waste enormous query capacity re-deriving the same handful of numbers over and over — computing once and serving the cached result to every page load decouples that cost from the number of viewers.
* Follows the same shape as [Materialized View](/docs/patterns/storage/materialized-view): a dashboard page load is a cache read against a recently pre-computed value, and the expensive aggregation work is decoupled entirely from any individual user opening the dashboard.

## Step 4: Scale the design

![Data Infrastructure Platform scaled architecture](/img/case-studies/data-infrastructure-scaled.svg)

* **Ingestion scales by partitioning the log across many nodes, keyed by event type or producing source**, so no single partition has to absorb the platform's full ~1,000,000 events/sec peak alone. See [Sharding](/docs/patterns/storage/sharding). Most downstream processing is naturally scoped per event type or time window rather than needing a global ordering across all event types, so partitioning the log this way doesn't complicate correctness the way it would for a system (like this course's Payment System case study) where a single global ordering genuinely matters.
* **The warehouse is partitioned primarily by time**, since almost every query — dashboard or ad-hoc — is scoped to a bounded date range rather than the entire multi-year history. A query about last week's numbers should only scan last week's partitions, not the ~630 TB/year of full retained history — this is the main lever for keeping ad-hoc query latency in the seconds-to-low-minutes range Step 1 targets as total warehouse size grows year over year.
* **The stream-processing tier scales independently of ingestion, a deliberate consequence of decoupling them through the durable log.** A temporarily backed-up reprocessing run never blocks live stream consumption from continuing to update current aggregates, and neither one ever blocks ingestion from accepting new events — each stage reads from the log at its own pace and only [Backpressure](/docs/patterns/batch-streaming/backpressure)-signals the stage immediately upstream of it, never signaling back to the original producing service.
* **Reprocessing compute is the platform's most elastic cost driver, and the easiest tier to scale cost-effectively, because it's rarely latency-sensitive.** A reprocessing run that takes six hours instead of four is rarely user-visible the way a slow dashboard load is, so reprocessing capacity can be scaled up and down aggressively around actual replay windows rather than kept provisioned at a constant, peak-sized level — a very different cost profile from live stream ingestion, which has to be sized for sustained peak acceptance rate at all times since a producer's write can never be made to wait.
* **Retention and deletion have to be enforced consistently across every layer a piece of data touches, not just the raw layer it landed in first.** Because `raw_events` feeds `conformed_events`, which feeds `business_marts`, which feeds `dashboard_cache`, a compliance-driven deletion of a given record has to propagate through every derived layer it influenced — a materially harder problem than deleting a single row from a single table, and why retention policy is a first-class property of every layer's schema and job design, not an afterthought bolted onto the raw layer alone.

## Additional talking points

* **Why Kappa's "one code path" guarantee is only as strong as the discipline behind it.** Nothing stops a team from hand-patching a live stream job's logic without ever running the equivalent reprocess, which reintroduces Lambda-style drift by a different mechanism — Kappa removes the *structural* cause of divergence (two codebases) but doesn't remove the *operational* cause (an unreplayed hotfix), which is why this design treats "every logic change ships as a change to `transform_fn`, verified by a reprocess run over a recent window before being trusted" as a process requirement, not just an architectural one.
* **Schema evolution as an ongoing, permanent process, not a one-time migration.** With 10,000 independently-deployed producing sources, there is no moment where "the schema" is stable — some fraction of producers are always mid-migration to a new event shape. The conformed layer's versioned-schema handling is a permanent, load-bearing part of the design, since a platform this size never actually reaches a state where every producer agrees on one schema at once.
* **The relationship between this platform and the feature stores AI-serving systems rely on.** A [Feature Store](/docs/patterns/ai-infra/feature-store)'s offline store is frequently built directly on top of a data warehouse exactly like the one this design produces — the point-in-time-correct historical feature values a model-training pipeline needs are a specialized read pattern against the same kind of time-partitioned, event-derived tables this platform already maintains.
* **Cost as a first-class design constraint, not an afterthought.** Storing years of raw and derived event data at hundreds of terabytes to low petabytes a year is expensive regardless of underlying storage technology, and a platform at this scale typically tiers storage deliberately — recent, frequently-queried partitions on faster and more expensive storage, older partitions on slower and cheaper storage — a tradeoff that pays off clearly for data past a certain age even though it's rarely worth making for the freshest, most-queried data.

## Source(s) and further reading

* [Lambda architecture — Wikipedia](https://en.wikipedia.org/wiki/Lambda_architecture) — the two-path (batch + speed layer) shape, including its well-documented criticism around maintaining duplicate logic
* [Kappa Architecture — Milinda Pathirage](https://milinda.pathirage.org/kappa-architecture.com/) — the original write-up proposing stream-only reprocessing-from-log as Lambda's alternative
* [Apache Kafka: Durability and semantics](https://kafka.apache.org/documentation/#semantics) — a real, documented version of the append-ack-then-decouple ingestion contract this design's log tier relies on
* [MapReduce](/docs/patterns/batch-streaming/mapreduce) — the batch-aggregation shape referenced under Lambda's batch layer
* [Lambda & Kappa Architecture](/docs/patterns/batch-streaming/lambda-kappa-architecture) — this course's own pattern page naming both shapes directly
