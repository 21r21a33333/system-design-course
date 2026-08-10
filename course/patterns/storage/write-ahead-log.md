---
title: "Write-Ahead Log"
sidebar_position: 3
supplementary: true
---

A write-ahead log (WAL) is a durability technique where every mutation
is first appended to a sequential, append-only log on durable storage,
and only afterward applied to the actual in-memory or on-disk data
structure — so the log alone is enough to recover or replicate state.

## Problem it solves

In-memory data structures and even on-disk B-trees are fast to update
but vulnerable: if the process crashes or the machine loses power
mid-update, the data structure can be left partially written or
inconsistent, and any change that hadn't been flushed to disk is lost.
Flushing every single mutation directly into its final on-disk location
before acknowledging it would be durable, but random-access writes
scattered across a large data structure are slow. A WAL solves both
problems by separating "durably recorded" from "applied": once a change
is appended to the log, it's safe, even though the main data structure
hasn't been touched yet.

## How it works

Every write operation is first serialized and appended to the end of a
log file, and the write is only acknowledged as successful once that
log entry is durably flushed (fsynced) to disk. Because it's a pure
append to the end of a file, this is a sequential write — dramatically
faster than the random-access writes the underlying data structure would
otherwise require, since sequential I/O avoids disk seeks (and even on
SSDs, sequential writes have lower and more predictable latency). The
actual data structure (a B-tree, an in-memory table, a key-value store)
is updated afterward, often in batches, at the engine's convenience.

If the process crashes before that later update completes, recovery
replays the WAL from the last known-good checkpoint forward, reapplying
every logged mutation to reconstruct the correct state. The same replay
mechanism doubles as a replication primitive: a replica can stream the
primary's WAL and apply the same sequence of mutations to reach an
identical state, which is how many databases implement physical
replication.

## When to use it

- You need crash recovery guarantees for a data structure that would
  otherwise be too slow to fsync on every write.
- You're building or operating replication, since streaming a WAL is a
  simpler and more efficient replication mechanism than replaying
  application-level queries.
- Write throughput matters and the workload can tolerate a small window
  where "durable" (in the log) and "applied" (in the queryable
  structure) are momentarily out of sync.

## When not to use it

- The dataset is small enough, or non-critical enough, that simply
  writing directly to disk and accepting the small risk of loss on crash
  is acceptable — a WAL is extra machinery for a problem you don't have.
- You need every read to reflect every write instantly with no
  replication lag — WAL-based replication is typically asynchronous or
  near-synchronous, not lock-step.
- Storage space for the log itself, plus the operational overhead of log
  rotation, compaction, and checkpointing, isn't worth it for your
  scale.

## Real-world example

PostgreSQL writes every change to its write-ahead log before modifying
the actual heap/index pages, using it both for crash recovery and as the
basis for streaming replication to read replicas. Kafka takes the same
idea further: its entire storage engine is a WAL — each partition is
literally an append-only log, and "applying" a message just means a
consumer reads further along it.

## Related patterns

- [Event Sourcing](/docs/patterns/storage/event-sourcing) — takes the
  WAL idea a step further by making the append-only log itself the
  system of record, not just a durability mechanism underneath it.

## Further reading

- [Write-ahead logging — Wikipedia](https://en.wikipedia.org/wiki/Write-ahead_logging)
- [Apache Kafka — Wikipedia](https://en.wikipedia.org/wiki/Apache_Kafka)
