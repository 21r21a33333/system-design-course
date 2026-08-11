---
title: "Distributed Message Queue"
sidebar_position: 5
supplementary: true
---

A distributed message queue is a message-transport system that runs as a
replicated cluster and moves messages from producers to consumers
asynchronously. In its classic broker form it delivers each message to one
consumer and deletes it on acknowledgement; in its log-based form it retains
an ordered, replayable append-only log of messages per partition, letting
many independent consumers read the same stream at their own pace.

![Distributed Message Queue diagram](/img/patterns/distributed-message-queue.svg)

## Problem it solves

The primer's [Asynchronism](/docs/concepts/asynchronism) page covers *why*
you decouple a producer from a consumer with a queue — faster responses,
background processing, load leveling. What it doesn't cover is the
architectural fork between two genuinely different ways of implementing "a
queue" at scale, and the delivery, ordering, and scaling tradeoffs each
makes. A producer that emits an event should not have to know how many
consumers exist, whether they are online, or how fast they process — and
consumers should be able to fall behind, crash, restart, and catch up
without losing work or blocking the producer. Getting those guarantees
right, across a cluster that must survive broker failures, is what this
building block is for.

## Technical architecture & implementation

**Classic broker vs. partitioned log.** These are two distinct designs that
both get called "a queue." A **broker** (RabbitMQ, ActiveMQ, Amazon SQS)
holds messages in a queue data structure, hands each message to one
consumer, and removes it once acknowledged — the message's lifetime is tied
to its consumption. A **partitioned log** (Apache Kafka, Apache Pulsar, AWS
Kinesis) treats a topic as an ordered, append-only file split into
partitions; messages are appended with a monotonically increasing **offset**
and are *not* removed when read — they age out only by retention policy.
The broker optimises for "deliver once, then forget"; the log optimises for
"durable, replayable stream many readers can share."

**Offsets and consumer groups.** In the log model, a consumer does not
remove what it reads; it advances a cursor. Each **consumer group** commits
its own next-to-read offset per partition, so two groups on the same topic
(say, a billing pipeline and an analytics pipeline) read the same records
independently and at different speeds. A group divides a topic's partitions
among its members so each partition is read by exactly one member at a time;
adding members up to the partition count raises parallelism, and losing a
member triggers a **rebalance** that reassigns its partitions to survivors.
This makes the partition count a hard ceiling on a single group's read
parallelism — a capacity decision that must be made up front.

**Ordering & partitioning.** Total ordering across a whole topic is
expensive and rarely needed; the log model guarantees order only *within* a
partition. Messages that must be processed in order relative to each other
(all events for one account) are routed to the same partition by hashing a
**partition key**, so their relative order is preserved while unrelated keys
spread across partitions for throughput. The code example below shows this
FNV-based key routing.

**Delivery guarantees.** Both models offer a spectrum. **At-most-once**
(ack before processing) may lose messages but never duplicates.
**At-least-once** (ack after processing) never loses but may redeliver on a
crash between processing and commit — so consumers must be
[idempotent](/docs/patterns/reliability/idempotency). **Exactly-once** is
the hard one: end-to-end it requires either consumer-side deduplication or a
transaction that atomically commits the offset and the side effect together;
see [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics).
The universal tradeoff — durability and no-duplication pull against each
other, and the consumer does extra work to get both — is unavoidable.

**Backpressure & flow control.** A fast producer can outrun slow consumers.
A **pull** model (Kafka: consumers fetch when ready) applies backpressure
naturally — a slow consumer simply fetches less, and lag becomes an
observable metric. A **push** model (some AMQP setups) must add explicit
flow control (prefetch limits, credit-based windows) or risk overwhelming
consumers; see [Backpressure](/docs/patterns/batch-streaming/backpressure)
and [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling).

**Poison messages & dead-letter queues.** A message that always fails to
process would, under at-least-once redelivery, be retried forever and block
its partition. A **dead-letter queue** captures a message after a maximum
redelivery count so the rest of the stream keeps flowing and the bad message
can be inspected out of band — see
[Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue).

**Replication & durability.** In a cluster each partition (or queue) is
replicated to several brokers; one is the leader that accepts writes, and a
write is acknowledged only once enough replicas have it (a configurable
acknowledgement level). If the leader fails, a replica is promoted. This is
the durability floor beneath every delivery guarantee above — lose the
replicated log and no consumer-side care can recover the messages.

