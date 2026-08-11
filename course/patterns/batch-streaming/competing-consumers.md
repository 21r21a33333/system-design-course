---
title: "Competing Consumers"
sidebar_position: 8
supplementary: true
---

Competing Consumers runs multiple consumer instances against the same
queue or subscription so that each message is delivered to exactly one
of them, letting the group's total processing throughput scale by
simply adding more consumer instances.

![Competing Consumers diagram](/img/patterns/competing-consumers.svg)

## Problem it solves

A single consumer reading a work queue has a hard ceiling on
throughput: whatever one process can chew through per second is the
whole system's capacity, no matter how fast the producer or how large
the backlog gets. Vertically scaling that one consumer (a bigger
machine, more threads in the same process) only goes so far and
usually isn't where the elasticity is needed — what's needed is the
ability to add capacity by adding more workers, the same way a web
tier scales by adding more instances behind a load balancer. Doing
that naively, by just starting more processes that all read the same
queue, immediately raises the question of who gets which message; if
that isn't handled at the queue level, multiple consumers doing the
same work twice (or racing each other) is the likely result.

## How it works

Any number of consumer instances connect to the same queue or
subscription and pull from it concurrently. The broker guarantees that
each individual message is handed to exactly one of those consumers —
never broadcast to all of them — typically by having consumers
compete to claim the next available message, or by the broker
round-robining messages across whichever consumers are currently
connected and idle. Once a consumer has a message, it processes it and
acknowledges completion; only after that acknowledgment does the
broker consider the message done and remove it from the queue. If a
consumer crashes or times out mid-processing without acknowledging,
the broker makes the message visible again so another consumer instance
picks it up — the group as a whole is resilient to any single
consumer's failure, not just to the queue's failure. Because consumers
are interchangeable and stateless with respect to the queue, scaling
the group is just a matter of starting or stopping instances; no
message needs to be told in advance which consumer will handle it.

The key distinction from [Publish-Subscribe](/docs/patterns/communication/pub-sub) is what happens to each
message, not how many consumers are involved. In pub-sub's fan-out
delivery, every subscriber gets its own copy of every message — the
whole point is that N subscribers each independently see all N
messages, because they're doing different things with the same event
(one subscriber sends an email, another updates a search index).
Competing Consumers is the opposite: N consumers still only do the
work of processing the message set once between them, each message
going to exactly one consumer, because the consumers are interchangeable
peers doing the *same* job and dividing up the *same* workload for
throughput, not fanning the same event out to different downstream
purposes. Put simply, pub-sub multiplies delivery across differing
subscribers; competing consumers divides delivery across identical
workers.

## Code example

The snippet below models a queue handing each message to whichever
worker claims it first — no message is ever handed to more than one.

```rust
use std::collections::VecDeque;

struct Message {
    id: u64,
    payload: String,
}

// Stand-in for a broker queue: claim() removes and hands out one
// message at a time, so two workers can never claim the same message.
struct Queue {
    messages: VecDeque<Message>,
}

impl Queue {
    fn claim(&mut self) -> Option<Message> {
        self.messages.pop_front()
    }
}

// Each worker independently pulls from the same queue until it's empty.
// Adding more workers increases total throughput without any worker
// needing to know about the others.
fn run_worker(worker_id: u32, queue: &mut Queue) {
    while let Some(msg) = queue.claim() {
        println!("worker {worker_id} processing message {}: {}", msg.id, msg.payload);
        // process(msg) would run the actual unit of work here.
    }
}
```

In a real broker, `claim()` is atomic across concurrent callers (e.g.
Kafka's per-partition assignment or SQS's visibility timeout), so two
worker processes racing to read never receive the same message.

## When to use it

- Throughput on a queue of independent, identical work items needs to
  scale horizontally by adding more consumer processes, rather than
  being capped by a single consumer's capacity.
- Work items don't need to be broadcast to multiple different
  downstream purposes — each item just needs to be processed once, by
  whichever available worker picks it up.
- Consumers can be made stateless and interchangeable with respect to
  the queue, so any instance can pick up any message without needing
  prior context about it.

## When not to use it

- Every consumer actually needs to see every message for a different
  purpose — that's [Publish-Subscribe](/docs/patterns/communication/pub-sub)'s fan-out delivery, not this
  pattern's divide-the-work delivery.
- Messages for the same logical entity must be processed in order
  relative to each other — plain competing consumers gives no ordering
  guarantee across messages, since any consumer can claim any message;
  see [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) for scaling out while
  preserving per-key order.
- The workload is so low-volume that a single consumer never becomes a
  bottleneck — running a pool of competing consumers adds operational
  complexity (monitoring, scaling policy, idle-worker cost) that isn't
  earning its keep.

## Real-world example

Amazon SQS is built around this pattern directly: any number of
consumer processes can poll the same standard queue, and SQS's
visibility timeout ensures a message picked up by one consumer is
hidden from the others until it's acknowledged or the timeout expires,
so a fleet of worker instances can be scaled up or down to match queue
depth without any coordination between the workers themselves.

## Related patterns

- [Publish-Subscribe](/docs/patterns/communication/pub-sub) — fans the same message out to every
  subscriber for different purposes; Competing Consumers instead
  divides a single workload across interchangeable workers.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) — a more structured way to scale
  out consumers that also preserves per-key ordering, which plain
  competing consumers does not.

## Further reading

- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
- [Competing Consumers pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/competing-consumers)
