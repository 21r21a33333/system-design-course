---
title: "Exactly-Once Semantics"
sidebar_position: 5
supplementary: true
---

Exactly-once semantics is the guarantee that each message's *effect* is
applied exactly one time — no duplicates, no gaps — even in the presence
of retries, consumer crashes, or network failures. The subtlety, and the
whole point of this page, is that it is delivered not by preventing
duplicate delivery (usually impossible) but by making duplicate delivery
*harmless*, so the observable result is as if each message were processed
once.

![Exactly-Once Semantics diagram](/img/patterns/exactly-once-semantics.svg)

## Problem it solves

Distributed message processing has to cope with partial failure: a
consumer might process a message and then crash before recording that it
did so, or a network blip might make a producer resend a message it
already sent. Left unhandled, this produces either duplicate processing
(the same order shipped twice, a payment applied twice) or lost messages
(a payment silently never applied). For anything that mutates a number
that matters — a balance, an inventory count, a billing total — either
failure is a correctness bug. Exactly-once semantics names the strongest
of the three common delivery guarantees, giving downstream logic a single
simple assumption to build on instead of forcing every consumer to
defensively reason about duplicates and gaps on its own.

## Technical architecture & implementation

**The three delivery guarantees.** It helps to place exactly-once
alongside the two weaker guarantees it is contrasted with.
**At-most-once** sends and never retries, so failures just drop the
message — no duplicates, but messages can be lost; easiest to implement.
**At-least-once** retries until confirmed, so a message is never silently
lost, but the same message can be delivered and processed more than once
when the *confirmation* is what got lost — this is the easiest guarantee
to provide reliably and is the default in most messaging systems.

**Why "exactly once" is really "effectively once."** No mechanism
prevents duplicate *delivery* at the network level — with retries,
duplicate arrival is essentially unavoidable, because the sender can
never distinguish "message lost" from "acknowledgement lost." So
exactly-once is built *on top of* at-least-once delivery by making
reprocessing produce no additional effect. The honest framing is
**effectively-once end to end**: duplicates still arrive, but the
*state change* each message causes lands exactly once. Everything below
is a way to achieve that.

**Idempotent writes.** Design the effect so applying it twice equals
applying it once (see [Idempotency](/docs/patterns/reliability/idempotency)).
`SET balance = 500` is naturally idempotent; `balance = balance + 100` is
not and needs help. The general technique is an **idempotency key** or
stable **message id**: record processed ids and skip any already seen, or
use a conditional write (insert-if-absent, compare-and-set) that a
replayed message no-ops against. This is the cheapest path when the sink
supports it.

**Idempotent producers.** The dedup can start upstream. An **idempotent
producer** (Kafka assigns each producer a PID and a per-partition
sequence number) lets the broker detect and discard a producer's retried
duplicate, so a network retry on the *send* side doesn't create two log
entries. This removes one whole class of duplicates before any consumer
sees them.

**Transactional writes and atomic offset commits.** The strongest
mechanism couples the *output* and the *record of consumption* into one
atomic unit. A consumer writes its result **and** advances its source
offset (records "I have handled up to here") in a single transaction, so
a crash can never leave the output written but the offset un-advanced
(→ reprocess and duplicate) or the offset advanced but the output missing
(→ gap). Kafka's transactional API commits produced records and consumed
offsets together; the checkpoint in a
[stream processor](/docs/patterns/batch-streaming/stream-processing)
does the same thing, snapshotting operator state alongside the source
offsets it reflects.

**Two-phase commit across source and sink.** When the sink is an external
system (a database, another broker), atomicity spans two independent
systems, which is exactly the problem
[Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) solves.
Flink's two-phase-commit sink is the canonical pattern: on checkpoint the
sink *pre-commits* (writes to a staging area / opens a transaction), and
only when the checkpoint globally completes does it *commit*; a failure
before commit rolls the staged output back. This is what makes
end-to-end exactly-once possible when the output leaves the streaming
system entirely.

