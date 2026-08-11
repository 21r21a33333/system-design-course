---
title: "Backpressure"
sidebar_position: 6
supplementary: true
---

Backpressure is a flow-control mechanism that lets a slow consumer signal
a fast producer to slow down, so the gap between production and
consumption rates never turns into unbounded, uncontrolled queue growth.
Instead of a buffer silently absorbing an unsustainable rate mismatch
until it exhausts memory, the mismatch is made visible to the producer,
which adapts its own rate in response.

![Backpressure diagram](/img/patterns/backpressure.svg)

## Problem it solves

Whenever a producer can generate work faster than a consumer can process
it — a fast API accepting writes faster than a downstream database can
absorb them, a sensor emitting readings faster than an analytics job can
crunch them — something has to give. Without any mechanism to communicate
that mismatch back to the producer, the only place for the surplus to go
is an ever-growing queue between them. An unbounded queue doesn't just
get slow: latency climbs as the buffer fills (more items sit ahead of
each new one), and eventually it exhausts memory and crashes the process
holding it, taking down the work that was already successfully queued
along with it. Backpressure closes this gap by turning the rate mismatch
into an explicit signal the producer must obey, converting a silent,
delayed catastrophic failure into an immediate, controlled one.

## Technical architecture & implementation

**Bounded buffers as the foundation.** Every backpressure scheme starts
by *refusing to let the buffer grow without limit*. A bounded buffer has
a fixed capacity; the interesting design question is what happens at the
moment it is full. The three answers below — block, drop, shed — are the
strategies, and the buffer bound is what forces the choice instead of
deferring it to an out-of-memory crash.

**Block the producer.** The producer's write call itself pauses — rather
than erroring or discarding data — until the consumer drains a slot. This
preserves every item with no explicit retry logic on the producer, and
it is how bounded in-process channels behave (a full `sync_channel` in
Rust, a bounded `BlockingQueue` in Java). Its defining property is that
the producer's *effective throughput is pinned to the consumer's* — the
slow stage sets the pace for the whole pipeline. The risk: if the
producer is latency-sensitive (a request-handling thread), blocking it
propagates the stall upstream to whatever is calling it.

**Drop or sample.** When full, discard excess — either the newest
arrivals (preserving already-queued order) or the oldest (keeping the
buffer reflecting the most recent state), or sample down to keep a
representative fraction. This trades completeness for staying responsive
and memory-bounded, and only makes sense when loss is tolerable:
telemetry samples, or a "latest price" feed where a stale value is worse
than a missing one. Dropped work should be *counted* so the loss is
observable, not silent.

**Credit-based flow control.** Rather than react at the moment of
fullness, the consumer proactively advertises how much it can accept —
its **credit** or **demand** — and the producer sends only up to that
amount. TCP's receive window is the canonical example: the receiver
advertises free buffer space, and the sender must stop once the window is
exhausted, resuming only when acknowledgements reopen it. This is
pull-shaped even over a push transport: nothing is sent that the receiver
hasn't already declared room for, so a buffer overflow is prevented
rather than handled after the fact.

**Reactive-streams demand signaling.** Application-level reactive
libraries (Project Reactor, RxJava, Akka Streams) make this explicit and
inescapable: a subscriber calls `request(n)` to signal it is ready for
`n` more items, and the publisher is contractually forbidden from
emitting more than the outstanding demand. The pipeline is effectively
**pull-based** end to end even though data flows downstream — a fast
publisher simply never gets permission to overwhelm a slow subscriber.

**Propagation up the pipeline.** In a multi-stage pipeline (see
[Pipes and Filters](/docs/patterns/building-blocks/pipes-and-filters)),
backpressure has to *propagate*. When the final sink slows, its bounded
input fills, which blocks or throttles the stage feeding it, whose input
then fills, and so on back to the origin. Each stage exerting local
backpressure on its predecessor composes into end-to-end flow control
without any stage needing a global view — the slowdown ripples upstream
one bounded buffer at a time.

**Load shedding as last resort.** Sometimes the producer *cannot* be
slowed — it is external traffic that will keep arriving regardless (see
[Throttling](/docs/patterns/building-blocks/throttling) and the
[Rate Limiter](/docs/patterns/building-blocks/rate-limiter)). When
propagated backpressure has nowhere left to push, the terminal option is
**load shedding**: deliberately reject or drop a fraction of work to
protect the system's core function, ideally shedding the least important
traffic first. This is the same fail-fast reasoning as returning a 503
from a full bounded queue, applied at the system's edge.

**Backpressure vs. rate-limiting vs. queue-based load leveling.** These
are frequently conflated. **Rate limiting / throttling** caps the
producer at a *fixed, predefined rate* the consumer is assumed to
tolerate — a static ceiling that doesn't react to the consumer's actual
live capacity. **Backpressure** is *dynamic and reactive*: the limit is
whatever the consumer can handle right now, communicated live, so it
adapts as consumer speed varies. **[Queue-based load
leveling](/docs/patterns/batch-streaming/queue-based-load-leveling)**
takes the opposite tack — it *absorbs* bursts in a durable buffer so the
consumer processes at a steady rate, decoupling the two rather than
coupling them. Backpressure and load leveling are complementary: a
bounded, durable queue smooths bursts, and backpressure engages when the
smoothing capacity itself is exhausted.

## Comparison of surplus-handling strategies

| Strategy | Data completeness | Producer impact | Best when |
| --- | --- | --- | --- |
| Block producer | Lossless | Throughput pinned to consumer; can stall upstream | In-process pipelines, lossless requirement |
| Drop / sample | Lossy | None (producer unaffected) | Telemetry, "latest value" feeds |
| Reject (503 + retry) | Lossless via retry | Producer must implement backoff | Service boundaries, external callers |
| Credit / demand | Lossless | Producer capped at advertised demand | Network transports, reactive streams |

