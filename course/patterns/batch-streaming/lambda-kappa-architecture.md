---
title: "Lambda & Kappa Architecture"
sidebar_position: 3
supplementary: true
---

Lambda and Kappa architecture are two approaches to combining batch and
real-time processing over the same data: Lambda runs a batch layer and a
speed layer side by side and merges them at query time, while Kappa
treats stream processing as the only model and re-derives batch-style
results by replaying the log.

![Lambda and Kappa architecture diagram](/img/patterns/lambda-kappa-architecture.svg)

## Problem it solves

Real-time processing alone often can't be fully trusted. A streaming
job might use approximate algorithms for speed, might drop late-arriving
data past some cutoff, or might simply have a bug that a full
recomputation from raw history would catch and correct. But batch
processing alone is too slow for anything latency-sensitive — a nightly
recompute can't power a live dashboard. Systems that need *both* an
accurate, complete view of history *and* a fast, up-to-the-second view
need an architecture that reconciles the two rather than picking one.
The two architectures answer that need differently: Lambda accepts two
processing paths and merges them; Kappa insists one path, replayable, is
enough.

## Technical architecture & implementation

**Lambda: batch layer + speed layer + serving layer.** Lambda runs two
parallel paths over the same incoming data. The **batch layer** stores
all raw data immutably as a master dataset and periodically recomputes
results from scratch (or over a large window) using something like
[MapReduce](/docs/patterns/batch-streaming/mapreduce) or a Spark batch
job — producing complete, accurate, but delayed **batch views**. The
**speed layer** processes the same data as it arrives via
[stream processing](/docs/patterns/batch-streaming/stream-processing),
producing low-latency but approximate or incremental **real-time views**
that cover only the recent window the batch layer hasn't caught up to
yet. The **serving layer** merges the two at query time: it answers from
the batch view for all data old enough to have been batched, and
patches in the speed-layer view for the most recent, not-yet-batched
slice. As each batch run completes, the window it now covers is dropped
from the speed layer — the real-time view is deliberately disposable.

**The self-healing property — and the code-duplication pain.** Lambda's
signature virtue is that the batch layer *reprocesses everything from
immutable raw data every run*, so any bug, any dropped event, any
approximation in the speed layer is automatically corrected within one
batch cycle — the batch view is authoritative and eventually overwrites
the approximate one. Its signature cost is that the *same business
logic must be implemented twice*: once in the batch framework and once,
differently, in the streaming framework. Keeping two divergent
codebases computing the identical result — and staying consistent as
requirements change — is the operational tax that motivated Kappa.

**Kappa: one stream, reprocess by replay.** Kappa drops the batch layer
entirely. All data, historical and new, lives as a single immutable,
**replayable log** (Kafka being the canonical backing store) that is the
single source of truth. A stream processor consumes the log
continuously to produce and serve views. When logic needs to change — a
bug fix, a new feature, a schema change — you don't run a separate
batch job; you **replay** the log from offset zero (or a chosen point)
through a *new* instance of the streaming job running the updated code,
build a fresh output alongside the old one, and cut over when it catches
up to the live tip. Reprocessing and normal processing are the *same
code path*, just fed from a different starting offset — which is exactly
what eliminates Lambda's duplicated logic. The precondition is a log
retained long enough (or compacted appropriately) to replay the history
you care about.

**Relationship to CDC and event sourcing.** Kappa's "the log is the
source of truth" premise is the same one behind
[event sourcing](/docs/patterns/storage/event-sourcing), and the
replayable log is frequently *fed* by
[change data capture](/docs/patterns/batch-streaming/change-data-capture)
from operational databases. Kappa is best understood as event sourcing's
processing counterpart at data-pipeline scale: state is a fold over an
immutable event log, and you can always rebuild it by re-folding.

**Failure modes.** Lambda's risk is *drift* — the batch and speed
implementations subtly disagree, so the answer visibly changes when a
window crosses from speed to batch. Kappa's risk is *replay cost and
retention* — reprocessing a very large history can be slow and
resource-heavy, and a log that isn't retained long enough simply can't
be replayed, which pushes some Kappa systems back toward keeping a batch
recompute path for cold history.

## Lambda vs. Kappa at a glance

| Aspect | Lambda | Kappa |
| --- | --- | --- |
| Processing paths | Two (batch + speed) | One (stream) |
| Codebases for one logic | Two | One |
| Source of truth | Master dataset (raw) | Immutable replayable log |
| Reprocessing | Batch layer recomputes each run | Replay the log through new code |
| Correcting a bug | Fixed next batch cycle | Replay from an earlier offset |
| Serving | Merge batch + real-time views | Serve from stream-built views |
| Main cost | Duplicated batch/stream logic | Replay time + log retention |
| Best when | Batch truly needs a different/heavier algorithm | Same logic serves both; avoid dual code |

## Code example

Kappa's defining move is that *reprocessing is just replay through the
same code from an earlier offset*. This models an immutable log and a
stream processor that folds it into per-key totals; a bug fix ships not
as a separate batch job but by replaying the identical log through the
corrected rule.

```rust
use std::collections::HashMap;

// An immutable, replayable log of raw events — the single source of truth in
// a Kappa architecture. Reprocessing means re-reading it from an offset.
struct EventLog {
    events: Vec<(u64, String, i64)>, // (offset, key, delta)
}

// A stateful stream processor deriving a per-key running total. It tracks the
// offset consumed through, so a fresh instance can replay from 0 to rebuild
// the same state under new logic.
#[derive(Default)]
struct RunningTotals {
    totals: HashMap<String, i64>,
    consumed_through: u64,
}

impl RunningTotals {
    // Process events strictly after `from`. Version `v2` applies a corrected
    // rule (ignore negative deltas) — the bug fix ships by replaying the same
    // log through the new code, with no separate batch layer.
    fn consume(&mut self, log: &EventLog, from: u64, v2: bool) {
        for (offset, key, delta) in &log.events {
            if *offset <= from {
                continue;
            }
            let keep = if v2 { *delta >= 0 } else { true };
            if keep {
                *self.totals.entry(key.clone()).or_insert(0) += delta;
            }
            self.consumed_through = *offset;
        }
    }
}
```