**Dedup windows and their cost.** Deduplication that remembers *every*
id forever is unbounded state. In practice consumers keep a **dedup
window** — a bounded set of recently-seen ids (last N minutes, or a
rolling set) — which assumes a duplicate arrives close in time to its
original. Choosing the window is a real trade-off: too short and a
delayed redelivery slips past as a "new" message; too long and the dedup
store grows large. The window bounds memory at the cost of a correctness
assumption about redelivery latency.

**Failure modes to name.** Committing the offset *before* the write
(→ lost message on crash) or *after* the write in a separate step
(→ duplicate on crash) are the two classic bugs atomic commit exists to
prevent. A non-idempotent sink behind at-least-once delivery silently
double-applies. And exactly-once is not free: transactional commits, the
dedup store, and two-phase coordination all add latency and throughput
cost, which is why at-least-once remains the sane default wherever
occasional duplicates are tolerable.

## The three delivery guarantees compared

| Guarantee | Duplicates? | Loss? | How achieved | Typical cost |
| --- | --- | --- | --- | --- |
| At-most-once | No | Possible | Send, never retry | Lowest |
| At-least-once | Possible | No | Retry until acked | Low (default) |
| Effectively-once | Neutralized | No | At-least-once + idempotence / transactional commit | Highest |

## Code example

A dedup-by-message-id consumer: at-least-once delivery (the same id may be
redelivered after a lost ack) made safe by skipping ids already applied.
The `seen` set is what a transactional consumer would commit *atomically*
with the sink write; here it neutralizes duplicate deliveries against a
running balance that must not double-apply.

```rust
use std::collections::HashSet;

pub struct DedupConsumer {
    seen: HashSet<String>,
    balance: i64, // the sink — a running total that must not double-apply
    applied: u64,
    skipped: u64,
}

impl DedupConsumer {
    pub fn new() -> Self {
        DedupConsumer { seen: HashSet::new(), balance: 0, applied: 0, skipped: 0 }
    }

    // Returns true if this delivery caused a real state change, false if it
    // was a duplicate that was safely ignored.
    pub fn process(&mut self, message_id: &str, delta: i64) -> bool {
        // insert() returns false if the id was already present.
        if !self.seen.insert(message_id.to_string()) {
            self.skipped += 1;
            return false;
        }
        self.balance += delta;
        self.applied += 1;
        true
    }

    pub fn balance(&self) -> i64 {
        self.balance
    }
    pub fn applied(&self) -> u64 {
        self.applied
    }
    pub fn skipped(&self) -> u64 {
        self.skipped
    }
}
```

Verified behavior: feeding five deliveries in which `m1` and `m3` each
arrive twice, the balance reflects only the three *distinct* messages
(100 + 50 + 25 = 175), with `applied = 3` and `skipped = 2`. The
duplicate deliveries arrived and were counted as skips — they simply
produced no additional effect, which is exactly-once in practice.

## When to use it

- Financial transactions, inventory counts, or any aggregation where a
  duplicate or missed event directly corrupts a number that matters.
- Multi-stage stream pipelines where a duplicated or dropped intermediate
  event would compound into a wrong final result.
- Any pipeline where the cost of building idempotent or transactional
  consumers is justified by how expensive a data-correctness bug would be.

## When not to use it

- Metrics, logs, or analytics events where an occasional duplicate or
  dropped record doesn't materially change the result — the complexity of
  transactional consumers isn't worth it, and at-least-once is simpler
  and cheaper.
- Latency-critical paths where the extra coordination (transactional
  commits, dedup lookups, two-phase commit) adds overhead the use case
  can't afford, and downstream idempotence already makes duplicates
  harmless anyway.
- When the sink is *naturally* idempotent (a keyed upsert, a
  set-to-value write): plain at-least-once already yields effectively-once
  for free, and adding transactional machinery is redundant.

## Use-case scenarios

