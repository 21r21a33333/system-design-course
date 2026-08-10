---
title: "Change Data Capture"
sidebar_position: 4
supplementary: true
---

Change Data Capture (CDC) is a technique for capturing row-level insert,
update, and delete events directly from a database's own transaction or
write-ahead log and streaming them out as they happen, instead of
periodically querying the database for what changed.

## Problem it solves

A common way to notice database changes is polling: run a query every N
seconds for rows with `updated_at > last_check`. Polling forces a
tradeoff between load and staleness — poll frequently and you add
constant query load to the database (and still miss deletes, which
leave no updated row to find); poll infrequently and downstream systems
lag behind by however long the interval is. CDC sidesteps the tradeoff
entirely by reading the change events the database already produces
internally for its own crash recovery and replication, rather than
asking the database to compute "what's new" on demand.

## How it works

Databases like PostgreSQL and MySQL maintain a [write-ahead log](/docs/patterns/storage/write-ahead-log) (or
equivalent — MySQL's binary log) that records every mutation before it's
applied, so the database can recover or replicate from it. A CDC
connector attaches to this log — the same mechanism the database uses
for its own replication — and reads the stream of committed row changes
directly, decoding each into a structured event with the change type
(insert/update/delete), the affected row, and typically the before and
after values. Because it reads the log rather than the tables, CDC adds
negligible query load to the primary database and captures every
committed change, including deletes, in commit order — with no polling
interval to tune and no missed changes between polls.

## When to use it

- Keeping a search index, cache, or read-optimized replica in sync with
  a system-of-record database without adding polling load to it.
- Feeding a [stream processing](/docs/patterns/batch-streaming/stream-processing) pipeline or event-driven downstream
  system from an existing database that wasn't designed with an event
  stream in mind.
- Migrating data between databases or into a data warehouse with low
  end-to-end lag and without touching application code.

## When not to use it

- Simple, low-change-rate tables where a periodic batch export is
  already fast enough and CDC's operational complexity (running a
  connector, handling log retention and connector failover) isn't
  justified.
- Systems where the application can instead publish domain events
  directly at write time — CDC infers intent from row diffs after the
  fact, which is a weaker signal than an explicit event the application
  chose to emit.
- Databases or managed services that don't expose their transaction log
  for external consumption, where CDC isn't an option at all.

## Real-world example

Debezium is an open-source CDC connector that reads MySQL binlogs or
PostgreSQL write-ahead logs and publishes the resulting row-level change
events onto a message broker such as Kafka, letting downstream
consumers subscribe to database changes as a stream without querying
the source database directly.

## Related patterns

- [Write-Ahead Log](/docs/patterns/storage/write-ahead-log) — the underlying mechanism CDC reads from.
- [Stream Processing](/docs/patterns/batch-streaming/stream-processing) — the typical way captured change events are consumed and transformed downstream.

## Further reading

- [Change data capture — Wikipedia](https://en.wikipedia.org/wiki/Change_data_capture)
- [Write-ahead logging — Wikipedia](https://en.wikipedia.org/wiki/Write-ahead_logging)
