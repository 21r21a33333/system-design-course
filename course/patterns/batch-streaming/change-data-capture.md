---
title: "Change Data Capture"
sidebar_position: 4
supplementary: true
---

Change Data Capture (CDC) is a technique for capturing row-level insert,
update, and delete events directly from a database's own transaction or
write-ahead log and streaming them out as they happen, instead of
periodically querying the database for what changed.

![Change Data Capture diagram](/img/patterns/change-data-capture.svg)

## Problem it solves

A common way to notice database changes is polling: run a query every N
seconds for rows with `updated_at > last_check`. Polling forces a
tradeoff between load and staleness — poll frequently and you add
constant query load to the database (and still miss deletes, which
leave no updated row to find); poll infrequently and downstream systems
lag behind by however long the interval is. Polling also can't see
intermediate states: if a row is updated twice between polls, you see
only the final value, never the in-between one an event-driven consumer
might care about. CDC sidesteps all of this by reading the change events
the database already produces internally for its own crash recovery and
replication, rather than asking the database to compute "what's new" on
demand. Every committed change is captured, in commit order, with no
interval to tune and nothing missed between polls.

## Technical architecture & implementation

**Log-based capture.** Databases like PostgreSQL and MySQL maintain a
[write-ahead log](/docs/patterns/storage/write-ahead-log) (Postgres WAL,
MySQL's binlog, Oracle's redo log) that records every mutation before
it's applied, so the engine can recover after a crash and feed its own
replicas. A log-based CDC connector attaches to that log the same way a
replica would, decoding each committed change into a structured event
carrying the operation type, the primary key, and typically the row's
before and after images. Because it reads the log rather than the
tables, it adds negligible query load to the primary and observes
changes in exactly the order they were committed — the log's sequence
number (LSN) is a monotonic position that doubles as a resume point and
a deduplication key.

**Snapshot then stream.** A brand-new connector can't start from an
empty view; it first takes an initial **snapshot** of the current table
contents, then switches to tailing the log from the LSN captured at
snapshot time. Getting the handoff right — so no change is dropped or
double-counted at the boundary — is the subtle part of every CDC
implementation, and mature connectors like Debezium put real care into
it (consistent-snapshot isolation, watermarking the transition).

