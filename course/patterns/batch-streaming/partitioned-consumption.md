---
title: "Partitioned Consumption"
sidebar_position: 7
supplementary: true
---

Partitioned consumption splits a stream or topic into multiple
partitions, each consumed by exactly one consumer within a given consumer
group at a time, so consumption scales horizontally while still
preserving the order of events within each partition. The partition is
both the unit of parallelism and the unit of ordering — and those two
roles being the same thing is the pattern's whole design.

![Partitioned Consumption diagram](/img/patterns/partitioned-consumption.svg)

## Problem it solves

A single consumer reading a stream is limited to that one process's
throughput — it becomes the bottleneck as event volume grows, no matter
how the producers scale. The obvious fix, running many consumers against
the same stream, immediately raises a harder problem: if several
consumers can pick up any event, what stops two of them from processing
the same event, or from processing events for the same entity (the same
user, the same order) out of order relative to each other? Partitioned
consumption gives a structured answer — parallelism *across* partitions,
but a single ordered consumer *per* partition — instead of leaving
coordination between concurrent consumers as ad hoc locking. It is the
disciplined alternative to the plain
[Competing Consumers](/docs/patterns/batch-streaming/competing-consumers)
model, trading that model's arbitrary work distribution for a fixed
key→partition mapping that buys per-key ordering.

## Technical architecture & implementation

**Partitions as the unit of parallelism.** A stream is divided into a
fixed number of partitions at write time. Each partition is an
independent, append-only, ordered log with its own sequence of offsets.
Parallelism comes from processing partitions concurrently: N partitions
can be read by up to N consumers simultaneously. This makes the partition
count the single most important capacity decision — it is the ceiling on
consumer parallelism, discussed below.

**Key → partition routing.** Which partition an event lands in is
normally decided by hashing a routing key — `hash(key) % partition_count`
— so that all events for the same key (a user id, an order id) always
land in the same partition. This is the same key-to-bucket mapping idea
as [Consistent Hashing](/docs/patterns/storage/consistent-hashing),
though fixed-partition streams typically use plain modulo hashing since
the partition count is stable. The choice of key is load-bearing: it
determines both *co-location* (which events share ordering) and *balance*
(whether load spreads evenly).

**Ordering only within a partition.** The broker guarantees events are
delivered in offset order *within* a single partition, and makes **no
ordering guarantee across partitions**. This is the fundamental trade:
you get strict per-key order for free (because a key's events are all in
one partition) but you give up any global total order across the whole
topic. Designs that need a single global sequence can't be partitioned
without reintroducing a serialization point.

**Consumer groups.** Consumers are organized into named **consumer
groups**. The broker assigns each partition to exactly one consumer
within a group, so a group's total read throughput scales by adding
consumers. Different groups are fully independent — each has its own
assignment and its own read position (offset), so multiple applications
can each consume the whole stream at their own pace without interfering.
One group might feed a real-time dashboard while another archives to
storage, both reading every event.

**Max parallelism = partition count.** Because a partition is assigned to
at most one consumer per group, adding more consumers than there are
partitions leaves the extras **idle** — there is nothing left to hand
them. A topic with 8 partitions caps a consumer group at 8 actively
working consumers. Under-partitioning permanently limits scale (and
repartitioning a live topic is disruptive), so partition count is chosen
with future throughput in mind.

**Offset tracking per partition.** Each consumer tracks its progress as a
**committed offset per partition** — the position up to which it has
processed. On restart or reassignment, consumption resumes from the last
committed offset. *When* the offset is committed relative to the work
defines the delivery guarantee: commit-before-processing risks loss on
crash, commit-after risks duplicates, and committing the offset
*atomically with the output* is what
[Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics)
requires — the per-partition offset is precisely the thing committed in
that transaction.

**Rebalancing and its cost.** When a consumer joins or leaves (a deploy,
a crash, autoscaling), the group **rebalances** — partitions are
reassigned across the surviving members. The naive protocol is
**stop-the-world**: *all* consumers pause, revoke their partitions, and
wait for a new assignment before anyone resumes, so a single consumer
restart briefly stalls the whole group. Because this is costly, modern
brokers use **sticky / cooperative** assignment that keeps most
partitions with their current owner and moves only the minimum, and
**incremental cooperative rebalancing** that revokes only the partitions
actually changing hands rather than pausing everything. Long processing
loops must also stay within the group's session timeout, or the broker
assumes the consumer died and triggers an unnecessary rebalance.

