---
title: "Consistent Hashing"
sidebar_position: 2
supplementary: true
---

Consistent hashing is a technique for mapping keys to nodes on a hash
ring such that adding or removing a node only remaps the keys that were
adjacent to it, instead of reshuffling nearly the entire keyspace.

## Problem it solves

The naive way to spread keys across `N` nodes is `hash(key) % N`. That
works fine until `N` changes: adding or removing even one node changes
the modulus, which changes the owning node for almost every key in the
system. In a sharded database or a distributed cache, that means a
single scaling event triggers a massive, expensive data migration and a
storm of cache misses. Consistent hashing exists specifically to make
that migration proportional to the size of the change, not the size of
the dataset.

## How it works

Both nodes and keys are hashed onto the same fixed circular space (a
"ring"), typically using a hash function like MD5 or SHA-1 truncated to
a fixed number of bits. A key belongs to the first node found walking
clockwise from the key's position on the ring. When a node is added, it
only takes ownership of the slice of the ring between itself and the
next node counter-clockwise — every other node's ownership is
unaffected. When a node is removed, only its slice of keys falls over to
the next node clockwise.

A naive single-point-per-node ring can still produce uneven load,
since one node might end up owning a disproportionately large arc,
especially with few nodes. The standard fix is virtual nodes: each
physical node is hashed onto the ring at many points (e.g. 100–200
"virtual" positions), so its total share of the ring is an average over
many small arcs rather than one large one, smoothing out load across
nodes even when node count is small or nodes join/leave frequently.

## When to use it

- You need to add or remove nodes from a sharded store or distributed
  cache without triggering a full, dataset-wide rebalance.
- Node membership changes somewhat frequently (autoscaling, node
  failures) and minimizing data movement on each change matters.
- You're building a partitioning scheme for a distributed hash table,
  cache cluster, or storage system from scratch.

## When not to use it

- The number of nodes is fixed and essentially never changes — plain
  `hash(key) % N` is simpler and has no downside if `N` never moves.
- You need centralized control over exactly which node owns which key
  range (e.g. for compliance or manual load balancing) — a static
  lookup/range table is more explicit than a hash ring.
- Virtual nodes and ring maintenance add real implementation complexity
  that isn't worth it for a small, rarely-changing cluster.

## Real-world example

Amazon DynamoDB's original design (described in the 2007 Dynamo paper)
and Apache Cassandra both use consistent hashing with virtual nodes as
their core partitioning scheme, letting both systems add or remove
storage nodes with only a fraction of the keyspace moving.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — consistent hashing is
  the standard algorithm for assigning keys to shards in a way that
  survives shard count changes.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache)
  — cache clusters use the same ring technique to route keys to cache
  nodes and minimize cache-miss storms when nodes scale.

## Further reading

- [Consistent hashing — Wikipedia](https://en.wikipedia.org/wiki/Consistent_hashing)
- [Dynamo (storage system) — Wikipedia](https://en.wikipedia.org/wiki/Dynamo_(storage_system))
