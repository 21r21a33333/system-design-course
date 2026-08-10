---
title: "Distributed Message Queue"
sidebar_position: 5
supplementary: true
---

A distributed message queue is a message broker that runs as a cluster
and, in its partitioned-log form, retains an ordered, replayable log of
messages per partition rather than deleting each message the moment a
single consumer reads it.

## Problem it solves

The primer's [Asynchronism](/docs/concepts/asynchronism) page already
covers *why* you'd decouple a producer from a consumer with a queue —
faster responses, background processing, back pressure. What it doesn't
cover is the architectural split between two genuinely different ways
of implementing "a queue" at scale: traditional point-to-point queues
versus Kafka-style partitioned logs, and the different delivery and
scaling tradeoffs each makes. That split is the focus here.

## How it works

**Point-to-point queues (SQS/RabbitMQ-style).** A message is delivered
to one consumer, that consumer processes it and acknowledges it, and
the message is then removed from the queue. Once acknowledged and
deleted, the message is gone — a new consumer can't replay history.
This model maps naturally onto competing-consumers: add more consumer
processes and the queue's messages are load-balanced across them,
with no coordination needed beyond the broker handing out one message
at a time.

**Partitioned logs (Kafka-style).** A topic is split into partitions,
and each partition is an append-only, ordered log — messages aren't
deleted on read, only after a retention period (time- or size-based)
regardless of whether they've been consumed. Because the log persists,
multiple independent consumer groups can each read the same topic at
their own pace, and a consumer can rewind and replay from an earlier
offset. Ordering is guaranteed only within a partition, not across the
whole topic — so producers that need related messages processed in
order (e.g. all events for one user) must route them to the same
partition, typically by hashing a partition key.

**Delivery guarantees.** Both models offer a spectrum: at-most-once
(a message might be lost but is never redelivered), at-least-once (a
message is never lost but might be delivered more than once, requiring
idempotent consumers), and exactly-once (harder to achieve end-to-end,
usually implemented via deduplication or transactional writes on the
consumer side). Which level is available and how it's configured
differs by broker, but the tradeoff — durability and no-duplication
pull against each other, and something has to give unless the consumer
does extra work — is universal.

**Consumer-group scaling.** In the partitioned-log model, a consumer
group is a set of consumer processes that split a topic's partitions
between them so each partition is read by exactly one consumer in the
group at a time; adding consumers up to the partition count increases
parallelism, and losing a consumer triggers a rebalance that reassigns
its partitions to the survivors. This is why the number of partitions
sets a hard ceiling on a single consumer group's read parallelism for a
topic — more partitions must be provisioned upfront to allow scaling
consumers further later.

## When to use it

- Multiple independent consumer groups need to read the same stream of
  events at their own pace, or need to replay history.
- Ordering matters for related events, and can be satisfied by
  partitioning on a suitable key.
- Consumer throughput needs to scale by adding processes without
  changing the producer.

## When not to use it

- A simple work queue where each task is processed once by one worker
  and then discarded is all that's needed — a point-to-point queue is
  simpler to operate than a partitioned log.
- Retention and replay of the full message history isn't valuable and
  would just add storage cost.

## Real-world example

Apache Kafka popularized the partitioned-log model described here,
using partitions and consumer groups as described above. Amazon SQS is
a widely used point-to-point queue where each message is delivered to,
processed by, and deleted by a single consumer.

## Related patterns

- [Asynchronism](/docs/concepts/asynchronism) — the primer's
  conceptual treatment of message and task queues.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) — the consumer-group-per-partition scaling model described above.

## Further reading

- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
- [Queue-based load leveling pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/queue-based-load-leveling)
