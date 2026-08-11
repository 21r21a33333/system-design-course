---
title: "Priority Queue"
sidebar_position: 10
supplementary: true
---

Priority Queue, as a messaging pattern, assigns a priority to each
request or message so that higher-priority items are processed before
lower-priority ones, instead of every item waiting its turn in strict
first-in-first-out order.

![Priority Queue diagram](/img/patterns/priority-queue.svg)

## Problem it solves

A plain FIFO queue treats every item as equally urgent: a critical
password-reset email and a bulk marketing newsletter enqueued around
the same time wait behind exactly the same backlog, in exactly the
order they arrived. When the queue is short that's harmless, but under
load — a large batch of low-urgency work enqueued just ahead of a
time-sensitive request — strict FIFO means the urgent item sits behind
all of it, even though nothing about its importance changed. Systems
routinely have a real difference in urgency between message types (a
paying customer's request versus a free-tier request, an alert versus
a routine log line), and a queue with no notion of priority has no way
to express or act on that difference.

## How it works

Each message is tagged with a priority — a small integer or a named
tier (e.g. high/medium/low) — either by the producer at enqueue time or
by a rule applied at the queue's entry point. Instead of a single FIFO
list, the queue maintains ordering (or separate sub-queues) by
priority: consumers always pull the highest-priority item currently
available, and only fall through to lower priorities when nothing
higher is waiting. Within the same priority level, items are typically
still processed in FIFO order relative to each other, so priority
changes *which* backlog an item competes in, not whether ordering
exists at all within a tier.

The risk this introduces is **starvation**: if high-priority work
keeps arriving fast enough, a consumer that always drains the highest
tier first may never get around to lower-priority items — they can wait
indefinitely, not just longer. The standard mitigation is **aging** —
gradually increasing a waiting item's effective priority the longer it
sits unprocessed, so that even a persistently low-priority item
eventually crosses the threshold into a higher tier and gets its turn.
Aging trades away some of the strict ordering-by-declared-priority for
a bounded worst-case wait, which is usually the more important
guarantee in practice: a system where low-priority work is *slower* is
fine, but one where it's *starved outright* usually isn't.

## Code example

The snippet below models a priority queue with simple linear aging: a
waiting item's effective priority increases the longer it's been
queued, bounding how long a low-priority item can be starved.

```rust
struct Item {
    id: u64,
    base_priority: u32, // higher = more urgent
    enqueued_at_tick: u64,
}

struct AgingQueue {
    items: Vec<Item>,
    aging_rate: u32, // effective priority gained per tick waited
}

impl AgingQueue {
    fn push(&mut self, item: Item) {
        self.items.push(item);
    }

    // Effective priority grows with wait time, so an old low-priority
    // item eventually outranks a freshly-arrived high-priority one.
    fn effective_priority(&self, item: &Item, now_tick: u64) -> u32 {
        let waited = now_tick.saturating_sub(item.enqueued_at_tick);
        item.base_priority + (waited as u32) * self.aging_rate
    }

    fn pop_highest(&mut self, now_tick: u64) -> Option<Item> {
        let index = self
            .items
            .iter()
            .enumerate()
            .max_by_key(|(_, item)| self.effective_priority(item, now_tick))
            .map(|(i, _)| i)?;
        Some(self.items.remove(index))
    }
}
```

Without aging, a `base_priority`-only comparison would let a steady
stream of high-priority arrivals starve low-priority items forever;
adding wait time into `effective_priority` guarantees every item's
priority eventually rises enough to be picked.

## When to use it

- Message or request types have a genuine, meaningful difference in
  urgency, and that difference should affect processing order under
  load, not just be a label.
- Occasional bursts of high-priority work shouldn't have to wait behind
  a backlog of lower-priority work that happened to arrive first.
- The system can tolerate variable latency for low-priority items (as
  long as it's bounded via aging or a similar mechanism) in exchange
  for consistently low latency on high-priority items.

## When not to use it

- All work is genuinely equally urgent — introducing priority tiers
  where there's no real difference in importance just adds complexity
  without changing outcomes.
- Strict arrival-order fairness is a hard requirement (e.g. financial
  order matching, some auditability requirements) — priority queuing
  explicitly reorders relative to arrival time, which is disqualifying
  in those contexts.
- Aging (or an equivalent starvation guard) can't be implemented or
  tuned correctly — an un-aged priority queue under sustained
  high-priority load can starve low-priority work indefinitely, which
  is often worse than the uniform-but-fair delay of plain FIFO.

## Real-world example

CPU schedulers in operating systems are a classic instance of this
pattern outside of messaging: process priorities determine scheduling
order, and most schedulers implement some form of priority aging (often
called priority boosting) specifically to prevent low-priority
processes from being starved indefinitely by a steady stream of
higher-priority ones. In infrastructure, cloud task queue services
(e.g. multiple priority levels on a managed queue) apply the same idea
directly to request processing.

## Related patterns

- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) — priority queuing is often layered
  on top of a competing-consumers worker pool, where multiple workers
  pull from the priority-ordered queue in parallel to increase
  high-priority throughput further.

## Further reading

- [Priority queue — Wikipedia](https://en.wikipedia.org/wiki/Priority_queue)
- [Starvation (computer science) — Wikipedia](https://en.wikipedia.org/wiki/Starvation_(computer_science))
