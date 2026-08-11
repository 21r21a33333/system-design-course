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

## Technical architecture & implementation

**Assigning priority.** Each message is tagged with a priority — a small
integer or a named tier (e.g. high/medium/low) — either by the producer
at enqueue time or by a rule applied at the queue's entry point (a
gateway that reads the customer's plan, the request type, or an SLA
class). Keeping the number of distinct priorities **bounded and small**
matters: a handful of meaningful tiers is operable and reasonable to
reason about, whereas a continuous or unbounded priority space tends to
degenerate into everything claiming to be urgent, which is the same as
having no priorities at all.

**Two implementation shapes.** There are two common ways to realize the
"serve higher priority first" behavior, and they have different
operational properties.

- **A single priority-ordered queue.** One structure keeps items
  ordered by priority — a binary heap gives O(log n) push and
  pop-highest. This is compact and exact, but it's a single hot
  structure every producer and consumer contends on, and expressing
  "FIFO *within* a tier" requires folding arrival order into the sort
  key (priority first, then timestamp) so equal-priority items don't
  reorder arbitrarily.
- **Separate queues per priority with weighted polling.** Each tier is
  its own plain FIFO queue, and consumers poll them in priority order:
  drain high, then medium, then low. This maps cleanly onto real
  broker/queue services (you just create three queues) and makes
  per-tier FIFO automatic. Strict "always drain high first" polling is
  the most aggressive form; **weighted** polling (e.g. take 8 from high,
  2 from medium, 1 from low per cycle) deliberately reserves some
  consumer capacity for lower tiers, which is itself a starvation guard
  (see below).

**Consumer discipline.** With either shape, consumers pull the
highest-priority item currently available and only fall through to
lower priorities when nothing higher is waiting. Within a tier, items
are processed FIFO relative to each other — so priority changes *which*
backlog an item competes in, not whether ordering exists within a tier.
This layers cleanly on top of a
[competing-consumers](/docs/patterns/batch-streaming/competing-consumers)
pool: multiple workers can pull from the priority-ordered queue (or the
per-tier queues) in parallel to raise high-priority throughput further.

**The failure mode this introduces — starvation.** Priority creates a
new hazard that plain FIFO doesn't have: if high-priority work keeps
arriving fast enough, a consumer that always drains the highest tier
first may *never* reach lower-priority items — they wait not merely
longer but potentially forever. Unlike a slow-but-bounded FIFO backlog,
strict priority has no built-in ceiling on how long a low-priority item
can be delayed. Guarding against this is not optional for any system
under sustained high-priority load; the next section covers how.

**Priority queue vs. its siblings.** Priority queuing reorders relative
to arrival; that's its whole point, and it's exactly why it's the wrong
tool where strict arrival-order fairness is required. It's orthogonal
to [queue-based load leveling](/docs/patterns/batch-streaming/queue-based-load-leveling)
(which smooths *volume* over time without caring about relative
urgency) and to [rate limiting](/docs/patterns/building-blocks/rate-limiter)
(which caps *how much* is admitted, not *which* is served first). The
three compose: a system can rate-limit admission, load-level the
buffer, and prioritize what the consumers pull from it.

## Avoiding starvation

Starvation is the defining risk of priority queuing, so a production
priority queue almost always ships with an explicit guard. The two
standard approaches:

- **Aging (priority boosting).** Gradually increase a waiting item's
  *effective* priority the longer it sits unprocessed, so even a
  persistently low-priority item eventually crosses into a higher tier
  and gets picked. Aging trades away some strict
  ordering-by-declared-priority for a **bounded worst-case wait**, which
  is usually the more valuable guarantee: a system where low-priority
  work is merely *slower* is fine; one where it's *starved outright*
  usually isn't. The aging rate is the tuning knob — steeper aging
  bounds the wait more tightly but erodes the priority distinction
  faster. The code example below implements linear aging.

- **Weighted / reserved-capacity polling.** Instead of always draining
  the top tier, dedicate a fixed *fraction* of consumer cycles to lower
  tiers (e.g. 8:2:1 across high/medium/low). This guarantees lower tiers
  always make *some* forward progress regardless of high-tier arrival
  rate, at the cost of occasionally serving a lower-priority item while
  a higher-priority one waits. It's simpler to reason about than aging
  (no per-item effective-priority recomputation) and maps directly onto
  weighted round-robin over per-tier queues.

The two aren't mutually exclusive — a system can weight its polling
*and* age long-waiting items — but shipping *neither* under sustained
load is the classic way a priority queue turns a "low-priority work is
slow" situation into a "low-priority work never runs" outage.

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

## Use-case scenarios

**Tiered support/SLA request processing.** A SaaS platform's background
job system serves paying enterprise customers alongside free-tier
users. Enterprise jobs enter a high-priority tier and are drained
first, so a burst of free-tier batch work can't push a paying
customer's export behind hours of backlog. Aging keeps free-tier jobs
from starving outright — a free job that has waited long enough
eventually boosts into a tier that gets served — so the platform honors
paid SLAs without silently abandoning free users.

**Operator alerts ahead of routine telemetry.** A monitoring pipeline
ingests both critical alerts (a service is down) and high-volume
routine metrics on the same path. Alerts are tagged high-priority so a
flood of ordinary telemetry never delays paging an on-call engineer.
Because a sustained alert storm could otherwise starve routine
ingestion entirely, weighted polling reserves a slice of consumer
capacity for the lower tier, keeping dashboards updating even during an
incident.

**OS process scheduling (the classic analogue).** CPU schedulers are
the textbook instance of this pattern outside messaging: process
priorities determine scheduling order, and most schedulers implement
priority boosting specifically to stop low-priority processes from
being starved by a steady stream of higher-priority ones — the same
aging idea the code example implements, applied to CPU time instead of
queue position.

## Related patterns

- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) —
  priority queuing is often layered on top of a competing-consumers
  worker pool, where multiple workers pull from the priority-ordered
  queue in parallel to increase high-priority throughput further.
- [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) —
  smooths total volume over time and is orthogonal to priority; the two
  compose, with the buffer absorbing bursts and priority deciding
  serving order within it.
- [Rate Limiter](/docs/patterns/building-blocks/rate-limiter) — caps how
  much work is admitted rather than which work is served first; a common
  companion that bounds the input a priority queue then orders.

## Further reading

- [Priority Queue pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/priority-queue)
- [Priority queue — Wikipedia](https://en.wikipedia.org/wiki/Priority_queue)
- [Starvation (computer science) — Wikipedia](https://en.wikipedia.org/wiki/Starvation_(computer_science))
- [Aging (scheduling) — Wikipedia](https://en.wikipedia.org/wiki/Aging_(scheduling))
