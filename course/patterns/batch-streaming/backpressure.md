---
title: "Backpressure"
sidebar_position: 6
supplementary: true
---

Backpressure is a mechanism for a slow consumer to signal a fast
producer to slow down, so that the gap between production and
consumption rates never turns into unbounded, uncontrolled queue growth.

This page expands on the primer's brief mention in [Asynchronism](/docs/concepts/asynchronism), which introduces
backpressure as one line about capping queue size. Here we go deeper
into the concrete strategies for actually implementing it.

## Problem it solves

Whenever a producer can generate work faster than a consumer can
process it — a fast API accepting writes faster than a downstream
database can absorb them, a sensor emitting readings faster than an
analytics job can crunch them — something has to give. Without any
mechanism to communicate that mismatch back to the producer, the only
place for the surplus to go is an ever-growing queue between them. An
unbounded queue doesn't just get slow; eventually it exhausts memory
and crashes the process holding it, taking down work that was already
successfully queued along with it. Backpressure closes this gap by
making the rate mismatch visible to the producer, rather than letting a
queue silently absorb an unsustainable difference until it fails.

## How it works

There are three common strategies once a consumer is falling behind,
and the difference between them is what happens to the surplus work.

**Bounded buffering** caps the queue at a fixed size and, once full,
refuses new work with an explicit signal — an error, an HTTP 503, or a
rejected function call — that the producer must react to, typically by
retrying later. This preserves all previously-queued work and gives the
producer a clear, immediate signal, at the cost of the producer needing
retry logic (commonly paired with [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff)) to avoid
just hammering the same full queue again immediately.

**Dropping** discards excess items once a threshold is hit — either the
newest arrivals (so already-queued work is preserved) or the oldest
ones (so the queue always reflects the most recent state). This trades
data completeness for keeping the system responsive and memory-bounded,
and only makes sense when losing some items is tolerable, such as
metrics samples or a live "latest price" feed where an old, stale value
is worse than a missing one.

**Blocking the producer** makes the producer's write call itself pause
— rather than erroring or dropping data — until the consumer has drained
enough of the queue to make room. This preserves every item with no
explicit retry logic needed on the producer's side, but it couples the
producer's throughput directly to the consumer's, and if the producer
is something latency-sensitive (a request-handling thread), blocking it
can cascade the slowdown upstream to whatever's calling it.

## When to use it

- Any producer-consumer pipeline where production can outpace
  consumption, which is essentially any queue, stream, or reactive
  pipeline connecting components with different throughput
  characteristics.
- Systems where an unbounded queue would eventually risk out-of-memory
  failure, and a controlled, explicit response (reject, drop, or block)
  is preferable to an uncontrolled crash.
- Streaming and reactive pipelines specifically, where backpressure is
  often a first-class part of the API rather than something bolted on
  afterward.

## When not to use it

- Producer and consumer rates that are already well-matched or where
  the consumer is provisioned with enough headroom that queue growth is
  never realistically unbounded — added backpressure machinery is pure
  overhead there.
- Cases where losing the producer's request outright (fail fast, no
  queue at all) is simpler and acceptable, and no queue-based mechanism
  is needed in the first place.

## Real-world example

TCP implements backpressure at the transport layer through its flow
control window: a receiver advertises how much buffer space it has
available, and a sender is required to stop sending once that window is
exhausted, until the receiver acknowledges data and reopens room.
Reactive Streams-based libraries such as Project Reactor and RxJava
implement backpressure explicitly at the application level, letting a
slow subscriber request only as many items as it's currently ready to
handle rather than being pushed an unbounded stream.

## Related patterns

- [Asynchronism](/docs/concepts/asynchronism) — the primer's introduction to message queues and back pressure, which this page expands on.
- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — a common place backpressure needs to be applied, when a broker's subscribers consume slower than publishers produce.

## Further reading

- [Reactive Streams — Wikipedia](https://en.wikipedia.org/wiki/Reactive_Streams)
- [Transmission Control Protocol — Wikipedia](https://en.wikipedia.org/wiki/Transmission_Control_Protocol)