**Where it sits among siblings.** The
[competing-consumers](/docs/patterns/batch-streaming/competing-consumers)
pattern is the broker model's scaling story: N workers race for messages off
one queue. [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption)
is the log model's: partitions are assigned, not raced for.
[Pub-Sub](/docs/patterns/communication/pub-sub) is the messaging *shape*
(fan-out to many subscribers) that the log model implements durably via
consumer groups, whereas a plain broker queue is point-to-point.

## Delivery guarantees at a glance

| Guarantee | Ack timing | Loss? | Duplicates? | Consumer must… |
|---|---|---|---|---|
| At-most-once | before processing | possible | never | nothing |
| At-least-once | after processing | never | possible | be idempotent |
| Exactly-once | transactional / dedup | never | never (effectively) | dedup or commit-with-effect atomically |

## Code example

This models the log side: an append-only partition where reads never
consume, plus per-group committed offsets and hash-based key routing. The
core lesson is that reading advances a cursor rather than removing data, so
two groups read the same log independently, and retention trims the oldest
records regardless of who has read them.

```rust
use std::collections::HashMap;

// A single partition is an append-only log: messages are never removed on
// read, only trimmed by retention. Consumers track their own offset, so
// each consumer group reads the same log independently and can rewind.
pub struct Partition {
    log: Vec<String>,   // append-only; index == offset - base_offset
    base_offset: u64,   // offset of log[0] after retention trimming
}

impl Partition {
    pub fn new() -> Self {
        Partition { log: Vec::new(), base_offset: 0 }
    }

    // Producer append returns the assigned offset.
    pub fn append(&mut self, msg: String) -> u64 {
        let offset = self.base_offset + self.log.len() as u64;
        self.log.push(msg);
        offset
    }

    // Read up to `max` messages starting at `from`, returning the next
    // offset to fetch. Reading does not consume: the log is unchanged.
    pub fn read(&self, from: u64, max: usize) -> (Vec<&str>, u64) {
        let start = from.saturating_sub(self.base_offset) as usize;
        let start = start.min(self.log.len());
        let end = (start + max).min(self.log.len());
        let batch = self.log[start..end].iter().map(|s| s.as_str()).collect();
        (batch, self.base_offset + end as u64)
    }

    // Retention drops the oldest messages regardless of who has read them.
    pub fn trim_to(&mut self, keep_from: u64) {
        if keep_from <= self.base_offset {
            return;
        }
        let drop = (keep_from - self.base_offset).min(self.log.len() as u64) as usize;
        self.log.drain(..drop);
        self.base_offset += drop as u64;
    }
}

// A consumer group commits the next-to-read offset per partition. Two
// groups on the same topic hold independent committed offsets, which is
// what lets them consume at different speeds off one shared log.
#[derive(Default)]
pub struct GroupOffsets {
    committed: HashMap<u32, u64>, // partition id -> next offset
}

impl GroupOffsets {
    // At-least-once: commit only AFTER the batch is processed. A crash
    // between processing and commit re-delivers the batch, so consumers
    // must be idempotent.
    pub fn commit(&mut self, partition: u32, next_offset: u64) {
        self.committed.insert(partition, next_offset);
    }

    pub fn position(&self, partition: u32) -> u64 {
        *self.committed.get(&partition).unwrap_or(&0)
    }
}

// Route a keyed message to a partition by hashing the key, so all messages
// sharing a key land on one partition and keep their relative order.
pub fn partition_for(key: &str, partition_count: u32) -> u32 {
    let mut h: u64 = 14695981039346656037; // FNV-1a offset basis
    for b in key.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(1099511628211);
    }
    (h % partition_count as u64) as u32
}
```

## When to use it

- Multiple independent consumer groups need to read the same stream of
  events at their own pace, or need to replay history (log model).
- Producers and consumers must be decoupled so that a slow, offline, or
  restarting consumer never blocks or slows the producer.
- Ordering matters for related events and can be satisfied by partitioning
  on a suitable key.
- Consumer throughput needs to scale by adding processes without changing
  the producer.

## When not to use it

- A simple work queue where each task is processed once by one worker and
  then discarded is all that's needed — a point-to-point broker (or
  [competing consumers](/docs/patterns/batch-streaming/competing-consumers))
  is simpler to operate than a partitioned log.
- Retention and replay of the full history add no value and would only add
  storage cost.
- A synchronous request/response with an immediate answer is what the caller
  actually needs — a queue adds latency and complexity for no benefit there.

## Use-case scenarios