**Ledger and payments processing.** A payments service consumes a stream
of transfer events and updates account balances. Each event carries a
stable transfer id; the consumer applies the balance change and records
the id in the same database transaction, so a crash-and-replay finds the
id already present and no-ops. A double-charged customer is a
correctness incident, so the transactional cost is unquestionably worth
it here.

**Kafka Streams exactly-once aggregation.** A pipeline computes rolling
per-merchant revenue by consuming, aggregating, and re-publishing to an
output topic. Run in exactly-once mode, each micro-batch atomically
commits the produced output *and* the consumed input offsets together, so
a rebalance or restart mid-batch never double-counts a transaction into
the aggregate or skips one.

**Idempotent webhook receiver.** A SaaS platform delivers webhooks
at-least-once and will redeliver on any non-2xx or timeout. The receiver
treats the provider's event id as an idempotency key, recording handled
ids in a dedup window sized to the provider's redelivery policy; a
redelivered webhook is acknowledged but its side effect runs only once,
turning an at-least-once feed into effectively-once processing without
any distributed transaction.

## Production libraries & getting started

The strongest end-to-end exactly-once support lives in the Kafka and Flink ecosystems, built from idempotent producers, transactions, and checkpoint-aligned sinks.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Kafka transactions / EOS | JVM | Idempotent producer (PID + sequence) plus transactional produce-and-commit-offsets | [Confluent EOS explainer](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/) |
| Kafka delivery semantics | JVM | Reference for the transactional protocol, idempotent producer, and read-committed isolation | [Kafka message delivery guarantees](https://docs.confluent.io/kafka/design/delivery-semantics.html) |
| Kafka Streams EOS | JVM | `processing.guarantee=exactly_once_v2` — atomic input offset + output commit | [Streams processing guarantee](https://kafka.apache.org/documentation/streams/core-concepts#streams_processing_guarantee) |
| Flink checkpointing + 2PC sink | JVM | State snapshots aligned with source offsets; two-phase-commit sinks for external systems | [End-to-end exactly-once in Flink](https://flink.apache.org/2018/02/28/an-overview-of-end-to-end-exactly-once-processing-in-apache-flink-with-apache-kafka-too/) |
| Flink stateful processing | JVM | The checkpoint/state model underneath exactly-once | [Stateful stream processing](https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/stateful-stream-processing/) |

**Example / reference:** [An Overview of End-to-End Exactly-Once Processing in Apache Flink](https://flink.apache.org/2018/02/28/an-overview-of-end-to-end-exactly-once-processing-in-apache-flink-with-apache-kafka-too/)

## Related patterns

- [Idempotency](/docs/patterns/reliability/idempotency) — the general
  technique that makes at-least-once delivery safe to treat as
  exactly-once from the consumer's point of view; the foundation of this
  pattern.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — how
  an atomic commit spans a source and an external sink, the basis of a
  transactional exactly-once sink.
- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) —
  its checkpoints *are* the atomic offset-plus-output commit that delivers
  end-to-end exactly-once in streaming engines.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption)
  — the per-partition offsets that get committed transactionally alongside
  output.
- [Dead Letter Queue](/docs/patterns/reliability/dead-letter-queue) —
  where a message that repeatedly fails processing goes, so retries toward
  exactly-once don't loop forever on a poison message.

## Further reading

- [Message queue § Delivery semantics — Wikipedia](https://en.wikipedia.org/wiki/Message_queue#Delivery_semantics)
- [Idempotence — Wikipedia](https://en.wikipedia.org/wiki/Idempotence)
- [Exactly-Once Semantics Are Possible: Here's How Kafka Does It — Confluent](https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/)
- [An Overview of End-to-End Exactly-Once Processing in Apache Flink — Apache Flink blog](https://flink.apache.org/2018/02/28/an-overview-of-end-to-end-exactly-once-processing-in-apache-flink-with-apache-kafka-too/)
- [Fault Tolerance via State Snapshots — Apache Flink documentation](https://nightlies.apache.org/flink/flink-docs-stable/docs/learn-flink/fault_tolerance/)
