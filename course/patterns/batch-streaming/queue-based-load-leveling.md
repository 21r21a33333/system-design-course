---
title: "Queue-Based Load Leveling"
sidebar_position: 9
supplementary: true
---

Queue-Based Load Leveling places a queue between a task producer and
the service that processes those tasks, so the service pulls work from
the queue at its own sustainable pace instead of being hit directly by
however bursty the producer's demand happens to be.

![Queue-Based Load Leveling diagram](/img/patterns/queue-based-load-leveling.svg)

## Problem it solves

A service that's called directly is exposed to whatever traffic
pattern its callers produce — including sharp bursts, like a flash sale,
a batch job kicking off, or a retry storm after an upstream outage. If
the service is sized for average load, a burst can overwhelm it:
requests pile up, latency spikes, and the service may fall over
entirely, taking down traffic that arrived just before and after the
burst along with it. Sizing the service for peak load instead avoids
the crash but wastes capacity (and money) the rest of the time, since
bursts are by definition not the common case. What's needed is a way
to absorb a burst without either overprovisioning for it permanently or
letting it take the service down.

## Technical architecture & implementation

**Decoupling arrival rate from processing rate.** Instead of a producer
calling the service directly, it writes each unit of work onto a queue
and returns immediately — accepting the work is now decoupled from the
cost of doing it. The service, running as one or more workers, pulls
items off the queue at whatever rate it can sustainably handle,
regardless of how fast items are currently arriving. A traffic burst
just makes the queue temporarily deeper; the service keeps processing
at its own steady pace and works through the backlog once the burst
subsides. The consequence is the whole point: the service can be sized
for **sustainable** throughput rather than **peak** throughput, and the
queue absorbs the difference.

**Peak-shaving, quantified.** The queue acts as a shock absorber. If
arrivals spike to 80/tick while the service sustainably drains 10/tick,
the excess 70 don't hit the service — they accumulate as queue depth
and are worked off over the following ticks. The service never sees a
rate higher than it chose; the *latency* of any individual item, not
the *throughput* of the service, is what degrades during the spike.
This is the central trade: load leveling converts a throughput problem
(the service falling over) into a latency problem (items waiting longer
in the queue), which is almost always the better problem to have.

**Sizing the buffer.** The queue's depth and retention are a real
capacity decision, not "infinite by default." The buffer must be deep
enough to hold the largest realistic burst *minus* what the service
drains during it — size it too small and legitimate bursts overflow;
size it too large and you've merely deferred a collapse while letting
end-to-end latency balloon to minutes as items sit behind a huge
backlog. A useful mental model: `max_depth ≈ (peak_rate −
drain_rate) × burst_duration`. Depth should be **monitored and
alerted on** — a queue that's steadily growing rather than spiking-and-
draining means the producer's *average* rate now exceeds the service's
sustainable rate, which load leveling alone cannot fix (you need more
consumers or fewer producers).

**Latency under load.** The cost of the buffer is added latency. When
the queue is empty an item is picked up almost immediately; when it's
1,000 deep behind a 10/tick drain, that item waits ~100 ticks before
processing even starts. This is why load leveling suits work that
tolerates asynchronous, eventually-completed processing (receipts,
thumbnails, indexing) and is unsuitable for synchronous
request/response where the caller is blocked waiting.

**What happens at saturation — backpressure.** A queue is finite, so a
burst large enough (or sustained long enough) eventually fills it. At
that point the queue must do *something* with new arrivals: reject them,
block the producer, or drop older items. That decision is
**backpressure** — the queue signaling *back* to the producer that it
can't accept more — and it's covered in depth on the
[Backpressure](/docs/patterns/batch-streaming/backpressure) page. The
relationship is precise: load leveling is the benefit of *having* a
buffer so that spikes are smoothed; backpressure is what happens when
that buffer is *exhausted*. A well-sized queue makes exhaustion rare, so
backpressure is the exceptional path, not the normal one.