**Hot partitions.** A skewed routing key (one whale user, one giant
tenant) sends disproportionate traffic to a single partition. Because
that partition has exactly one consumer, it becomes a bottleneck the
whole group can't relieve by adding consumers — the other consumers sit
underused while the hot partition's owner falls behind. Mitigations
include a compound or salted key to spread a hot entity across
partitions (at the cost of losing strict per-entity order for it) or
choosing a higher-cardinality key up front.

**Partitioned consumption vs. competing consumers.** Plain
[Competing Consumers](/docs/patterns/batch-streaming/competing-consumers)
pulls from one shared queue where *any* free worker takes the *next*
message — maximum load balancing, zero ordering, and workers scale
independently of any partition count. Partitioned consumption pins each
key to a partition to *preserve per-key order* and caps parallelism at
the partition count. Choose competing consumers when order doesn't
matter and you want elastic, perfectly-balanced workers; choose
partitioned consumption when per-key order is required.

## Comparison with competing consumers

| Aspect | Partitioned consumption | Competing consumers |
| --- | --- | --- |
| Ordering | Preserved per partition/key | None |
| Max parallelism | Partition count | Unbounded (add workers) |
| Load balance | Depends on key distribution | Naturally even (pull next) |
| Work assignment | Fixed by key hash | Any free worker takes next |
| Best when | Per-key order required | Independent tasks, order irrelevant |

## Code example

A key→partition router with per-partition ordered offsets. All events for
a key hash to the same partition, so their relative order is preserved,
and each partition assigns strictly increasing offsets independently.

```rust
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

pub struct PartitionedLog {
    partition_count: u64,
    // partition -> ordered list of (offset, key, payload)
    partitions: HashMap<u64, Vec<(u64, String, String)>>,
    next_offset: HashMap<u64, u64>,
}

impl PartitionedLog {
    pub fn new(partition_count: u64) -> Self {
        assert!(partition_count > 0);
        PartitionedLog {
            partition_count,
            partitions: HashMap::new(),
            next_offset: HashMap::new(),
        }
    }

    // Stable key -> partition mapping. Same key always routes to the same
    // partition regardless of arrival interleaving.
    pub fn partition_for(&self, key: &str) -> u64 {
        let mut h = DefaultHasher::new();
        key.hash(&mut h);
        h.finish() % self.partition_count
    }

    // Append an event; returns (partition, assigned offset).
    pub fn append(&mut self, key: &str, payload: &str) -> (u64, u64) {
        let p = self.partition_for(key);
        let offset = *self.next_offset.get(&p).unwrap_or(&0);
        self.partitions
            .entry(p)
            .or_default()
            .push((offset, key.to_string(), payload.to_string()));
        self.next_offset.insert(p, offset + 1);
        (p, offset)
    }

    // All events for a key, in per-partition order (the ordering guarantee).
    pub fn events_for_key(&self, key: &str) -> Vec<String> {
        let p = self.partition_for(key);
        self.partitions
            .get(&p)
            .map(|v| {
                v.iter()
                    .filter(|(_, k, _)| k == key)
                    .map(|(_, _, payload)| payload.clone())
                    .collect()
            })
            .unwrap_or_default()
    }
}
```

Verified behavior: appending interleaved events for `user-42` and
`user-99`, all of `user-42`'s events route to the same partition and come
back in append order (`login`, `add_to_cart`, `checkout`), while that
partition's offsets are contiguous and strictly increasing — per-key
ordering and independent per-partition offsets, exactly as a real
partitioned log provides.

## When to use it

- High-throughput streams where a single consumer can't keep up and
  parallel consumption is needed to scale horizontally.
- Workloads where ordering matters only within a logical entity (all
  events for one user in order) but not globally — partitioning by that
  entity's key gives per-entity order for free while parallelizing across
  entities.
- Systems that need multiple independent consumer applications to each
  read the same stream at their own pace, via separate consumer groups.

## When not to use it

