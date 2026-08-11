---
title: "Sharding"
sidebar_position: 1
supplementary: true
---

Sharding is the horizontal partitioning of a dataset across multiple
database instances (shards), where each shard holds a disjoint subset of
the rows selected by a shard key, so that no single machine has to store,
index, or serve the entire dataset — trading the simplicity of a single
node for capacity and write throughput that scale with the number of
shards.

![Sharding diagram](/img/patterns/sharding.svg)

## Problem it solves

A single database instance has a hard ceiling on storage, write
throughput, working-set memory, and connection count, no matter how much
you vertically scale it (bigger CPU, more RAM, faster disks). Read
replicas relieve *read* load but every replica still absorbs the full
*write* stream and stores the whole dataset, so they do nothing for write
throughput or total size. Once a dataset or its write rate outgrows what
one primary can handle, the only remaining lever is to split the data
across many machines that each own a fraction of it — and serve writes to
that fraction independently. That is sharding.

## Technical architecture & implementation

**Shard-key selection — the decision that dominates everything.** Every
row is assigned to a shard by a **shard key** (partition key). This one
choice determines load distribution, which queries stay single-shard, and
how painful rebalancing will be — and it is expensive to change later
because it dictates physical placement. A good key is high-cardinality
and evenly accessed (a random-ish user ID, tenant ID, order ID); a bad key
concentrates traffic (sharding by `signup_date` sends all *today's* writes
to one shard; sharding by `country` overloads the shard holding your
biggest market). The goal is that the key both **spreads load evenly** and
**co-locates the rows that are queried together**, and those two goals
sometimes conflict.

**Range vs hash vs directory sharding.** The routing function has three
common shapes, detailed in the table below. **Range** sharding assigns
contiguous key ranges to shards — great for range scans, prone to
hotspots on sequential keys. **Hash** sharding routes on
`hash(shard_key)` — excellent spread, but destroys locality so range
scans must fan out. **Directory** sharding keeps an explicit lookup table
from key (or a bucket of keys) to shard — maximum flexibility and the
cheapest rebalancing, at the cost of a lookup layer that must itself be
fast and highly available.

**Rebalancing and resharding.** Growth eventually demands more shards, and
moving keys online is the operationally hardest part. Naive
`hash(key) % N` remaps almost every key when `N` changes; the standard
mitigations are [consistent hashing](/docs/patterns/storage/consistent-hashing)
(a membership change moves only ~`K/N` keys) or a layer of *many* fixed
logical buckets mapped to physical shards through a directory, so a split
reassigns whole buckets without re-hashing individual keys. The code
example implements exactly this bucket-directory split.

**Hot shards and the celebrity problem.** Even a well-distributed key can
develop a **hot shard** when one value draws disproportionate traffic — a
celebrity user, a viral item, a whale tenant. The shard owning that key
saturates while the rest idle, and because it is a *single* key, you can't
just split the range to relieve it. Remedies are workload-specific:
splitting the celebrity's data across sub-keys (write-sharding, as
[sharded counters](/docs/patterns/building-blocks/sharded-counters) do),
fronting it with a [distributed cache](/docs/patterns/building-blocks/distributed-cache),
or giving the hot tenant a dedicated shard.

