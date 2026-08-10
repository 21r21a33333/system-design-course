---
title: "Exactly-Once Semantics"
sidebar_position: 5
supplementary: true
---

Exactly-once semantics is the guarantee that each message is processed
so that its effect is applied exactly one time — no duplicates, no
gaps — even in the presence of retries, consumer crashes, or network
failures.

## Problem it solves

Distributed message processing has to cope with partial failure: a
consumer might process a message and then crash before recording that
it did so, or a network blip might make a producer resend a message it
already sent. Left unhandled, this produces either duplicate processing
(the same order shipped twice) or lost messages (a payment silently
never applied). Exactly-once semantics names the strongest of the three
common delivery guarantees, giving downstream logic a single, simple
assumption to build on instead of needing to defensively handle
duplicates or gaps itself.

## How it works

It helps to place exactly-once alongside the two weaker guarantees it's
usually contrasted with. **At-most-once** delivery sends a message and
never retries, so failures just drop it — no duplicates, but messages
can be lost, and it's the easiest to implement. **At-least-once**
delivery retries until it gets confirmation, so a message is never
silently lost, but the same message can be delivered and processed more
than once if the confirmation itself is what got lost — this is the
easiest guarantee to provide reliably and is the default in most
messaging systems.

Exactly-once is not delivered by some special magic that prevents
duplicate delivery at the network level — duplicate delivery is
essentially unavoidable in a system with retries. Instead, it's
typically achieved by combining at-least-once delivery with one of two
mechanisms on the consumer side. The first is **idempotent processing**:
build the consumer so that processing the same message twice has the
same effect as processing it once (see [Idempotency](/docs/patterns/reliability/idempotency)), often by
recording processed message IDs and skipping ones already seen. The
second is **transactional writes coupled with offset commits**: the
consumer writes its output and records that it has consumed the message
(advances its offset) as a single atomic transaction, so a crash between
those two steps can never leave one done without the other.

## When to use it

- Financial transactions, inventory counts, or any aggregation where a
  duplicate or missed event directly corrupts a number that matters.
- Stream processing pipelines with multi-stage aggregation, where
  duplicate or dropped intermediate events would compound into a wrong
  final result.
- Any pipeline where the cost of building idempotent or transactional
  consumers is justified by how expensive a data-correctness bug would
  be.

## When not to use it

- Metrics, logs, or analytics events where an occasional duplicate or
  dropped record doesn't materially change the result — the extra
  complexity of transactional consumers isn't worth it, and
  at-least-once is simpler and cheaper.
- Latency-critical paths where the extra coordination (transactional
  commits, deduplication lookups) of exactly-once processing adds
  overhead that the use case can't afford.

## Real-world example

Kafka's transactional producer/consumer APIs and Kafka Streams'
exactly-once processing mode implement exactly-once by atomically
committing a consumer's output writes together with its consumed
offsets, so a failure and restart can't result in either a duplicate
write or a skipped one.

## Related patterns

- [Idempotency](/docs/patterns/reliability/idempotency) — the general technique that makes at-least-once delivery safe to treat as exactly-once from the consumer's point of view.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) — the consumption model whose per-partition offsets are what get committed transactionally.

## Further reading

- [Message queue § Delivery semantics — Wikipedia](https://en.wikipedia.org/wiki/Message_queue#Delivery_semantics)
- [Idempotence — Wikipedia](https://en.wikipedia.org/wiki/Idempotence)