**Query-based and trigger-based alternatives.** Where the log isn't
reachable — a managed service that won't expose it, an engine without a
usable log reader — CDC falls back to **query-based** polling (the
`updated_at` scan, which can't see deletes or intermediate states) or
**trigger-based** capture (database triggers write every change into a
shadow audit table that a reader drains). Triggers catch deletes and run
inside the transaction, but they add write-path latency to every
mutation and are operationally invasive. The [table below](#log-based-vs-query-based-vs-trigger-based)
lays out the tradeoffs.

**Delivery semantics and idempotent consumers.** CDC pipelines almost
always guarantee *at-least-once* delivery, not exactly-once: after a
connector crash and restart, it resumes from the last committed LSN and
may re-emit a handful of already-delivered events. Consumers must
therefore be idempotent — the standard technique is to record the
highest LSN applied and skip anything at or below it, so a replay is a
no-op. This is the same discipline the
[idempotency](/docs/patterns/reliability/idempotency) and
[exactly-once semantics](/docs/patterns/batch-streaming/exactly-once-semantics)
pages describe, applied to a change stream.

**Schema changes.** Because events carry column data, a source
`ALTER TABLE` has to be threaded through the pipeline without breaking
consumers. Log-based connectors emit schema-change events inline in log
order so downstream deserializers can evolve in lockstep; a schema
registry with compatibility rules is the usual way to keep old and new
consumers reading the same stream.

**CDC vs. dual writes and the outbox.** The tempting alternative — have
the application write to the database *and* publish an event itself — is
the [dual-write problem](#the-outbox-pattern): the two writes aren't in
one transaction, so a crash between them leaves the database and the
event stream disagreeing. CDC dodges this entirely by deriving events
from the single committed database write, and the **transactional
outbox** (below) makes that derivation carry real domain intent instead
of raw row diffs.

## Log-based vs query-based vs trigger-based

| Aspect | Log-based | Query-based (polling) | Trigger-based |
| --- | --- | --- | --- |
| Source | WAL / binlog / redo log | `SELECT ... WHERE updated_at > x` | DB triggers → audit table |
| Load on primary | Negligible | Repeated query load | Added latency on every write |
| Captures deletes | Yes | No (row is gone) | Yes |
| Sees intermediate states | Yes | No (only latest) | Yes |
| Ordering | Exact commit order | Approximate (timestamp) | Commit order |
| Latency | Sub-second | Bounded by poll interval | Near real-time |
| Availability | Needs log access | Works anywhere | Works anywhere |

Log-based is the default when the log is reachable; the other two exist
for environments where it isn't.

## The outbox pattern

The transactional outbox turns a database write into a reliable event
without a distributed transaction. In the *same* local transaction that
mutates the business tables, the application inserts a row into an
`outbox` table describing the domain event it wants to publish. Because
both writes commit or roll back together, there is no window where one
happened and the other didn't — the dual-write problem is gone. A
separate **relay** (typically CDC tailing the log for inserts into
`outbox`) then reads those rows in commit order and publishes them to
the broker, marking or deleting them once forwarded. The payoff over
raw row-level CDC is intent: an `outbox` event says "OrderPlaced" with
exactly the fields consumers need, rather than making them reconstruct
meaning from a diff of the `orders` row. This is the standard bridge
from a database write to
[event-driven architecture](/docs/patterns/communication/event-driven-architecture)
and pairs naturally with
[event sourcing](/docs/patterns/storage/event-sourcing).

## Code example

The consumer side is where correctness lives: an ordered log of change
events applied to a derived view (a cache, a search index, a replica),
made idempotent by LSN so at-least-once redelivery is safe.

```rust
use std::collections::HashMap;

// A row-level change event as decoded from the transaction log. `lsn` is the
// log sequence number — the total order the database committed changes in.
enum Op {
    Insert { after: (u64, String) },
    Update { after: (u64, String) },
    Delete { pk: u64 },
}

struct ChangeEvent {
    lsn: u64,
    op: Op,
}

// A derived view (cache / search index) kept in sync from the log. It records
// the last LSN it applied so replayed or duplicated events are idempotent:
// applying the same log position twice is a no-op.
#[derive(Default)]
struct DerivedView {
    rows: HashMap<u64, String>,
    applied_through: u64,
}

impl DerivedView {
    fn apply(&mut self, event: &ChangeEvent) -> bool {
        // Idempotency by log position: skip anything at or below the
        // high-water mark. At-least-once delivery can redeliver; this
        // makes the redelivery safe.
        if event.lsn <= self.applied_through {
            return false;
        }
        match &event.op {
            Op::Insert { after } | Op::Update { after } => {
                self.rows.insert(after.0, after.1.clone());
            }
            Op::Delete { pk } => {
                self.rows.remove(pk);
            }
        }
        self.applied_through = event.lsn;
        true
    }
}
```

Applying the four events for keys 10 and 20 in LSN order leaves the view
holding the final value for row 10 and nothing for the deleted row 20;
re-feeding the identical log (a consumer restart) applies nothing new,
because every event's LSN is at or below `applied_through`. That single
`applied_through` check is what makes an at-least-once change stream
safe to consume.

## When to use it

- Keeping a search index, cache, or read-optimized replica in sync with
  a system-of-record database without adding polling load to it.
- Feeding a [stream processing](/docs/patterns/batch-streaming/stream-processing)
  pipeline or event-driven downstream system from an existing database
  that wasn't designed with an event stream in mind.
- Replicating into a data warehouse or another store with low
  end-to-end lag and without modifying application code.
- Implementing the outbox relay, so committed writes reliably become
  published domain events.

## When not to use it

- Simple, low-change-rate tables where a periodic batch export is
  already fast enough and CDC's operational cost (running a connector,
  managing log retention and connector failover) isn't justified.
- Systems where the application can instead publish explicit domain
  events at write time via an outbox — raw CDC infers intent from row
  diffs, a weaker signal than an event the application chose to emit.
- Databases or managed services that don't expose their transaction log,
  where log-based CDC isn't available and polling or triggers carry real
  downsides.

## Use-case scenarios

**Search index kept fresh from a product catalog.** A retailer's system
of record is a relational database; product search runs on a separate
[distributed search](/docs/patterns/building-blocks/distributed-search)
cluster. A log-based connector tails the database WAL and streams price,
stock, and description changes into the index within seconds of commit,
so the index is an eventually-consistent derived view with no polling
load on the catalog database and no dropped deletes when a product is
removed.

**Cache invalidation for a read-heavy service.** A service fronts its
database with a cache. Rather than the application remembering to
invalidate on every write path (easy to forget, and racy), a CDC
consumer watches the change stream and evicts or refreshes exactly the
cache keys whose rows changed — invalidation driven by what the database
actually committed, made idempotent by LSN so a redelivered event
doesn't cause spurious churn.

**Reliable event publishing via the outbox.** An order service must
publish an `OrderPlaced` event whenever it persists an order, with no
lost or phantom events. It writes the order and an `outbox` row in one
transaction; a CDC relay tails the log, forwards each `outbox` insert to
the broker in commit order, and marks it forwarded — turning a committed
database write into a durably published event without a distributed
transaction.

## Production libraries & getting started

Debezium is the de facto CDC standard; the rest cover lighter-weight or database-native paths.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| Debezium | JVM | Log-based CDC connectors for Postgres, MySQL, Mongo, SQL Server, Oracle | [Debezium tutorial](https://debezium.io/documentation/reference/stable/tutorial.html) |
| Kafka Connect | JVM | The connector runtime Debezium ships on; source/sink pipelines to Kafka | [Kafka Connect docs](https://kafka.apache.org/documentation/#connect) |
| Maxwell's Daemon | JVM | Reads the MySQL binlog and emits row changes as JSON | [Maxwell docs](https://maxwells-daemon.io/) |
| PostgreSQL logical decoding | SQL / C | Native change stream via replication slots (pgoutput / wal2json) | [Logical decoding docs](https://www.postgresql.org/docs/current/logicaldecoding.html) · [wal2json](https://github.com/eulerto/wal2json) |
| Sequin | Elixir | Postgres-native CDC to streams and queues with a managed runtime | [Sequin docs](https://sequinstream.com/docs) |
| Materialize source | SQL | Consume Postgres/MySQL CDC directly as a streaming SQL source | [CREATE SOURCE](https://materialize.com/docs/sql/create-source/) |

**Example / reference:** [The Transactional Outbox pattern — microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)

## Related patterns

- [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) — the
  underlying database mechanism log-based CDC reads from.
- [Event-Driven Architecture](/docs/patterns/communication/event-driven-architecture) —
  CDC (especially via the outbox) is a common way to turn database
  writes into the events such systems consume.
- [Event Sourcing](/docs/patterns/storage/event-sourcing) — an
  alternative where events are the source of truth from the start,
  rather than derived after the fact from row changes.
- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) —
  the typical way captured change events are transformed and consumed.
- [Idempotency](/docs/patterns/reliability/idempotency) and
  [Exactly-Once Semantics](/docs/patterns/batch-streaming/exactly-once-semantics) —
  the consumer discipline that makes an at-least-once change stream safe.
- [Distributed Search](/docs/patterns/building-blocks/distributed-search) —
  a frequent downstream consumer, kept in sync with its source database
  via CDC.

## Further reading

- [Change data capture — Wikipedia](https://en.wikipedia.org/wiki/Change_data_capture)
- [Debezium documentation](https://debezium.io/documentation/)
- [The Transactional Outbox pattern — microservices.io](https://microservices.io/patterns/data/transactional-outbox.html)
- [Using logical decoding for change data capture — PostgreSQL docs](https://www.postgresql.org/docs/current/logicaldecoding.html)
- [Turning the database inside-out — Martin Kleppmann](https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/)
