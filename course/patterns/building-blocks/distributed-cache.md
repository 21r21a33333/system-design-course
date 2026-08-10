---
title: "Distributed Cache"
sidebar_position: 4
supplementary: true
---

A distributed cache spreads cached data across a cluster of nodes
instead of a single machine, so cache capacity and throughput can scale
past what one instance can hold or serve — at the cost of new problems
around routing, coherence, and uneven load that a single-node cache
never has to deal with.

## Problem it solves

The primer's [Cache](/docs/concepts/cache) page covers *when and how*
to update a cache — cache-aside, write-through, write-behind, TTLs. All
of that assumes a cache that fits on one node. Once the working set or
request rate outgrows a single machine's RAM and network capacity, the
cache itself has to become a cluster — and clustering introduces
problems that are specific to distributed systems, not to caching
strategy: how does a client know which node holds a given key, how do
you keep nodes' views of the same key consistent enough to be useful,
and what happens when one key gets far more traffic than the rest.
This page covers only that distributed-systems layer.

## How it works

**Cluster topology.** There are two common ways a client finds the
right node for a key. In client-side hashing, each client library
hashes the key itself (typically with [consistent
hashing](/docs/patterns/storage/consistent-hashing)) and talks directly
to the owning node — no extra hop, but every client needs an
up-to-date, consistent view of cluster membership. In proxy-based
routing, clients talk to a proxy layer that owns the hashing and
membership logic and forwards each request to the right node — simpler
clients, at the cost of an extra network hop and the proxy layer
itself needing to scale and stay available.

**Cache coherence.** Unlike a single-node cache, a cluster has multiple
places a piece of data could live: a value might be cached on node A
while the same logical entry is later written and invalidated only on
node B (for example, after a rehash following a membership change).
Most distributed caches sidestep true multi-node consistency by
ensuring each key lives on exactly one node at a time (via consistent
hashing) rather than replicating and synchronizing copies — trading
availability during a node failure (that node's keys are simply gone
from cache, not stale) for a much simpler coherence model. Systems that
do replicate cached values for availability have to decide, explicitly,
how much staleness across replicas is acceptable.

**The hot-key problem.** Hashing spreads keys evenly across nodes on
average, but request traffic is rarely uniform — a single celebrity
profile, a viral post, or a flash-sale product can send a
disproportionate share of all requests to the one key (and therefore
the one node) that holds it, overwhelming that node while the rest of
the cluster sits idle. Mitigations include replicating hot keys onto
multiple nodes and load-balancing reads across the copies, or adding a
small local (in-process) cache in front of the distributed cache so
repeated requests never even reach the cluster for the hottest items.

## When to use it

- The cached working set or request throughput exceeds what a single
  cache instance can hold or serve.
- Multiple application instances need a shared cache view rather than
  each maintaining its own inconsistent local cache.
- You can tolerate a key's cached value being unavailable (not stale)
  briefly after a node failure, in exchange for simplicity.

## When not to use it

- A single cache instance still comfortably handles the working set and
  load — a cluster adds routing and coherence complexity for no
  benefit yet.
- The application only needs a local, per-instance cache and different
  instances seeing slightly different data is fine.

## Real-world example

Redis Cluster shards the keyspace across nodes using a fixed set of
hash slots, with clients routing requests directly to the owning node.
Memcached has no built-in clustering; instead, client libraries
implement consistent hashing themselves to spread keys across a pool of
independent Memcached instances.

## Related patterns

- [Cache](/docs/concepts/cache) — the primer's treatment of caching
  strategies (cache-aside, write-through, write-behind, TTLs), which
  apply equally whether the cache is a single node or a cluster.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  standard technique for routing keys to cache nodes and minimizing
  cache-miss storms when the cluster scales.

## Further reading

- [Distributed cache — Wikipedia](https://en.wikipedia.org/wiki/Distributed_cache)
- [Caching best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