Consuming the log under the original rule folds every delta into the
totals; a fresh processor replaying the *same* log from offset 0 under
the `v2` rule drops the spurious negative delta and arrives at the
corrected total — the reprocessing story that lets Kappa retire Lambda's
separate batch layer. Feeding a log of `a:+5, b:+3, a:-2, a:+4` yields
`a=7` under v1 and `a=9` under a v2 replay.

## When to use it

- **Lambda** fits when a genuinely different, heavier algorithm is worth
  running in batch than can run in real time (multiple passes, exact
  computations a streaming job only approximates), and the team accepts
  operating two systems.
- **Kappa** fits when the same processing logic can serve both needs and
  avoiding two divergent codebases for one business rule is the
  priority — and the log can be retained long enough to replay.
- Either applies where a single point-in-time streaming result isn't
  trusted enough to stand alone and must be reconcilable against a
  from-scratch recomputation.

## When not to use it

- Purely batch workloads with no latency requirement — plain
  [MapReduce](/docs/patterns/batch-streaming/mapreduce) or a Spark job is
  simpler.
- Purely real-time workloads needing no reconciled historical view —
  plain [stream processing](/docs/patterns/batch-streaming/stream-processing)
  is simpler.
- **Lambda specifically** when the team can't sustain the cost of
  keeping two implementations of one logic consistent — the exact pain
  Kappa was created to remove; prefer Kappa if your streaming engine can
  also do the reprocessing.
- **Kappa specifically** when reprocessing the full history is
  prohibitively slow or the log can't be retained long enough to replay
  the range you'd need to correct.

## Use-case scenarios

**Real-time analytics dashboard with nightly correction (Lambda).** A
product-analytics platform shows live counts (sessions, events per
minute) that must update within seconds, but also publishes daily
reports that must be exact — deduplicated, late-events included,
sessionization done properly. The speed layer drives the live tiles
approximately; a nightly batch job recomputes the authoritative daily
numbers from immutable raw events, and the serving layer prefers the
batch result for any day already processed.

**Fraud scoring pipeline reprocessed on model change (Kappa).** A
payments system scores transactions against a rules-and-model pipeline
reading from a Kafka log of transaction events. When the fraud team
ships a new model version, they don't run a batch backfill in a
different framework — they start a second instance of the same streaming
job replaying the log from a chosen offset, materialize re-scored
results in parallel, and cut traffic over once it reaches the live tip.

**Metrics rebuilt from a CDC-fed log (Kappa + CDC).** An operational
database's changes are captured via
[change data capture](/docs/patterns/batch-streaming/change-data-capture)
into a durable log, and a streaming job folds that log into derived
aggregates (revenue per region, inventory rollups). A logic error in an
aggregate is fixed by replaying the retained log through the corrected
job, rebuilding the aggregate exactly — no separate batch reconciliation
system to maintain.

## Production libraries & getting started

Both architectures are assembled from the same building blocks — a durable log, a compute engine, and a serving store — rather than shipped as one product.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Apache Kafka | JVM | The immutable, replayable log at the heart of Kappa (and the ingest for both) | [Kafka quickstart](https://kafka.apache.org/quickstart) |
| Apache Flink | JVM | Stream compute for the speed layer / the single Kappa processor with log replay | [Stateful stream processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/stateful-stream-processing/) |
| Apache Spark | JVM | Batch layer (RDD/DataFrame) plus Structured Streaming speed layer | [Structured Streaming guide](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html) |
| Apache Druid | JVM | Real-time analytics serving store for low-latency query views | [Druid tutorials](https://druid.apache.org/docs/latest/tutorials/) |
| Apache Pinot | JVM | Real-time OLAP serving store for user-facing analytics | [Pinot getting started](https://docs.pinot.apache.org/basics/getting-started) |
| ClickHouse | C++ | Columnar store that serves both batch and streaming-derived views fast | [ClickHouse quick start](https://clickhouse.com/docs/getting-started/quick-start) |

**Example / reference:** [Questioning the Lambda Architecture — Jay Kreps (O'Reilly Radar)](https://www.oreilly.com/radar/questioning-the-lambda-architecture/)

## Related patterns

- [MapReduce](/docs/patterns/batch-streaming/mapreduce) — the classic
  batch-layer processing model in a Lambda architecture.
- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) —
  the speed layer in Lambda and the sole processing model in Kappa.
- [Change Data Capture](/docs/patterns/batch-streaming/change-data-capture) —
  a common way to feed the replayable log both architectures build on.
- [Event Sourcing](/docs/patterns/storage/event-sourcing) — the
  "immutable event log is the source of truth, state is a fold over it"
  premise Kappa shares.
- [CQRS](/docs/patterns/storage/cqrs) — the read/write split that a
  serving layer of precomputed views is a natural fit for.

## Further reading

- [Lambda architecture — Wikipedia](https://en.wikipedia.org/wiki/Lambda_architecture)
- [Questioning the Lambda Architecture — Jay Kreps (O'Reilly Radar)](https://www.oreilly.com/radar/questioning-the-lambda-architecture/)
- [The Log: What every software engineer should know about real-time data's unifying abstraction — Jay Kreps](https://www.linkedin.com/blog/engineering/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying)
- [Kappa Architecture — kappa-architecture.com](https://milinda.pathirage.org/kappa-architecture.com/)
