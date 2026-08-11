---
title: "Sequential Convoy"
sidebar_position: 11
supplementary: true
---

Sequential Convoy processes a set of related messages — all events for
one order, one user session — in their original relative order, while
still letting unrelated groups of messages process fully in parallel
with each other.

![Sequential Convoy diagram](/img/patterns/sequential-convoy.svg)

## Problem it solves

Some messages have a real ordering dependency on each other — an
"order shipped" event processed before "order placed" is nonsensical,
and a session's "logout" event processed before its "login" makes no
sense either. The two obvious ways to handle a stream containing such
messages both have a real cost. Strictly serializing the entire stream
— one consumer, one message at a time, globally — preserves every
ordering dependency correctly, but throughput is capped at whatever a
single consumer can do, no matter how many unrelated entities the
stream actually contains. Processing everything in parallel with no
structure fixes the throughput problem but breaks correctness: two
messages for the same order can be picked up by different workers and
processed out of order, or concurrently, with no guarantee which
finishes first. What's needed is a way to get the parallelism of the
second approach without giving up the ordering the first one
guarantees — but only where that ordering actually matters.

## How it works

Every message carries (or is assigned) a partition or session key that
identifies which logical group it belongs to — an order ID, a user
session ID, an aggregate ID. Messages are routed so that every message
sharing the same key is always handled by the same processing lane, and
within that lane, messages are processed one at a time in arrival
order. Different keys are handled by different lanes, and those lanes
run fully in parallel with no coordination between them — a worker
processing order A's events has no interaction at all with the worker
processing order B's events. This is a deliberately narrower guarantee
than a single global order: ordering is promised only *within* a group,
never *across* groups, and that narrowing is exactly what makes the
parallelism safe — since unrelated groups have no ordering dependency
on each other in the first place, there's nothing lost by letting them
race.

Routing messages with the same key to the same lane consistently is
the same underlying problem [Consistent Hashing](/docs/patterns/storage/consistent-hashing) solves for
distributing keys across nodes — hashing the partition key to pick a
lane (or a downstream partition) is a common, simple way to get that
consistent routing without a central lookup table, and it's the same
mechanism [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) relies on to guarantee
per-partition order: a sequential convoy is, in effect, partitioned
consumption where the partition key is chosen specifically to align
with the entities that have an ordering dependency.

## Code example

The snippet below models routing messages into per-key lanes and
draining each lane strictly in order, while lanes themselves are
independent of one another.

```rust
use std::collections::{HashMap, VecDeque};

struct Message {
    key: String, // e.g. order ID — defines the convoy this message belongs to
    seq: u64,
    body: String,
}

// One FIFO lane per key; unrelated keys never share a lane.
struct ConvoyRouter {
    lanes: HashMap<String, VecDeque<Message>>,
}

impl ConvoyRouter {
    fn route(&mut self, msg: Message) {
        self.lanes.entry(msg.key.clone()).or_default().push_back(msg);
    }

    // Each lane is drained independently and in order; calling this
    // once per lane, on separate workers/tasks, is what gives
    // unrelated convoys their parallelism.
    fn drain_lane(&mut self, key: &str) {
        if let Some(lane) = self.lanes.get_mut(key) {
            while let Some(msg) = lane.pop_front() {
                println!("[{}] seq {} : {}", msg.key, msg.seq, msg.body);
            }
        }
    }
}
```

`drain_lane("order-A")` and `drain_lane("order-B")` can run on
different threads with no coordination between them, while messages
within a single call to `drain_lane` always come out in the order they
were routed in.

## When to use it

- The stream contains multiple independent entities, each with
  internal events that must stay in order relative to each other, but
  no ordering requirement across different entities.
- Throughput matters enough that fully serializing the whole stream
  isn't acceptable, but correctness rules out processing everything
  with no ordering structure at all.
- A natural partition key already exists (or can be derived) that
  cleanly separates the stream into these independent groups.

## When not to use it

- The stream genuinely needs one single global order across all
  messages, with no independent subgroups — partitioning by key doesn't
  help and a fully serial consumer is unavoidable.
- Messages have no real ordering dependency on each other at all — Sequential
  Convoy's per-key ordering machinery is unnecessary overhead when
  plain [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) would do.
- The chosen key is skewed, with most messages sharing one hot key —
  that key's lane becomes a serialization bottleneck no different from
  a single global queue, defeating the purpose of partitioning at all.

## Real-world example

Payment processors commonly apply this pattern to per-account event
streams: all events for a single account (charge, refund, dispute) must
be applied in order to keep the account's balance consistent, but
different accounts have no ordering dependency on each other, so
partitioning the event stream by account ID lets thousands of accounts'
events process fully in parallel while each individual account's
history stays strictly ordered.

## Related patterns

- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — a common technique for routing
  same-key messages to the same processing lane consistently, without a
  central lookup table.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) — the general mechanism this
  pattern relies on: per-partition order plus parallelism across
  partitions, applied here with the partition key chosen to match
  entities with a real ordering dependency.

## Further reading

- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
- [Consistent hashing — Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
