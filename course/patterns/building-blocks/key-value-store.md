---
title: "Key-Value Store"
sidebar_position: 1
supplementary: true
---

A key-value store is a database that exposes only `get`, `put`, and
`delete` operations addressed by a unique key, with no query language,
schema, or relationships over the stored value — trading the
expressiveness of relational queries for simplicity and horizontal
scalability.

## Problem it solves

Relational databases give you joins, secondary indexes, and ad-hoc
queries, but that flexibility comes at a cost: the engine has to
maintain those indexes and enforce schema and referential-integrity
rules on every write, and query planning adds latency and makes
horizontal partitioning hard (a join across shards is expensive). Many
workloads never need any of that — they only ever look up a value by
its exact key (a user session, a shopping cart, a feature flag, a
cached object). A key-value store drops everything the workload doesn't
need, which makes each node simpler, faster, and much easier to shard,
since there's no cross-shard join to worry about.

## How it works

Values are opaque blobs to the store — usually raw bytes, a serialized
object, or JSON — addressed by a single primary key with no schema
enforced on the value's contents. The interface is minimal: `get(key)`,
`put(key, value)`, `delete(key)`, and sometimes range operations if
keys are stored in sorted order. Under the hood, most implementations
use one of two structures: a hash table variant (O(1) point lookups,
no ordering) or a log-structured merge-tree / B-tree variant (supports
ordered range scans, at some write-amplification cost). Because there
are no cross-key relationships to maintain, the keyspace partitions
cleanly across nodes — typically via [consistent
hashing](/docs/patterns/storage/consistent-hashing) — and each node can
serve its slice of keys independently, with no coordination needed for
a given `get` or `put`.

## When to use it

- Access is always by exact key — no need to query, filter, or join on
  the value's contents.
- You need predictable, low-latency point lookups at very high
  throughput and horizontal scale (sessions, caches, feature flags,
  user profiles keyed by ID).
- The schema is naturally heterogeneous or evolves per-item, and
  forcing a relational schema would mean constant migrations.

## When not to use it

- The application needs to query or filter by anything other than the
  primary key — a key-value store can't do that without maintaining
  your own secondary index externally.
- Multi-key transactions or joins across entities are core to the
  domain — relational databases exist specifically for this.
- Strong, general-purpose consistency and ad-hoc analytics matter more
  than raw lookup throughput.

## Real-world example

Amazon DynamoDB is a fully managed key-value (and document) store built
on the ideas from Amazon's original Dynamo paper. Redis is frequently
used as an in-memory key-value store for caching and session data. Riak
is an open-source, Dynamo-inspired key-value store built for
high availability under network partitions.

## Related patterns

- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  standard technique key-value stores use to distribute keys across
  nodes and rebalance with minimal data movement.
- [Database](/docs/concepts/database) — the primer's broader treatment
  of relational vs. NoSQL database tradeoffs.

## Further reading

- [Key–value database — Wikipedia](https://en.wikipedia.org/wiki/Key%E2%80%93value_database)
- [What is a key-value database? — AWS](https://aws.amazon.com/nosql/key-value/)
