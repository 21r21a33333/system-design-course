---
title: "Stream Processing"
sidebar_position: 2
supplementary: true
---

Stream processing handles records continuously as they arrive, one at a
time or in small micro-batches, instead of waiting to accumulate a full
batch and processing it on a schedule.

## Problem it solves

A batch job like [MapReduce](/docs/patterns/batch-streaming/mapreduce) only produces a result once the whole job
finishes running over a complete dataset — fine for a nightly report,
useless for a fraud-detection system that needs to flag a suspicious
transaction within seconds of it happening. Many workloads are
naturally unbounded: clickstreams, sensor readings, financial ticks,
application logs never really "finish." Stream processing addresses
both problems at once — it produces incremental results as data
arrives, and it treats the unbounded nature of the input as the normal
case rather than something to chop into artificial batches first.

## How it works

A stream processor consumes an unbounded sequence of events from a
source (commonly a message broker or log such as one following the
[Publish-Subscribe](/docs/patterns/communication/pub-sub) pattern), applies transformations, and emits
results continuously. Because many useful aggregations — counts,
averages, joins — need a bounded slice of an otherwise infinite stream
to operate over, stream processors group events into **windows**. A
**tumbling window** divides the stream into fixed-size, non-overlapping
intervals (e.g. "every 1-minute period"), so each event belongs to
exactly one window. A **sliding window** moves continuously and
overlaps (e.g. "the last 5 minutes, recomputed every 30 seconds"), so a
single event can contribute to several window results. The processor
also has to define how it treats events that arrive late relative to
their timestamp, a common concern with distributed producers and
variable network delay.

## When to use it

- Latency-sensitive use cases — alerting, fraud detection, live
  dashboards, real-time recommendations — where results are only
  useful within seconds of the triggering event.
- Genuinely unbounded data sources where there's no natural "batch
  boundary" to wait for.
- Incremental aggregation where recomputing from scratch over the full
  history on every update would be wasteful.

## When not to use it

- Workloads that only need periodic, not continuous, results — a batch
  job scheduled hourly is simpler to write, test, and reason about than
  a long-running streaming pipeline, with less operational overhead.
- Computations that require a full, stable view of the entire dataset
  (e.g. a complex multi-way join across historical tables), which are
  usually more straightforward as a batch job.
- Teams without the operational maturity to run always-on streaming
  infrastructure — a streaming job that crashes needs to resume
  correctly from where it left off, which is a harder operational
  problem than restarting a batch job.

## Real-world example

Apache Flink and Kafka Streams are both widely used stream-processing
frameworks: Flink runs as a standalone cluster processing event streams
with exactly-once state guarantees and native windowing support, while
Kafka Streams is a client library that lets an application consume,
transform, and re-publish records from Kafka topics without a separate
processing cluster.

## Related patterns

- [MapReduce](/docs/patterns/batch-streaming/mapreduce) — the scheduled-batch counterpart that stream processing trades throughput and simplicity for lower latency against.
- [Lambda / Kappa Architecture](/docs/patterns/batch-streaming/lambda-kappa-architecture) — architectural patterns for combining streaming with batch processing.

## Further reading

- [Stream processing — Wikipedia](https://en.wikipedia.org/wiki/Stream_processing)
- [Sliding window protocol — Wikipedia](https://en.wikipedia.org/wiki/Sliding_window_protocol)