**Order events feeding many pipelines.** An e-commerce checkout appends an
`order-placed` event to a Kafka topic keyed by order id. Independent consumer
groups — payments, inventory, fulfilment, analytics — each read the same log
at their own pace. Payments processes with at-least-once delivery and dedups
on order id; analytics can rewind and reprocess a week of history after a bug
fix without touching the other pipelines. Per-key partitioning keeps all
events for one order in order.

**Background job intake.** A SaaS app pushes thumbnail-generation and email
tasks onto an SQS-style broker queue. A pool of stateless workers competes
for messages; each is delivered once, processed, and deleted. Scaling is
just "run more workers." A message that fails its retry budget lands in a
dead-letter queue for a human to inspect, so one malformed job never wedges
the pipeline.

**Cross-service event backbone.** A microservices platform runs Kafka as a
durable event bus. Services publish domain events and subscribe to the ones
they care about, decoupled in time and identity. Because the log is durable
and replayable, a newly deployed service can bootstrap its state by replaying
history from offset zero — turning the queue into both a transport and a
short-term source of truth.

## Production libraries & getting started

The two dominant brokers are Kafka (partitioned log) and RabbitMQ (AMQP broker); each has clients across languages, plus lighter options like NATS.

| Library / Tool | Language / Role | What it gives you | Getting started |
| --- | --- | --- | --- |
| Apache Kafka | Server | Partitioned durable commit log | [Quickstart](https://kafka.apache.org/quickstart) |
| kafkajs | JS/TS (Kafka) | Pure-JS Kafka client | [Getting started](https://kafka.js.org/docs/getting-started) |
| rdkafka | Rust (Kafka) | librdkafka-based client | [docs.rs/rdkafka](https://docs.rs/rdkafka/latest/rdkafka/) |
| franz-go | Go (Kafka) | Full-featured pure-Go Kafka client | [franz-go](https://github.com/twmb/franz-go) |
| confluent-kafka-python | Python (Kafka) | librdkafka-based client | [confluent-kafka-python](https://github.com/confluentinc/confluent-kafka-python) |
| RabbitMQ | Server | AMQP broker with flexible routing | [Tutorials](https://www.rabbitmq.com/tutorials) |
| amqplib | JS/TS (AMQP) | RabbitMQ/AMQP 0-9-1 client | [amqplib](https://github.com/amqp-node/amqplib) |
| lapin | Rust (AMQP) | Async AMQP client | [docs.rs/lapin](https://docs.rs/lapin/latest/lapin/) |
| amqp091-go | Go (AMQP) | Maintained AMQP 0-9-1 client | [amqp091-go](https://pkg.go.dev/github.com/rabbitmq/amqp091-go) |
| pika | Python (AMQP) | Pure-Python AMQP client | [pika docs](https://pika.readthedocs.io/en/stable/) |
| NATS | Server | Lightweight pub/sub and JetStream | [What is NATS](https://docs.nats.io/nats-concepts/what-is-nats) |
| Redpanda | Server | Kafka-API-compatible broker | [Quick start](https://docs.redpanda.com/current/get-started/quick-start/) |

## Related patterns

- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) — the consumer-group-per-partition scaling model of the log design.
- [Competing Consumers](/docs/patterns/batch-streaming/competing-consumers) — the broker design's scaling story, where workers race for messages off one queue.
- [Pub-Sub](/docs/patterns/communication/pub-sub) — the fan-out messaging shape a log implements durably via consumer groups.
- [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) — how consumers turn at-least-once delivery into effectively-once processing.
- [Dead-Letter Queue](/docs/patterns/reliability/dead-letter-queue) — where poison messages go after exhausting redelivery, so they don't block the stream.
- [Backpressure](/docs/patterns/batch-streaming/backpressure) and [Queue-Based Load Leveling](/docs/patterns/batch-streaming/queue-based-load-leveling) — how a queue absorbs bursts and lets consumers pull at a sustainable rate.
- [Idempotency](/docs/patterns/reliability/idempotency) — the consumer-side property that makes at-least-once delivery safe.

## Visual references

- [Diagram of a topic split into partitions with per-partition offsets — Apache Kafka documentation](https://kafka.apache.org/documentation/#intro_topics) — © Apache Kafka

## Further reading

- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
- [Apache Kafka documentation: design](https://kafka.apache.org/documentation/#design)
- [RabbitMQ: AMQP 0-9-1 model explained](https://www.rabbitmq.com/tutorials/amqp-concepts.html)
- [Amazon SQS developer guide](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/welcome.html)
- [Queue-based load leveling — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling)
