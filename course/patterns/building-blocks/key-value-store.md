---
title: "Key-Value Store"
sidebar_position: 1
supplementary: true
---

A key-value store is a database that exposes only `get`, `put`, and
`delete` operations addressed by a unique key, with no query language,
schema, or relationships over the stored value — trading the
expressiveness of relational queries for simplicity, predictable
low-latency lookups, and near-linear horizontal scalability.

![Key-Value Store diagram](/img/patterns/key-value-store.svg)

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

## Technical architecture & implementation

**The interface and data model.** Values are opaque to the store —
raw bytes, a serialized object, or a JSON document — addressed by a
single primary key, with no schema enforced on the contents. The API is
deliberately minimal: `get(key)`, `put(key, value)`, `delete(key)`, and
sometimes ordered range scans if keys are stored sorted. This narrow
contract is precisely what buys the scalability: because the store
never has to reason about the *shape* of a value, it can treat every
key independently, and independent keys partition cleanly.

**On-node storage engine — hash index vs LSM-tree vs B-tree.** How a
single node stores its slice of the keyspace is the first major design
lever. A **hash index** (Redis's in-memory dictionary, `bitcask`-style
stores) gives O(1) point lookups but no ordering and no efficient range
scans. A **B-tree** (the engine behind most relational databases and
stores like BoltDB) keeps keys sorted for range scans and offers
read-optimized, update-in-place writes — but every write seeks to a
specific page, which hurts write throughput on spinning or
write-saturated media. An **LSM-tree** (log-structured merge-tree —
the engine in Cassandra, RocksDB, LevelDB, ScyllaDB) buffers writes in
an in-memory *memtable*, flushes it to an immutable sorted file
(*SSTable*) sequentially, and merges files in the background via
*compaction*. That turns random writes into sequential ones — excellent
write throughput — at the cost of **write amplification** (data is
rewritten during compaction) and reads that may have to check several
SSTables (mitigated with per-file **Bloom filters**). Choosing the
engine is really choosing where on the read-amplification /
write-amplification / space-amplification triangle you want to sit.

**Partitioning across nodes.** Because there are no cross-key
relationships to preserve, the keyspace splits cleanly across nodes,
almost always via
[consistent hashing](/docs/patterns/storage/consistent-hashing): each
key hashes to a point on a ring and is owned by the next node clockwise,
so adding or removing a node remaps only that node's share of keys
instead of the whole keyspace. **Virtual nodes** (many ring positions
per physical node) keep that share even and let a more powerful machine
carry proportionally more of the ring. The failure mode to design
around is a **hot partition** — a single key or narrow key range taking
a disproportionate share of traffic; salting the key or fronting the
store with a cache (see below) is the usual remedy.

