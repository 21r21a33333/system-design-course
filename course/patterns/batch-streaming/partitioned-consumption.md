---
title: "Partitioned Consumption"
sidebar_position: 7
supplementary: true
---

Partitioned consumption splits a stream or topic into multiple
partitions, each consumed by exactly one consumer within a given
consumer group at a time, so consumption can scale horizontally while
still preserving the order of events within each partition.

## Problem it solves

A single consumer reading a stream is limited to that one process's
throughput — it becomes the bottleneck as event volume grows, no matter
how the producers scale. The obvious fix, running many consumers
against the same stream, immediately raises a harder problem: if
several consumers can pick up any event, what stops two of them from
processing the same event, or processing events for the same entity
(the same user, the same order) out of order relative to each other?
Partitioned consumption gives a structured answer — parallelism across
partitions, but a single, ordered consumer per partition — instead of
leaving coordination between concurrent consumers as ad hoc.

## How it works

A stream is divided into a fixed number of partitions at write time,
usually by hashing a key (a user ID, an order ID) so that all events for
the same key always land in the same partition — the same technique
underlying [Consistent Hashing](/docs/patterns/storage/consistent-hashing) for assigning keys to nodes. Within a
single partition, events are strictly ordered, and the broker guarantees
they're delivered in that order. Consumers are organized into named
consumer groups; the broker assigns each partition to exactly one
consumer within a group, so that group's total read throughput scales by
adding more consumers, up to one consumer per partition — beyond that
point, additional consumers in the group sit idle since there are no
more partitions to hand them. Different consumer groups are fully
independent of each other, each with their own assignment and their own
read position, so multiple applications can each consume the whole
stream at their own pace without interfering with one another.

## When to use it

- High-throughput streams where a single consumer can't keep up, and
  parallel consumption is needed to scale horizontally.
- Workloads where ordering matters only within a logical entity (e.g.
  all events for one user must be processed in order) but not globally
  across all entities — partitioning by that entity's key gives
  per-entity order for free while still parallelizing across entities.
- Systems that need multiple independent consumer applications to each
  read the same stream at their own pace, via separate consumer groups.

## When not to use it

- Streams that require a single global ordering across all events,
  which partitioning inherently breaks — order is only guaranteed
  within a partition, not across the whole topic.
- Low-throughput streams where a single consumer is already fast enough
  — the operational complexity of partition and consumer-group
  management isn't worth it.
- Cases where the partitioning key is chosen poorly (e.g. a key with
  very uneven distribution) — a few "hot" partitions can bottleneck the
  whole consumer group even with many consumers running.

## Real-world example

Kafka's topic-partition and consumer-group model is the canonical
implementation of this pattern: a topic is split into partitions, each
partition is consumed by exactly one consumer instance within a
consumer group, and Kafka automatically rebalances partition assignment
across the group's consumers as instances join or leave.

## Related patterns

- [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) — relies on per-partition offsets, which only exist because of partitioned consumption.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — a related technique for mapping keys to a fixed or dynamic set of buckets, used in similar ways to assign events to partitions.

## Further reading

- [Message queue — Wikipedia](https://en.wikipedia.org/wiki/Message_queue)
- [Consistent hashing — Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
