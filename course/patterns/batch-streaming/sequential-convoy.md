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

## Technical architecture & implementation

**Keying and routing.** Every message carries (or is assigned) a
partition or session key that identifies which logical group it belongs
to — an order ID, a user session ID, an aggregate ID. Messages are
routed so that every message sharing the same key is always handled by
the same processing lane. Getting this routing *consistent* is the same
problem [Consistent Hashing](/docs/patterns/storage/consistent-hashing)
solves for distributing keys across nodes: hashing the key to pick a
lane (or a downstream partition) is the common way to get stable routing
without a central lookup table, and it's the same mechanism
[Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption)
relies on. A sequential convoy is, in effect, partitioned consumption
where the partition key is chosen specifically to align with the
entities that have a real ordering dependency.

**Per-key FIFO, parallel across keys.** Within a lane, messages are
processed one at a time in arrival order; different lanes run fully in
parallel with no coordination between them. A worker processing order
A's events has no interaction at all with the worker processing order
B's. This is a deliberately *narrower* guarantee than a single global
order: ordering is promised only *within* a group, never *across*
groups — and that narrowing is exactly what makes the parallelism safe,
since unrelated groups have no ordering dependency in the first place,
so nothing is lost by letting them race. The result is the property the
pattern exists for: you keep the correctness of strict serialization
*where it matters* (per key) and pay the serialization cost *only*
there, while every other key runs concurrently.

**Concurrency model — lane ownership.** For per-key order to actually
hold, at most one worker may process a given key's messages *at a time*.
There are two common ways to enforce this. In a **partition-owned**
model (Kafka, Kinesis), the key hashes to a partition and each partition
is assigned to exactly one consumer in the group — the broker's
partition-assignment protocol *is* the single-owner guarantee, and
adding a message key gives you convoy ordering essentially for free. In
a **lease/lock** model over a shared queue, a worker that picks up a
message for key K takes a lock on K (or the whole key-group is delivered
as a session, as with Azure Service Bus *sessions*) so no other worker
touches K until it's released. Either way, the invariant is the same:
one active processor per key.

**Failure modes.** Three hazards define operating this pattern.

- **Hot keys / skew.** If one key receives most of the traffic, its
  single lane becomes a serialization bottleneck no different from a
  global queue — the parallelism collapses to the throughput of that one
  hot lane while other lanes sit idle. The fix is a better key (finer
  granularity) or, where ordering permits, a sub-key; there is no way to
  parallelize a single hot key without giving up its ordering.
- **Head-of-line blocking.** Because a lane is strictly in-order, one
  stuck message (a slow handler, a poison message) blocks *every*
  later message for that same key behind it — even though other keys are
  unaffected. A convoy needs a way to time out or divert a stuck message
  (to a [dead-letter queue](/docs/patterns/reliability/dead-letter-queue))
  or the whole key stalls indefinitely.
- **Rebalancing gaps.** When lane ownership moves (a consumer joins or
  dies and partitions reassign), there's a handoff window where the new
  owner must not start K until the old owner has definitely stopped, or
  two workers briefly process K concurrently and the ordering guarantee
  is violated. This is the same fencing discipline partition assignment
  and [idempotency](/docs/patterns/reliability/idempotency) address.

**Ordering delivery is still at-least-once.** Preserving *order* is not
the same as preserving *exactly-once*: a redelivery after a crash can
still replay a message, so handlers should remain idempotent. Order and
deduplication are orthogonal guarantees layered on the same stream.

**Sequential Convoy vs. its siblings.** The sharp contrast is with
[Competing Consumers](/docs/patterns/batch-streaming/competing-consumers):
competing consumers lets *any* worker claim *any* message for maximum
throughput and elasticity, explicitly giving up per-key order;
sequential convoy pins each key to one lane to *preserve* that order,
giving up the free-for-all claim model. Relative to plain
[Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption),
sequential convoy is the same machinery with an intent: the partition
key is chosen deliberately to match the ordering boundary of the
business entities, so "partition" and "convoy" line up.

## Code example

The runnable snippet below routes interleaved messages into per-key
lanes, then drains each lane on its *own real thread* — so lanes run
concurrently while each lane's messages stay strictly in arrival order.
The timing at the end proves the parallelism is genuine.

