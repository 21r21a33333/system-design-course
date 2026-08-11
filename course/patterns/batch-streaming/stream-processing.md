---
title: "Stream Processing"
sidebar_position: 2
supplementary: true
---

Stream processing handles records continuously as they arrive, one at a
time or in small micro-batches, instead of waiting to accumulate a full
batch and processing it on a schedule. The input is treated as an
unbounded, never-ending sequence, and results are produced incrementally
as data flows through rather than once at the end of a job.

![Stream Processing diagram](/img/patterns/stream-processing.svg)

## Problem it solves

A batch job like [MapReduce](/docs/patterns/batch-streaming/mapreduce)
only produces a result once the whole job finishes running over a
complete dataset — fine for a nightly report, useless for a
fraud-detection system that needs to flag a suspicious transaction
within seconds of it happening. Many workloads are naturally unbounded:
clickstreams, sensor readings, financial ticks, and application logs
never really "finish." Forcing them into batches means choosing a batch
boundary, waiting for it to fill, and accepting latency equal to at
least the batch interval before any result appears. Stream processing
addresses both problems at once — it emits incremental results as data
arrives, and it treats the unbounded nature of the input as the normal
case rather than something to chop into artificial batches first. The
central difficulty it takes on is that you can never see "all the data,"
so every aggregation has to be defined over a bounded slice of an
infinite stream, and the system has to decide when that slice is
complete enough to act on.

## Technical architecture & implementation

**Unbounded streams vs. bounded batch.** A batch processor is handed a
finite, complete dataset and runs to completion; a stream processor is a
long-lived program that consumes an endless sequence of events from a
source — typically a partitioned log or broker such as one following the
[Publish-Subscribe](/docs/patterns/communication/pub-sub) pattern,
consumed via [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption)
— applies transformations, and emits results continuously. Because the
input never ends, the job's correctness and its recovery story both have
to be designed for a process that runs indefinitely, not one that starts
and stops.

**Event time vs. processing time.** Two clocks matter. *Event time* is
when the event actually happened (stamped at the source); *processing
time* is when the processor got around to handling it. In a distributed
system with variable network delay, buffering, and retries, events
routinely arrive out of order and late relative to their event time.
Aggregating by processing time is trivial but wrong for anything
time-sensitive — a "count per minute" bucketed by arrival would smear
across minutes whenever the pipeline hiccups. Correct results are
defined in event time, which forces the system to reason about
completeness.