**Load leveling vs. throttling and rate limiting.** These are often
confused because all three sit between demand and a service.
[Rate limiting / throttling](/docs/patterns/building-blocks/throttling)
*rejects or delays* excess work at admission to protect the service — it
says "no" to some requests. Load leveling *accepts* the excess and
defers it, saying "later" rather than "no." Throttling caps the input;
load leveling reshapes it over time. They compose well: throttle to
bound the absolute worst case, and load-level within that bound to
smooth the ordinary bursts. Load leveling also differs from
[auto-scaling](/docs/patterns/scaling/auto-scaling), which changes the
service's capacity to meet demand rather than buffering ahead of a fixed
capacity; the two are commonly layered, scaling consumers on queue
depth.

## Code example

The runnable snippet below simulates a bursty arrival pattern against a
fixed-rate consumer with a *bounded* buffer. It makes both properties
visible at once: the queue smooths a spike (the service never processes
more than its sustainable rate), and when the burst exceeds the buffer's
capacity, excess work is rejected — the backpressure signal.

```rust
use std::collections::VecDeque;

struct Task {
    id: u64,
}

// A bounded buffer between a bursty producer and a fixed-rate consumer.
// The capacity is what turns "smooth load" into "backpressure when full".
struct Queue {
    tasks: VecDeque<Task>,
    capacity: usize,
}

enum Admission {
    Accepted,
    Rejected(Task), // buffer saturated — this is the backpressure signal
}

impl Queue {
    // The producer never blocks on processing time; it appends and
    // returns — unless the buffer is full, in which case the task is
    // rejected rather than growing the queue without bound.
    fn enqueue(&mut self, task: Task) -> Admission {
        if self.tasks.len() >= self.capacity {
            return Admission::Rejected(task);
        }
        self.tasks.push_back(task);
        Admission::Accepted
    }

    fn dequeue(&mut self) -> Option<Task> {
        self.tasks.pop_front()
    }
}

// The service drains at its own sustainable rate, however deep the
// backlog is — a burst just makes the queue temporarily deeper.
fn worker_tick(queue: &mut Queue, max_per_tick: usize) -> usize {
    let mut done = 0;
    for _ in 0..max_per_tick {
        match queue.dequeue() {
            Some(_task) => done += 1,
            None => break,
        }
    }
    done
}

fn main() {
    let mut queue = Queue { tasks: VecDeque::new(), capacity: 100 };
    let mut next_id = 0u64;
    let mut rejected = 0u64;

    // A sharp spike at ticks 2-3, then quiet. The service sustainably
    // processes 10/tick regardless of how fast work arrives.
    let arrivals = [5u64, 5, 80, 60, 0, 0, 0, 0];
    let sustainable_rate = 10;

    for (tick, &arriving) in arrivals.iter().enumerate() {
        for _ in 0..arriving {
            if let Admission::Rejected(_) = queue.enqueue(Task { id: next_id }) {
                rejected += 1;
            }
            next_id += 1;
        }
        let processed = worker_tick(&mut queue, sustainable_rate);
        println!(
            "tick {tick}: +{arriving} arrived, {processed} processed, depth now {}",
            queue.tasks.len()
        );
    }
    println!("total rejected (backpressure): {rejected}");
}
```

Running this shows the shock-absorber behavior directly: arrivals spike
to 80 and 60 per tick, but the service processes a steady 10 per tick
throughout — the excess accumulates as queue depth (climbing to ~90)
and drains off over the quiet ticks that follow. Because the buffer is
capped at 100, the part of the burst that overflows is rejected (~30
tasks here), which is exactly the backpressure signal a real producer
would react to by retrying later or shedding load.

## When to use it

- Producer demand is bursty or unpredictable, but the downstream
  service's sustainable processing rate is roughly known and fixed.
- Producers and consumers can be decoupled in time — the producer
  doesn't need the result back synchronously, so it can hand off work
  and move on rather than waiting on the service directly.
- The service's capacity should be driven by average load rather than
  worst-case peak load, with the queue's depth absorbing the
  difference during a spike.

## When not to use it

- The producer needs an immediate, synchronous result — queuing adds
  latency between submission and processing that a request-response
  interaction can't tolerate.
- Traffic is already smooth and predictable, so there's no burst for a
  queue to absorb, and the added component (and its own latency and
  failure modes) is unjustified overhead.