```rust
use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

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
    fn new() -> Self {
        ConvoyRouter { lanes: HashMap::new() }
    }

    fn route(&mut self, msg: Message) {
        self.lanes.entry(msg.key.clone()).or_default().push_back(msg);
    }
}

// Drain one lane strictly in order; each message is a 15ms unit of work.
// Returns the sequence numbers in processing order so per-lane ordering
// can be confirmed by the caller.
fn drain_lane(mut lane: VecDeque<Message>) -> Vec<u64> {
    let mut order = Vec::new();
    while let Some(msg) = lane.pop_front() {
        std::thread::sleep(Duration::from_millis(15)); // process(msg)
        let _ = &msg.body;
        order.push(msg.seq);
    }
    order
}

fn main() {
    let mut router = ConvoyRouter::new();
    // Three orders, four events each, interleaved on arrival.
    for seq in 0..4 {
        for key in ["order-A", "order-B", "order-C"] {
            router.route(Message { key: key.to_string(), seq, body: format!("{key}#{seq}") });
        }
    }

    let start = Instant::now();
    // Each lane drains on its own thread: lanes run in parallel, but
    // every lane's own messages stay in strict arrival order.
    let results: HashMap<String, Vec<u64>> = std::thread::scope(|scope| {
        let handles: Vec<_> = router
            .lanes
            .into_iter()
            .map(|(key, lane)| scope.spawn(move || (key, drain_lane(lane))))
            .collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let elapsed = start.elapsed();

    let mut keys: Vec<&String> = results.keys().collect();
    keys.sort();
    for key in keys {
        println!("{key} processed in order {:?}", results[key]);
    }
    println!("3 lanes x 4 msgs (15ms each) in {elapsed:?}");
}
```

Running this prints each order's events in strict `[0, 1, 2, 3]`
sequence — per-key order is preserved even though arrivals were
interleaved — while the total wall time is about **75 ms**, not the
~180 ms a single serial consumer would take for twelve 15 ms messages.
That gap is the parallelism: three lanes ran at once, and the run would
have been correct-but-slow only if the lanes had been drained one after
another. Add a fourth order and it gets its own lane running alongside
the rest, at no cost to the others' ordering.

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

## Use-case scenarios

**Per-account payment ledger.** All events for a single account
(charge, refund, dispute, reversal) must be applied in order to keep the
balance consistent — a refund can't be processed before the charge it
refunds. Partitioning the event stream by account ID gives each account
its own ordered lane, so thousands of accounts' events process fully in
parallel while each individual account's history stays strictly ordered.
Handlers stay idempotent so a redelivery after a crash replays safely.

**Order-lifecycle event processing.** An e-commerce platform emits a
stream of order events (`placed`, `paid`, `packed`, `shipped`,
`delivered`) across millions of orders. Processing `shipped` before
`placed` is nonsensical, so the stream is keyed by order ID: every event
for one order flows through the same lane in arrival order, while
unrelated orders process concurrently. A slow or poison event on one
order blocks only that order's lane, so a timeout-and-dead-letter guard
keeps a single stuck order from stalling forever.

**Per-device/session state updates.** An IoT or gaming backend receives
state-transition events per device or per player session, where applying
transitions out of order would corrupt the tracked state (a "door
closed" before "door opened"). Keying by device or session ID pins each
entity's events to one ordered lane; the number of concurrent lanes
scales with the number of active devices, so throughput grows with the
fleet as long as no single device is a hot key monopolizing its lane.

## Production libraries & getting started

You get sequential-convoy behavior by choosing a mechanism that pins every
same-key message to a single ordered lane — a session, a partition key, or
a key-shared subscription — so per-key order holds while unrelated keys run
in parallel.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Azure Service Bus sessions | Any (Azure SDK) | Message sessions: all messages with the same `SessionId` are delivered in order to one consumer | [Message sessions](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-sessions) |
| Apache Kafka | Any (many clients) | Partition-by-key ordering: same key → same partition → one consumer, in offset order | [Concepts & terminology](https://kafka.apache.org/documentation/#intro_concepts_and_terms) |
| Apache Pulsar | Any (many clients) | `Key_Shared` subscription keeps per-key order while spreading distinct keys across consumers | [Key_Shared subscription](https://pulsar.apache.org/docs/concepts-messaging/#key_shared) |
| RabbitMQ consistent-hash exchange | Any (AMQP client) | Routes same-key messages to the same queue/consumer for stable per-key lanes | [Consistent hash exchange plugin](https://github.com/rabbitmq/rabbitmq-server/tree/main/deps/rabbitmq_consistent_hash_exchange) |

## Related patterns

- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) —
  the order-*indifferent* counterpart: any worker claims any message for
  maximum throughput, explicitly giving up the per-key ordering that
  sequential convoy preserves.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) —
  the general mechanism this pattern relies on: per-partition order plus
  parallelism across partitions, applied here with the partition key
  chosen to match entities with a real ordering dependency.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — a
  common technique for routing same-key messages to the same processing
  lane consistently, without a central lookup table.
- [Idempotency](/docs/patterns/reliability/idempotency) — order
  preservation doesn't remove at-least-once redelivery, so handlers must
  still dedupe replays.
- [Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where a stuck poison message is diverted so it doesn't head-of-line-
  block every later message in its lane.

## Further reading

- [Sequential Convoy pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sequential-convoy)
- [Message ordering with Service Bus sessions — Microsoft docs](https://learn.microsoft.com/en-us/azure/service-bus-messaging/message-sessions)
- [Kafka partitions and ordering — Apache Kafka documentation](https://kafka.apache.org/documentation/#intro_concepts_and_terms)
- [Consistent hashing — Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
