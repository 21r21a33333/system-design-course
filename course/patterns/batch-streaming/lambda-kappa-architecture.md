---
title: "Lambda & Kappa Architecture"
sidebar_position: 3
supplementary: true
---

Lambda and Kappa architecture are two approaches to combining batch and
real-time processing over the same data: Lambda runs both a batch layer
and a speed layer side by side, while Kappa treats stream processing as
the only processing model and re-derives batch-style results by
replaying the stream.

## Problem it solves

Real-time processing alone often can't be fully trusted: a streaming
job might use approximate algorithms for speed, might drop late-arriving
data past some cutoff, or might simply have a bug that a batch
recomputation from raw history would catch and correct. But batch
processing alone is too slow for anything latency-sensitive. Systems
that need both an accurate, complete view of history and a fast,
"good enough" up-to-the-second view need an architecture that reconciles
the two instead of picking one.

## How it works

**Lambda architecture** runs two parallel processing paths over the
same incoming data. The **batch layer** stores all incoming data
immutably and periodically recomputes results from scratch (or from a
large window) using something like [MapReduce](/docs/patterns/batch-streaming/mapreduce), producing complete
and accurate — but delayed — views. The **speed layer** processes the
same data as it arrives using [stream processing](/docs/patterns/batch-streaming/stream-processing), producing
low-latency but approximate or incremental views that cover the gap
until the batch layer catches up. A serving layer merges results from
both at query time, typically preferring the batch result once it's
available and falling back to the speed-layer result for the most
recent, not-yet-batched window.

**Kappa architecture** simplifies this by dropping the batch layer
entirely: all data — historical and new — is treated as a single
stream, usually backed by a durable, replayable log. Normal processing
runs continuously over the live stream; if logic needs to be
reprocessed (a bug fix, a schema change), the fix is to replay the
stream from an earlier offset through the same streaming job, rather
than maintaining a separate batch codebase that does conceptually the
same transformation a different way.

## When to use it

- **Lambda** fits when a genuinely different, more thorough algorithm is
  worth running in batch than can run in real time (e.g. a batch job can
  afford multiple passes or exact computations that a streaming job
  approximates), and the team accepts running two systems.
- **Kappa** fits when the same processing logic really can serve both
  needs, and avoiding two divergent codebases for the same business
  logic is the priority.
- Both apply where a single point-in-time streaming result is not
  trusted enough to stand alone.

## When not to use it

- Purely batch workloads with no latency requirement — plain
  [MapReduce](/docs/patterns/batch-streaming/mapreduce) is simpler.
- Purely real-time workloads with no need for a reconciled, accurate
  historical view — plain [stream processing](/docs/patterns/batch-streaming/stream-processing) is simpler.
- Lambda specifically should be avoided when a team can't sustain the
  ongoing cost of keeping two independent implementations of the same
  logic (one batch, one streaming) consistent with each other — this
  duplicated-logic burden is exactly what motivated Kappa's emergence.

## Real-world example

Lambda architecture was popularized by Nathan Marz (creator of Apache
Storm) as a general pattern for big-data systems needing both batch
accuracy and real-time responsiveness. Kappa architecture was proposed
afterward, by engineers at LinkedIn and elsewhere, specifically as a
reaction to the operational cost of maintaining Lambda's dual
codebases, arguing that a replayable stream makes the batch layer
redundant.

## Related patterns

- [MapReduce](/docs/patterns/batch-streaming/mapreduce) — the batch-layer processing model in a Lambda architecture.
- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) — the speed-layer (Lambda) or sole (Kappa) processing model.

## Further reading

- [Lambda architecture — Wikipedia](https://en.wikipedia.org/wiki/Lambda_architecture)
- [Stream processing — Wikipedia](https://en.wikipedia.org/wiki/Stream_processing)