- The workload benefits more from horizontally scaling the service
  itself in response to demand than from buffering ahead of it — see
  [Auto-Scaling](/docs/patterns/scaling/auto-scaling), which is often paired with this pattern by
  scaling the number of consumer workers based on queue depth rather
  than relying on the queue alone to absorb every burst.

## Use-case scenarios

**Ride-sharing receipt pipeline.** Ride completions spike sharply at
rush hour and when a big event lets out, but generating and emailing a
receipt doesn't need to happen instantly. Completed rides are pushed
onto a queue, and a fixed-size worker fleet processes receipts at a
steady rate — the queue grows briefly during a spike and drains after,
so the company sizes the fleet for average load instead of provisioning
enough receipt capacity to handle the single busiest minute of the year
year-round.

**Flash-sale order intake.** During a flash sale, order submissions
arrive far faster than the fulfillment, inventory, and payment systems
can synchronously handle. The storefront accepts each order onto a
durable queue and immediately returns "order received," decoupling the
customer-facing accept from the heavier downstream processing. The
back-end services drain the queue at their sustainable rate; the buffer
absorbs the spike so the checkout path stays fast and available even
while fulfillment runs for minutes afterward. When the buffer nears
capacity, backpressure kicks in and the storefront sheds or delays new
orders rather than letting the downstream collapse.

**IoT / telemetry ingestion.** A fleet of devices emits telemetry in
bursts (a firmware rollout, a scheduled sync window) that would swamp a
directly-called ingestion service. Readings land on a queue and a
capacity-limited processing tier consumes them steadily, writing to
storage and analytics at a rate the datastore can sustain. The queue
turns a spiky, unpredictable arrival pattern into a smooth, predictable
write load downstream, and monitoring queue depth gives an early signal
when the *average* ingestion rate starts to exceed processing capacity.

## Production libraries & getting started

The queue itself *is* the leveling buffer — any durable queue works. Put
one between a bursty producer and a fixed-rate consumer and size its depth
and retention for your largest realistic burst.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Amazon SQS | Any (AWS SDK) | Fully managed durable buffer; producers enqueue and return, workers drain steadily | [SQS getting started](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-getting-started.html) |
| RabbitMQ | JS / Python / Rust / Go clients | Durable queues with acks and bounded length (`x-max-length`) for the buffer | [Hello World tutorial](https://www.rabbitmq.com/tutorials/tutorial-one-python) |
| BullMQ (Redis) | JS / TS | Redis-backed queue that absorbs bursts; add workers to drain faster | [BullMQ docs](https://docs.bullmq.io/) |
| Azure Service Bus queues | Any (Azure SDK) | Managed durable queue with sessions, DLQ, and dead-letter-on-expiry | [Queues, topics & subscriptions](https://learn.microsoft.com/en-us/azure/service-bus-messaging/service-bus-queues-topics-subscriptions) |
| Apache Kafka | Any (many clients) | A durable log used as a deep buffer; consumers read at their own sustainable pace | [Kafka quickstart](https://kafka.apache.org/documentation/#gettingStarted) |

## Related patterns

- [Backpressure](/docs/patterns/batch-streaming/backpressure) — the
  complementary mechanism for when the queue itself fills: this pattern
  smooths load using the queue as a buffer; backpressure signals the
  producer to slow down or shed once that buffer is exhausted.
- [Throttling](/docs/patterns/building-blocks/throttling) and
  [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) — cap or
  reject excess work at admission ("no"), where load leveling instead
  accepts and defers it ("later"); the two compose to bound the worst
  case while smoothing ordinary bursts.
- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — often layered on
  top, scaling the number of consumer workers up or down based on queue
  depth so the sustainable rate itself adapts to sustained (not just
  bursty) demand.
- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) —
  the usual shape of the consumer side: a pool of interchangeable
  workers draining the leveling queue in parallel.

## Further reading

- [Queue-Based Load Leveling pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling)
- [Amazon SQS — AWS documentation](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html)
- [Little's Law — Wikipedia](https://en.wikipedia.org/wiki/Little%27s_law)
- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
