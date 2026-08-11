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

## How it works

Instead of a producer calling the service directly, it writes each
unit of work onto a queue and returns immediately — accepting the work
is now decoupled from the cost of doing it. The service, running as one
or more workers, pulls items off the queue at whatever rate it can
sustainably handle, regardless of how fast items are currently arriving
on the producer side. A traffic burst just makes the queue temporarily
longer; the service keeps processing at its own steady pace instead of
being hit with the full burst rate, and works through the backlog once
the burst subsides. This means the service can be sized for sustainable
throughput rather than worst-case peak throughput, and the queue itself
absorbs the difference — up to whatever depth and retention the queue
is configured for.

This is a superset of what the primer's [Asynchronism](/docs/concepts/asynchronism) page briefly
touches on under "Back pressure": that section is about the queue
signaling *back* to the producer to slow down once it's full — a
producer-side rate-limiting mechanism, covered in more depth on this
site's own [Backpressure](/docs/patterns/batch-streaming/backpressure) page. Queue-Based Load Leveling is about a
different, complementary benefit that doesn't depend on backpressure
kicking in at all: even when the queue never gets close to full, simply
having *a* queue in between — with the service consuming from it at its
own pace — decouples the service's processing rate from the producer's
arrival rate and smooths out bursts before they ever reach the service.
Backpressure is what happens when the buffer is exhausted; load
leveling is the benefit of having the buffer in the first place, so
that exhaustion is rare.

## Code example

The snippet below models a producer enqueuing bursty work and a worker
draining it at a fixed, sustainable rate — the queue is what makes
those two rates independent of each other.

```rust
use std::collections::VecDeque;

struct Task {
    id: u64,
}

struct Queue {
    tasks: VecDeque<Task>,
}

impl Queue {
    fn enqueue(&mut self, task: Task) {
        // Producer never blocks on processing time; it just appends and returns.
        self.tasks.push_back(task);
    }

    fn dequeue(&mut self) -> Option<Task> {
        self.tasks.pop_front()
    }
}

// A burst of 500 tasks arriving at once just makes the queue longer;
// it doesn't change how fast process_task can run.
fn produce_burst(queue: &mut Queue, count: u64) {
    for id in 0..count {
        queue.enqueue(Task { id });
    }
}

// The service drains the queue at its own sustainable rate, however
// long the backlog currently is.
fn worker_loop(queue: &mut Queue, max_per_tick: usize) {
    for _ in 0..max_per_tick {
        match queue.dequeue() {
            Some(task) => process_task(task),
            None => break,
        }
    }
}

fn process_task(task: Task) {
    println!("processing task {}", task.id);
}
```

`worker_loop` never processes more than `max_per_tick` items regardless
of how many `produce_burst` just enqueued — the service's rate is set
by its own capacity, not by the producer's.

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

## Real-world example

A ride-sharing app's trip-receipt-generation pipeline is a common
example: ride completions can spike sharply (rush hour, a big event
letting out), but receipt generation and emailing don't need to happen
instantly. Completed rides are pushed onto a queue, and a fixed-size
worker fleet processes receipts at a steady rate, growing the queue
briefly during a spike rather than needing to provision enough
receipt-generation capacity to handle the single busiest minute of the
year, year-round.

## Related patterns

- [Backpressure](/docs/patterns/batch-streaming/backpressure) — the complementary mechanism for when the
  queue itself starts to fill: this pattern smooths load using the
  queue as a buffer; backpressure signals the producer to slow down
  once that buffer is exhausted.
- [Auto-Scaling](/docs/patterns/scaling/auto-scaling) — often layered on top, scaling the number of
  consumer workers up or down based on queue depth so the service's
  sustainable rate itself adapts to sustained (not just bursty) demand.

## Further reading

- [Queue-Based Load Leveling pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling)
- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