**Replication and consistency — Dynamo-style quorums.** For durability
and availability, each key is stored on N nodes. Amazon's Dynamo paper
popularized **tunable quorum consistency**: a read is served from R
replicas and a write acknowledged by W replicas, and when `R + W > N`
every read is guaranteed to observe the latest acknowledged write
(read-your-writes), while `R + W <= N` favors availability and lower
latency at the cost of possibly-stale reads. Concurrent writes to the
same key create conflicting versions, reconciled with
[vector clocks](/docs/patterns/consistency/vector-clocks) or
last-writer-wins timestamps. This is the CAP tradeoff made concrete: a
quorum store like Cassandra or Riak leans AP (stays writable during a
partition, reconciles later), while a store built on a consensus log
leans CP (rejects writes it can't safely commit).

**Where it sits among siblings.** A key-value store is the storage
substrate several other building blocks specialize. A
[distributed cache](/docs/patterns/building-blocks/distributed-cache) is
essentially a key-value store tuned for volatile, TTL'd, best-effort
data rather than a durable system of record. A
[blob store](/docs/patterns/building-blocks/blob-store) is a key-value
store specialized for large, immutable byte payloads. And
[sharding](/docs/patterns/storage/sharding) is the general partitioning
discipline that a key-value store applies in its simplest possible form,
free of the cross-shard join problem that makes sharding a *relational*
database hard.

## Code example

The core mechanism a key-value store relies on to scale is placing keys
onto nodes so that membership changes move as few keys as possible. This
consistent-hashing ring does exactly that — the test confirms adding a
fourth node to a three-node cluster remaps only about a quarter of keys,
not all of them.

```rust
use std::collections::BTreeMap;

pub struct HashRing {
    ring: BTreeMap<u64, String>, // ring position -> physical node id
    vnodes_per_node: u32,
}

fn hash(s: &str) -> u64 {
    // FNV-1a, then a splitmix64 finalizer for avalanche: FNV alone clusters
    // badly on short, similar strings like "node#0", "node#1".
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h = (h ^ (h >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    h = (h ^ (h >> 27)).wrapping_mul(0x94d049bb133111eb);
    h ^ (h >> 31)
}

impl HashRing {
    pub fn new(vnodes_per_node: u32) -> Self {
        HashRing { ring: BTreeMap::new(), vnodes_per_node }
    }

    // Each physical node is placed at many positions ("virtual nodes") so its
    // key share is spread evenly around the ring rather than one big arc.
    pub fn add_node(&mut self, node: &str) {
        for v in 0..self.vnodes_per_node {
            self.ring.insert(hash(&format!("{node}#{v}")), node.to_string());
        }
    }

    pub fn remove_node(&mut self, node: &str) {
        for v in 0..self.vnodes_per_node {
            self.ring.remove(&hash(&format!("{node}#{v}")));
        }
    }

    // Owner = first vnode clockwise from the key's position, wrapping to the
    // smallest position if the key hashes past the last vnode on the ring.
    pub fn owner(&self, key: &str) -> Option<&str> {
        if self.ring.is_empty() {
            return None;
        }
        let pos = hash(key);
        self.ring
            .range(pos..)
            .next()
            .or_else(|| self.ring.iter().next())
            .map(|(_, node)| node.as_str())
    }
}
```

## When to use it

- Access is always by exact key — no need to query, filter, or join on
  the value's contents.
- You need predictable, low-latency point lookups at very high
  throughput and horizontal scale (sessions, caches, feature flags,
  user profiles keyed by ID).
- The schema is naturally heterogeneous or evolves per-item, and
  forcing a relational schema would mean constant migrations.
- The workload is write-heavy and an LSM-based engine's sequential-write
  advantage is worth its compaction and read-amplification cost.

## When not to use it

- The application needs to query or filter by anything other than the
  primary key — a key-value store can't do that without you maintaining
  a separate secondary index (often a
  [distributed search](/docs/patterns/building-blocks/distributed-search)
  index) alongside it.
- Multi-key transactions or joins across entities are core to the
  domain — relational databases exist specifically for this.
- Strong, general-purpose consistency and ad-hoc analytics matter more
  than raw lookup throughput.

## Use-case scenarios

**Session and cart storage for a global e-commerce site.** Every logged-in
request needs the user's session and cart fetched by a single key
(`session:<id>`, `cart:<user>`), millions of times a second, with
single-digit-millisecond latency. There are no cross-session queries, so
the data partitions perfectly by key across a consistent-hashing ring; a
Dynamo-style store (DynamoDB, Cassandra) with `R + W > N` on the cart
gives read-your-writes so a user never sees an item vanish after adding
it.

**Feature-flag and configuration service.** A platform team stores each
flag as `flag:<name> -> {enabled, rollout%, targeting}` and every
service reads flags by exact name on startup and on a refresh interval.
The values are heterogeneous and evolve constantly, so a rigid
relational schema would mean endless migrations; a schemaless key-value
store absorbs new flag shapes with zero DDL, and the read-mostly pattern
is trivially cached in-process.

**Time-series and event ingestion at write scale.** A telemetry pipeline
writes billions of `(<device>:<timestamp>) -> reading` points per day
and reads them back mostly as key ranges per device over a time window.
An LSM-based ordered store (Cassandra, RocksDB, ScyllaDB) turns that
firehose of writes into sequential SSTable flushes, and the sorted
keyspace makes per-device range scans a contiguous read rather than a
scatter — a workload a B-tree's update-in-place writes would struggle
to keep up with.

## Related patterns

- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  standard technique key-value stores use to distribute keys across
  nodes and rebalance with minimal data movement.
- [Sharding](/docs/patterns/storage/sharding) — the general
  partitioning discipline a key-value store applies in its simplest
  form, without the cross-shard join problem of a relational database.
- [Quorum](/docs/patterns/consistency/quorum) — the `R + W > N`
  read/write mechanism a replicated key-value store uses to tune the
  consistency–availability tradeoff per operation.
- [Vector Clocks](/docs/patterns/consistency/vector-clocks) — how a
  Dynamo-style store detects and reconciles concurrent conflicting
  writes to the same key.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  a key-value store specialized for volatile, TTL'd data that fronts the
  durable store to shield it from read load.
- [Database](/docs/concepts/database) — the primer's broader treatment
  of relational vs. NoSQL database tradeoffs.

## Further reading

- [Key–value database — Wikipedia](https://en.wikipedia.org/wiki/Key%E2%80%93value_database)
- [Dynamo: Amazon's Highly Available Key-value Store (2007 paper)](https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf)
- [Log Structured Merge Trees — Ben Stopford](https://www.benstopford.com/2015/02/14/log-structured-merge-trees/)
- [Apache Cassandra architecture — storage engine](https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html)
- [What is a key-value database? — AWS](https://aws.amazon.com/nosql/key-value/)