**Watermarks and late data.** A **watermark** is the processor's
assertion that "I believe I have now seen all events with event time
&le; T." It is a moving lower bound on event time that lets the system
decide a window is complete and safe to emit. Because a watermark is a
heuristic (you can't truly know no straggler will arrive), events that
turn up *behind* the watermark are **late data**, handled by one of
three policies: drop them, route them to a side output for separate
handling, or allow a bounded lateness grace period that keeps a window's
state alive a while longer before finalizing.

**Windowing.** Aggregations run over windows. A **tumbling window**
divides the stream into fixed-size, non-overlapping intervals (every
1-minute period), so each event belongs to exactly one window. A
**sliding window** overlaps (the last 5 minutes, recomputed every 30
seconds), so one event contributes to several results. A **session
window** is defined by activity gaps — it groups events until a period
of inactivity closes the session, sizing itself to the data rather than
a fixed clock. The [next section](#time-windows-and-watermarks) works
through how these interact with watermarks.

**Stateful operators and state stores.** Counts, averages, joins, and
deduplication all require the operator to *remember* something between
events — the running aggregate per (key, window). That state can far
exceed memory, so production engines back it with an embedded key-value
**state store** (Flink and Kafka Streams both use RocksDB) keyed by the
grouping key and window. State is the hard part of streaming: it is what
must survive a crash.

**Checkpointing and fault tolerance.** A long-running job *will* be
interrupted. Fault tolerance comes from periodic **checkpoints** —
consistent snapshots of all operator state plus the source offsets that
state corresponds to — persisted to durable storage. On restart, the
job restores the latest checkpoint and rewinds the source to the
matching offsets, so no acknowledged input is lost or double-counted.
Flink coordinates this with a distributed snapshot algorithm (barriers
flow through the dataflow); Spark Structured Streaming records offsets
and state to a write-ahead log, conceptually the same durability trick
as [Write-Ahead Log](/docs/patterns/storage/write-ahead-log).

**Exactly-once via checkpoints.** Aligning state snapshots with source
offsets and committing sink output atomically is exactly how streaming
engines deliver end-to-end
[exactly-once semantics](/docs/patterns/batch-streaming/exactly-once-semantics)
— the checkpoint *is* the atomic offset-plus-output commit. Without
that alignment you get at-least-once (safe replay, possible duplicates).

**Throughput vs. latency.** Pure record-at-a-time processing (Flink,
Storm) minimizes per-event latency; **micro-batching** (Spark Structured
Streaming) groups events into tiny batches for higher throughput and
simpler recovery at the cost of latency floored by the batch interval.
Naming the engine matters: Flink and Storm favor latency, Spark favors
throughput, and Kafka Streams is a *library* embedded in your app rather
than a separate cluster — no processing tier to operate, at the cost of
scaling with your application processes.

## Time, windows, and watermarks

The interplay is where streaming correctness lives. Each event is
assigned to a window by its **event time** — a tumbling window floors
the timestamp to its interval boundary. The window's aggregate
accumulates in the state store. When the **watermark** advances past a
window's end, the engine declares that window complete, **emits** its
result, and frees its state. An event arriving *after* its window has
been emitted is **late**: it missed the watermark and is dropped or
side-outputted rather than silently corrupting an already-published
number.

| Window type | Shape | An event belongs to | Typical use |
| --- | --- | --- | --- |
| Tumbling | Fixed, non-overlapping | Exactly one window | Per-minute counts, billing periods |
| Sliding | Fixed size, overlapping step | Several windows | Rolling averages, moving alerts |
| Session | Gap-defined, variable length | One session per activity burst | User sessions, per-visit analytics |

## Code example

A tumbling-window aggregator keyed by `(key, window_start)`. Events carry
an event-time; advancing the watermark past a window's end emits that
window's `(count, sum)` and drops its state. An event whose window has
already closed is counted as late and dropped.

```rust
use std::collections::HashMap;

#[derive(Debug, PartialEq)]
pub struct WindowResult {
    pub key: String,
    pub window_start: u64,
    pub count: u64,
    pub sum: u64,
}

pub struct TumblingAggregator {
    window_size: u64,
    // (key, window_start) -> (count, sum)
    state: HashMap<(String, u64), (u64, u64)>,
    watermark: u64,
    late_dropped: u64,
}

impl TumblingAggregator {
    pub fn new(window_size: u64) -> Self {
        TumblingAggregator {
            window_size,
            state: HashMap::new(),
            watermark: 0,
            late_dropped: 0,
        }
    }

    fn window_start(&self, event_time: u64) -> u64 {
        // Floor the timestamp to its window boundary.
        (event_time / self.window_size) * self.window_size
    }

    // Ingest one event. If its window has already closed (its end is at or
    // below the watermark), the event is late and dropped.
    pub fn ingest(&mut self, key: &str, event_time: u64, value: u64) {
        let start = self.window_start(event_time);
        if start + self.window_size <= self.watermark {
            self.late_dropped += 1;
            return;
        }
        let entry = self.state.entry((key.to_string(), start)).or_insert((0, 0));
        entry.0 += 1;
        entry.1 += value;
    }

    // Advance the watermark and emit every window whose end is at or below
    // it. Emitted windows are removed from state.
    pub fn advance_watermark(&mut self, new_watermark: u64) -> Vec<WindowResult> {
        if new_watermark > self.watermark {
            self.watermark = new_watermark;
        }
        let due: Vec<(String, u64)> = self
            .state
            .keys()
            .filter(|(_, start)| start + self.window_size <= self.watermark)
            .cloned()
            .collect();
        let mut out = Vec::new();
        for k in due {
            let (count, sum) = self.state.remove(&k).unwrap();
            out.push(WindowResult { key: k.0, window_start: k.1, count, sum });
        }
        out.sort_by(|a, b| (a.window_start, &a.key).cmp(&(b.window_start, &b.key)));
        out
    }

    pub fn late_dropped(&self) -> u64 {
        self.late_dropped
    }
}
```

Verified behavior: with a window size of 10, three events in `[0,10)`
and one in `[10,20)`, advancing the watermark to 10 emits exactly the
two `[0,10)` window results and frees their state; a straggler whose
event-time falls in the now-closed `[0,10)` window is counted as one
`late_dropped` rather than mutating a published result.

## When to use it

- Latency-sensitive use cases — alerting, fraud detection, live
  dashboards, real-time recommendations — where results are only useful
  within seconds of the triggering event.
- Genuinely unbounded data sources where there is no natural batch
  boundary to wait for.
- Incremental aggregation where recomputing from scratch over the full
  history on every update would be wasteful.

## When not to use it

- Workloads that only need periodic, not continuous, results — an hourly
  batch job is simpler to write, test, and reason about than a
  long-running streaming pipeline, with far less operational overhead.
- Computations that require a full, stable view of the entire dataset
  (a complex multi-way join across historical tables), which are usually
  more straightforward as a batch job.
- Teams without the operational maturity to run always-on infrastructure
  — a streaming job that crashes must resume correctly from a checkpoint,
  a harder problem than simply restarting a batch job.

## Use-case scenarios

**Real-time fraud scoring.** A payments platform streams every
authorization event through a stateful operator keyed by card. A sliding
window over the last few minutes maintains per-card velocity features
(count and amount), and the operator flags a transaction the instant its
window crosses a risk threshold — well before any nightly batch would
have noticed. Checkpointing lets the scorer restart after a deploy
without losing the in-flight velocity state.

**Live operational dashboards.** An infrastructure team ingests
application logs and metrics as a stream, tumbling-windowed into
one-minute error-rate and latency buckets per service. Because
aggregation is in event time with a watermark, a burst of delayed log
shipments doesn't smear counts across the wrong minute; late arrivals
past the grace period are side-outputted for a separate reconciliation
job rather than corrupting the live view.

**Clickstream sessionization.** An e-commerce analytics pipeline groups a
visitor's events into session windows closed by 30 minutes of
inactivity. Each closed session emits a per-visit summary (pages viewed,
funnel stage reached) used for real-time personalization, with session
state kept in an embedded key-value store so millions of concurrent
sessions exceed memory safely.

## Related patterns

- [MapReduce](/docs/patterns/batch-streaming/mapreduce) — the
  scheduled-batch counterpart stream processing trades throughput and
  simplicity against for lower latency.
- [Lambda / Kappa Architecture](/docs/patterns/batch-streaming/lambda-kappa-architecture)
  — architectural patterns for combining (Lambda) or unifying (Kappa)
  streaming with batch processing.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption)
  — the parallel, ordered source most stream processors read from.
- [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics)
  — delivered in streaming engines by aligning state checkpoints with
  source offsets and sink commits.
- [Backpressure](/docs/patterns/batch-streaming/backpressure) — how a
  streaming operator whose downstream is slow signals upstream to avoid
  unbounded buffering.
- [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) — the
  durability mechanism underlying checkpoint and offset recovery.

## Further reading

- [Stream processing — Wikipedia](https://en.wikipedia.org/wiki/Stream_processing)
- [Timely Stream Processing — Apache Flink documentation](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/time/)
- [Windowing — Apache Flink documentation](https://nightlies.apache.org/flink/flink-docs-stable/docs/dev/datastream/operators/windows/)
- [Structured Streaming Programming Guide — Apache Spark](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html)
- [Kafka Streams core concepts — Apache Kafka documentation](https://kafka.apache.org/documentation/streams/core-concepts)
- [The Dataflow Model — Google Research paper (VLDB 2015)](https://research.google/pubs/the-dataflow-model-a-practical-approach-to-balancing-correctness-latency-and-cost-in-massive-scale-unbounded-out-of-order-data-processing/)