- Streams requiring a single global ordering across all events, which
  partitioning inherently breaks — order is guaranteed only within a
  partition.
- Low-throughput streams where one consumer already keeps up — the
  operational complexity of partition and consumer-group management isn't
  worth it.
- Cases with a poorly-distributed key — a few hot partitions bottleneck
  the whole group even with many consumers running, and plain
  [competing consumers](/docs/patterns/batch-streaming/competing-consumers)
  would balance load better when order doesn't matter.

## Use-case scenarios

**Per-user event ordering in a social feed.** A social platform
partitions its activity stream by user id, so every action a given user
takes (post, edit, delete) lands in one partition and is processed in
order — a delete can never be applied before the post it removes. Adding
consumers scales the feed-builder up to the partition count, and a
separate consumer group independently feeds an analytics warehouse from
the same stream.

**Order-lifecycle processing in commerce.** An order-management system
keys its event stream by order id, guaranteeing that `created`,
`paid`, `shipped`, and `cancelled` events for one order are handled in
sequence by a single consumer, while thousands of *different* orders are
processed fully in parallel across partitions. Per-order correctness and
horizontal scale coexist because ordering is scoped to the key, not the
whole topic.

**Multi-tenant metrics ingestion with skew handling.** A monitoring SaaS
partitions incoming metrics by tenant, but its largest tenants would
create hot partitions. It salts the routing key for those tenants
(tenant id plus a bucket suffix) to spread their load across several
partitions, deliberately relaxing strict per-tenant ordering for the
whales in exchange for keeping any one partition from becoming the
group's bottleneck.

## Production libraries & getting started

Partitioned consumption is what Kafka-style consumer groups and Kinesis
shard consumers implement natively — you pick a partition key and the
broker/library handles assignment, offsets, and rebalancing.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| KafkaJS | JS / TS | Consumer-group client with partition assignment and offset commits | [Consuming messages](https://kafka.js.org/docs/consuming) |
| rust-rdkafka | Rust | librdkafka bindings: consumer groups, rebalancing, offset management | [rdkafka docs](https://docs.rs/rdkafka/latest/rdkafka/) |
| Sarama / franz-go | Go | Two mature Kafka clients with consumer-group support | [Sarama](https://github.com/IBM/sarama) · [franz-go](https://github.com/twmb/franz-go) |
| confluent-kafka-python | Python | librdkafka-backed client with consumer groups and cooperative rebalancing | [confluent-kafka-python](https://github.com/confluentinc/confluent-kafka-python) |
| AWS Kinesis (KCL) | Java / multi-lang | Kinesis Client Library: one worker per shard, lease-based assignment, checkpointing | [KCL developer guide](https://docs.aws.amazon.com/streams/latest/dev/kcl.html) |
| Apache Pulsar | Any (many clients) | Partitioned topics with `Failover` / `Key_Shared` subscriptions for ordered per-key consumption | [Pulsar standalone quickstart](https://pulsar.apache.org/docs/getting-started-standalone/) |
| Redpanda | Any (Kafka clients) | Kafka-API-compatible streaming platform; same consumer-group semantics | [Redpanda quickstart](https://docs.redpanda.com/current/get-started/quick-start/) |

## Related patterns

- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers)
  — the unordered, perfectly-balanced alternative; partitioned
  consumption is what you reach for when per-key order matters.
- [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics)
  — relies on the per-partition offsets this pattern maintains, committed
  atomically with output.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  key-to-bucket mapping technique used in spirit to route keys to
  partitions.
- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) —
  the typical consumer of a partitioned stream, with stateful operators
  keyed the same way events are partitioned.
- [Distributed Message Queue](/docs/patterns/building-blocks/distributed-message-queue)
  — the broker that implements partitions, consumer groups, and offset
  tracking.

## Further reading

- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
- [Consistent hashing — Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
- [Consumer group protocol — Apache Kafka documentation](https://kafka.apache.org/documentation/#intro_consumers)
- [Incremental Cooperative Rebalancing in Apache Kafka — Confluent](https://www.confluent.io/blog/incremental-cooperative-rebalancing-in-kafka/)
- [Partitions — AWS Kinesis Data Streams developer guide](https://docs.aws.amazon.com/streams/latest/dev/key-concepts.html)