## Code example

A bounded channel demonstrating **block-on-full** backpressure with real
threads. The consumer sleeps 50 ms per item; the producer can push
instantly but is forced to wait once the two-slot buffer fills. A timing
harness measures both the total runtime and how many `send` calls
actually blocked.

```rust
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::{Duration, Instant};

fn main() {
    let capacity = 2;
    let (tx, rx) = sync_channel::<u64>(capacity);
    let items = 6u64;
    let consume_time = Duration::from_millis(50);

    let start = Instant::now();

    let producer = thread::spawn(move || {
        let mut send_delays = Vec::new();
        for i in 0..items {
            let before = Instant::now();
            // Blocks here once `capacity` items are buffered and unconsumed.
            tx.send(i).unwrap();
            send_delays.push(before.elapsed());
        }
        send_delays
    });

    let consumer = thread::spawn(move || {
        let mut received = 0u64;
        while let Ok(_item) = rx.recv() {
            thread::sleep(consume_time); // simulate slow per-item work
            received += 1;
        }
        received
    });

    let send_delays = producer.join().unwrap();
    let received = consumer.join().unwrap();
    let elapsed = start.elapsed();

    let blocked = send_delays
        .iter()
        .filter(|d| **d > Duration::from_millis(20))
        .count();

    println!("received = {}", received);
    println!("total elapsed = {} ms", elapsed.as_millis());
    println!("sends that blocked (>20ms) = {}", blocked);
}
```

Run with real OS threads, this prints `received = 6`, a total elapsed of
roughly 320 ms, and `sends that blocked = 3`. The measurement is the
lesson: total runtime is governed by the slow consumer
(≈ `items × 50 ms`), not the fast producer, and the later `send` calls
each measurably parked until the consumer freed a buffer slot — that
parking *is* backpressure holding the producer to the consumer's rate.

## When to use it

- Any producer-consumer pipeline where production can outpace
  consumption — essentially any queue, stream, or reactive pipeline
  connecting components with different throughput characteristics.
- Systems where an unbounded queue would eventually risk out-of-memory
  failure, and a controlled response (block, reject, or drop) is
  preferable to an uncontrolled crash.
- Streaming and reactive pipelines specifically, where backpressure is
  often a first-class part of the API rather than something bolted on.

## When not to use it

- Producer and consumer rates already well-matched, or the consumer has
  enough headroom that queue growth is never realistically unbounded —
  added backpressure machinery is pure overhead there.
- Cases where failing fast with no queue at all (reject the producer's
  request outright) is simpler and acceptable, so no flow-control
  mechanism is needed in the first place.
- Where the producer is uncontrollable external traffic and the real
  answer is admission control at the edge — [rate
  limiting](/docs/patterns/building-blocks/rate-limiter) or load
  shedding — rather than a signal the producer would ignore anyway.

## Use-case scenarios

**Reactive HTTP-to-database ingestion.** A service accepts a firehose of
event writes over HTTP and persists them to a database that can absorb
far fewer writes per second than requests arrive. A reactive pipeline
propagates the database's demand upstream: the HTTP layer only pulls the
next request body once the database stage signals capacity, and when
demand hits zero the service returns 503 with a `Retry-After` so clients
back off rather than piling on an unbounded in-memory queue.

**Kafka-consumer stream job with a slow sink.** A stream processor reads
from a partitioned log and writes enriched records to a downstream API
with strict rate limits. When the sink slows, the processor stops polling
new records — its consumer simply fetches less — which naturally halts
progress without dropping data, because the durable log retains unread
offsets. Backpressure here is "read slower," and the log is the buffer
that makes it lossless.

**Telemetry agent under load.** A metrics agent samples system counters
far faster than it can ship them to a remote collector. Its bounded
in-memory buffer drops the *oldest* samples on overflow and increments a
`dropped_samples` counter, deliberately choosing lossy backpressure: a
slightly gappy metrics timeline is acceptable, but an agent that OOM-kills
the host it is monitoring is not.

## Related patterns

- [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling)
  — absorbs bursts in a durable buffer so the consumer runs steady;
  complementary to backpressure, which engages when that buffer fills.
- [Throttling](/docs/patterns/building-blocks/throttling) and
  [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) — impose a
  *static* rate ceiling, whereas backpressure adapts to live consumer
  capacity; used at the edge when the producer can't be signaled.
- [Retry with Backoff](/docs/patterns/reliability/retry-with-backoff) —
  what a producer does after a bounded queue rejects its write, so it
  doesn't immediately hammer the same full queue.
- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) —
  streaming operators use backpressure to keep a fast source from
  overwhelming a slow downstream stage.
- [Pipes and Filters](/docs/patterns/building-blocks/pipes-and-filters) —
  the multi-stage topology through which backpressure propagates,
  stage by stage, back to the source.

## Further reading

- [Reactive Streams — Wikipedia](https://en.wikipedia.org/wiki/Reactive_Streams)
- [Reactive Streams specification — reactive-streams.org](https://www.reactive-streams.org/)
- [Handling Backpressure — Project Reactor reference guide](https://projectreactor.io/docs/core/release/reference/#reactive.backpressure)
- [Backpressure explained — Jay Phelps](https://medium.com/@jayphelps/backpressure-explained-the-flow-of-data-through-software-2350b3e77ce7)
- [TCP flow control (sliding window) — Wikipedia](https://en.wikipedia.org/wiki/Transmission_Control_Protocol#Flow_control)