**Cross-shard queries, joins, and transactions — the hard part.** Sharding
breaks the single-engine guarantees that make relational databases
pleasant. A query that spans shards (a join across two entities, a global
aggregate, a `WHERE` that doesn't include the shard key) can no longer be
planned by one engine; it becomes a **scatter-gather** — fan the query to
every shard, gather and merge the partial results in a coordinator (the
same read-side shape as [distributed search](/docs/patterns/building-blocks/distributed-search)).
Its latency tracks the *slowest* shard, and a query missing the shard key
must hit *all* shards. A transaction spanning shards needs a distributed
commit protocol like [two-phase commit](/docs/patterns/consistency/two-phase-commit)
or a [saga](/docs/patterns/consistency/saga) — both far slower and more
failure-prone than a local transaction. The design imperative is therefore
to pick a shard key that keeps the overwhelming majority of queries
*single-shard*.

**Sharding vs its neighbors.** Sharding is **orthogonal to
[replication](/docs/patterns/storage/primary-replica-replication)**:
replication copies the *same* data to multiple nodes for availability and
read scale, sharding splits *different* data across nodes for write scale
and capacity — production systems do both (each shard is itself a
replicated primary/replica set). It differs from
[federation](/docs/patterns/storage/federation), which splits data by
*feature or function* (users DB, orders DB) rather than partitioning one
dataset by key. And it differs from
[partitioned consumption](/docs/patterns/batch-streaming/partitioned-consumption),
which partitions a *stream* so consumers process disjoint slices in
parallel — the same partition-by-key idea applied to messages in flight
rather than rows at rest.

## Range vs hash vs directory sharding

| | Range sharding | Hash sharding | Directory sharding |
| --- | --- | --- | --- |
| Routing | contiguous key ranges → shards | `hash(key)` → shard | explicit key/bucket → shard table |
| Range scans | efficient (contiguous) | scatter to all shards | depends on table layout |
| Hotspot risk | high on sequential keys | low (spread by hash) | low, and manually correctable |
| Rebalancing | split/merge ranges | remaps many keys unless consistent-hashed | cheapest — remap a table entry |
| Extra dependency | shard boundary metadata | none | a fast, HA lookup service |
| Best when | ordered/time-range queries dominate | point lookups, even spread wanted | placement must be flexible/controllable |

## Code example

A directory router over many fixed logical buckets. Decoupling logical
buckets from physical shards is what makes a split cheap: reassigning one
bucket moves only that bucket's keys and leaves every other key exactly
where it was. The router also tracks per-key request counts so it can flag
a **hot key** exceeding a multiple of the fair share.

```rust
use std::collections::HashMap;

fn hash(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h = (h ^ (h >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    h ^ (h >> 31)
}

pub struct Router {
    buckets: usize,
    placement: Vec<String>,   // logical bucket -> physical shard id
    load: HashMap<u64, u64>,  // per-key request counter for hot-key detection
}

impl Router {
    pub fn new(buckets: usize, initial_shard: &str) -> Self {
        Router {
            buckets,
            placement: vec![initial_shard.to_string(); buckets],
            load: HashMap::new(),
        }
    }

    fn bucket_of(&self, key: &str) -> usize {
        (hash(key) % self.buckets as u64) as usize
    }

    pub fn route(&mut self, key: &str) -> &str {
        *self.load.entry(hash(key)).or_insert(0) += 1;
        &self.placement[self.bucket_of(key)]
    }

    // Resharding-safe split: move one logical bucket to a new shard. Only the
    // keys in that bucket relocate; all other keys keep their current shard.
    pub fn split_bucket(&mut self, key_in_bucket: &str, new_shard: &str) {
        let b = self.bucket_of(key_in_bucket);
        self.placement[b] = new_shard.to_string();
    }

    // Keys whose traffic exceeds `factor` times the fair share are "hot".
    pub fn hot_keys(&self, factor: f64) -> usize {
        let total: u64 = self.load.values().sum();
        if total == 0 {
            return 0;
        }
        let fair = total as f64 / self.load.len() as f64;
        self.load.values().filter(|&&c| c as f64 > fair * factor).count()
    }
}

fn main() {
    let mut r = Router::new(1024, "shard-0");
    for i in 0..1000 {
        r.route(&format!("user-{i}"));
    }
    for _ in 0..5000 {
        r.route("user-celebrity"); // one hammered "celebrity" key
    }

    let before = r.route("user-42").to_string();
    r.split_bucket("user-42", "shard-1"); // split only user-42's bucket
    let after = r.route("user-42").to_string();

    println!("split moved user-42: {before} -> {after}");
    println!("hot keys (>10x fair share): {}", r.hot_keys(10.0));
}
```

The split reassigns exactly one bucket, so `user-42` moves from `shard-0`
to `shard-1` while every key outside that bucket is untouched, and the
load counters surface the single celebrity key that a naive even-hash
scheme would silently let overload its shard.

## When to use it

- A single primary can no longer hold the dataset or sustain the write
  throughput, even after vertical scaling and read replicas — you need to
  scale *writes* and *capacity*, which replication alone cannot do.
- The data has a natural, high-cardinality, evenly-accessed partition key
  (user ID, tenant ID, order ID) and the dominant queries filter by it, so
  most work stays single-shard.
- You can tolerate — or design away — the cross-shard join and transaction
  complexity that sharding introduces.

## When not to use it

- The dataset comfortably fits on one well-provisioned instance; sharding
  adds operational and query complexity for a problem you don't have yet.
- The workload is dominated by cross-entity joins, global aggregates, or
  multi-entity transactions with no shard key that keeps them local —
  sharding will push expensive scatter-gather and distributed-commit logic
  into the application.
- Simpler levers are unexhausted:
  [caching](/docs/patterns/building-blocks/distributed-cache), read
  replicas, or splitting by function
  ([federation](/docs/patterns/storage/federation)) may solve the actual
  bottleneck with far less complexity.

## Use-case scenarios

**Multi-tenant SaaS sharded by tenant.** A B2B platform shards by
`tenant_id` so each customer's data lives on one shard and nearly every
query (scoped to a tenant) stays single-shard. A whale tenant that
outgrows its shard is isolated onto a dedicated shard via the directory,
and cross-tenant analytics runs as an offline scatter-gather rather than
on the transactional path.

**Social graph sharded by user.** A social app shards profile, post, and
follower data by owning `user_id`, co-locating a user's own data so the
common "load my profile and posts" path hits one shard — the approach
Instagram used with logical Postgres schemas that could migrate between
hosts. The celebrity-account fan-out is handled specially (write-sharding
and heavy caching) so one superstar doesn't melt a shard.

**Time-series metrics sharded by hash of series ID.** A metrics store hash-
shards on the series identifier to spread the write firehose evenly and
avoid the hotspot that time-range (range) sharding would create on
"now." Point and per-series range reads route to a single shard; broad
cross-series rollups fan out and merge, accepting scatter-gather latency
for a workload that is overwhelmingly per-series writes.

## Related patterns

- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  standard technique for minimizing key movement when shards are added or
  removed.
- [Primary-Replica Replication](/docs/patterns/storage/primary-replica-replication) —
  orthogonal to sharding: each shard is typically itself a replicated
  primary/replica set for availability and read scale.
- [Federation](/docs/patterns/storage/federation) — splits data by
  feature/function rather than partitioning one dataset by key; often a
  simpler first step than sharding.
- [Partitioned Consumption](/docs/patterns/batch-streaming/partitioned-consumption) —
  the same partition-by-key idea applied to a message stream so consumers
  process disjoint slices in parallel.
- [Sharded Counters](/docs/patterns/building-blocks/sharded-counters) —
  write-sharding a single hot key across sub-keys, the standard remedy for
  the celebrity/hot-shard problem.
- [Two-Phase Commit](/docs/patterns/consistency/two-phase-commit) — the
  distributed-commit protocol a cross-shard transaction must fall back to.

## Further reading

- [Shard (database architecture) — Wikipedia](https://en.wikipedia.org/wiki/Shard_(database_architecture))
- [Partition (database) — Wikipedia](https://en.wikipedia.org/wiki/Partition_(database))
- [Sharding pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sharding)
- [Consistent hashing — Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
