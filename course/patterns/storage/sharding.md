---
title: "Sharding"
sidebar_position: 1
supplementary: true
---

Sharding is the horizontal partitioning of a dataset across multiple
database instances (shards), where each shard holds a disjoint subset of
the rows, selected by a shard key, so no single machine has to store or
serve the entire dataset.

## Problem it solves

A single database instance has a ceiling on storage capacity, write
throughput, and connection count no matter how much you vertically scale
it (bigger CPU, more RAM, faster disks). Once a dataset or write load
outgrows what one machine — or one primary-replica set — can handle,
the only way to keep scaling is to split the data across many machines
that each handle a fraction of it.

## How it works

Every row is assigned to a shard based on a shard key (also called a
partition key), commonly via `hash(shard_key) % N` or a lookup/range
table mapping key ranges to shards. The application (or a routing layer
in front of the databases) uses the shard key on every query to figure
out which physical instance to talk to. Choosing the shard key well
matters enormously: a key that's evenly distributed across the keyspace
spreads load evenly, while a poorly chosen key — e.g. sharding by
signup date, or by a tenant ID where one tenant is far larger than the
rest — creates a hot shard that absorbs disproportionate traffic while
the others sit idle.

Two operational problems follow directly from this design. First,
rebalancing: adding or removing shards to handle growth means many keys
must move to new owning shards, which is expensive and risky to do
online (naive `mod N` hashing remaps almost every key when `N` changes;
see [Consistent Hashing](/docs/patterns/storage/consistent-hashing) for
the standard fix). Second, cross-shard operations: a query or
transaction that needs rows living on different shards (a join, an
aggregate, or a multi-row transaction) can't be satisfied by a single
database engine anymore — it requires scatter-gather queries from the
application layer or a distributed transaction protocol, both of which
are slower and more complex than the single-node equivalent.

## When to use it

- A single database instance can no longer hold the dataset or sustain
  the write throughput, even after vertical scaling and read replicas.
- Data has a natural, evenly-distributed partition key (user ID, tenant
  ID, geographic region) and most queries filter by that key.
- You need to scale write capacity, not just read capacity — replication
  alone only helps with reads.

## When not to use it

- The dataset comfortably fits on one well-provisioned instance —
  sharding adds significant operational and query complexity for no
  benefit yet.
- Your workload is dominated by cross-entity joins, aggregates, or
  transactions that don't align with any single shard key — sharding
  will force expensive scatter-gather logic into the application.
- You haven't exhausted simpler scaling levers first, such as
  [caching](/docs/patterns/building-blocks/distributed-cache) or read
  replicas, which solve many scaling problems with far less complexity.

## Real-world example

Instagram's early Postgres architecture famously sharded its database
by user ID, with each shard being a logical Postgres schema that could
be moved between physical hosts. Photo and follower data was co-located
by owning user ID so the vast majority of queries could be served from
a single shard.

## Related patterns

- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  standard technique for minimizing key movement when shards are added
  or removed.
- [Database](/docs/concepts/database) — the primer's broader treatment
  of database scaling techniques, including sharding.

## Further reading

- [Shard (database architecture) — Wikipedia](https://en.wikipedia.org/wiki/Shard_(database_architecture))
- [Sharding pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sharding)
