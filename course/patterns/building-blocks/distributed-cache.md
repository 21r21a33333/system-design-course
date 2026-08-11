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

![Distributed Cache diagram](/img/patterns/distributed-cache.svg)

## Problem it solves

The primer's [Cache](/docs/concepts/cache) page and the
[caching-strategies](/docs/patterns/caching/cache-aside) group cover
*when and how* to populate and invalidate a cache — cache-aside,
read-through, write-through, write-behind, TTLs. All of that assumes a
cache that fits on one node. Once the working set or request rate
outgrows a single machine's RAM and network capacity, the cache itself
has to become a cluster — and clustering introduces problems specific to
distributed systems, not to caching strategy: how does a client know
which node holds a given key, how do you keep nodes' views consistent
enough to be useful, and what happens when one key gets far more traffic
than the rest. This page covers that distributed-systems layer.

## Technical architecture & implementation

**Cluster topology — client-side vs proxy routing.** There are two
common ways a client finds the node for a key. In **client-side
hashing**, each client library hashes the key itself (typically with
[consistent hashing](/docs/patterns/storage/consistent-hashing)) and
talks directly to the owning node — no extra hop, but every client needs
an up-to-date, consistent view of cluster membership, which is its own
distributed-agreement problem. In **proxy-based routing**, clients talk
to a proxy layer (Twemproxy, a Redis Cluster-aware proxy, an Envoy
sidecar) that owns the hashing and membership logic and forwards each
request — simpler clients, at the cost of an extra network hop and a
proxy tier that must itself scale and stay available. Redis Cluster
splits the difference: the keyspace is divided into a fixed 16,384 hash
slots, and clients cache the slot→node map, redirecting on a `MOVED`
reply when it changes.

**Placement and rebalancing.** Plain `hash(key) % N` is fatal for a
cache: changing `N` (a node added or lost) remaps almost every key at
once, turning a topology change into a cluster-wide cache-miss storm
that stampedes the backing store. Consistent hashing with virtual nodes
is the standard fix — a membership change remaps only the departing or
arriving node's share of keys, so the miss rate spikes by roughly `1/N`
rather than `~100%`. Getting this right is the single most important
implementation decision in a distributed cache.

**Cache coherence — the one-copy simplification.** Unlike a single-node
cache, a cluster has multiple places a piece of data *could* live, which
raises the question of keeping them consistent. Most distributed caches
sidestep true multi-node consistency by ensuring each key lives on
**exactly one node at a time** (via consistent hashing) rather than
replicating and synchronizing copies. The payoff is a trivial coherence
model — there's only ever one authoritative copy to invalidate. The
tradeoff is availability: when a node dies, its keys are simply *gone*
from cache (a miss, which the backing store refills), never *stale*.
Systems that *do* replicate cached values for read availability must
then decide explicitly how much cross-replica staleness is acceptable,
and pay for propagating invalidations — which is why many teams
deliberately keep the one-copy model and absorb the miss on failure.

**The hot-key problem.** Hashing spreads keys evenly *on average*, but
request traffic is rarely uniform — a celebrity profile, a viral post,
or a flash-sale SKU can send a disproportionate share of all requests to
the one key (and thus the one node) that holds it, saturating that node
while the rest of the cluster idles. Mitigations stack: **replicate hot
keys** onto several nodes and load-balance reads across the copies, and
front the cluster with a small **in-process L1 cache** so repeated reads
of the hottest items never leave the application process. The L1 also
shortens the tail latency of every hit that lands there.

**Failure modes to design around.** Beyond hot keys and rebalance
storms, a distributed cache invites **cache stampede** — many clients
simultaneously missing the same expired key and all hammering the
backing store; guard it with the request coalescing and early
recomputation covered on
[Cache Stampede Prevention](/docs/patterns/caching/cache-stampede-prevention).
And because a cache is best-effort, callers must treat a cache node
outage as a miss, not an error — the backing store is the source of
truth, and a failed cache should degrade to it, not to a failure.

**Where it sits among siblings.** A distributed cache is fundamentally a
[key-value store](/docs/patterns/building-blocks/key-value-store) tuned
for *volatile, TTL'd, best-effort* data rather than a durable system of
record — same consistent-hashing partitioning, opposite durability
posture. It complements rather than replaces the caching *strategies*
(cache-aside, write-through, etc.), which decide *what* to cache and
*when* to invalidate regardless of whether the cache is one node or a
thousand.

## Code example

The core of a distributed-cache node is a keyed store with per-entry TTL
and lazy expiry, plus a routing function that maps each key to its
owning node. The test confirms an entry is served before its TTL and
treated as a miss after.

```rust
use std::collections::HashMap;
use std::time::{Duration, Instant};

struct Entry {
    value: String,
    expires_at: Instant,
}

pub struct CacheNode {
    map: HashMap<String, Entry>,
}

impl CacheNode {
    pub fn new() -> Self {
        CacheNode { map: HashMap::new() }
    }
    pub fn put(&mut self, key: &str, value: &str, ttl: Duration, now: Instant) {
        self.map.insert(
            key.to_string(),
            Entry { value: value.to_string(), expires_at: now + ttl },
        );
    }
    // Lazy expiry: an entry past its TTL is treated as a miss and dropped on read.
    pub fn get(&mut self, key: &str, now: Instant) -> Option<String> {
        match self.map.get(key) {
            Some(e) if e.expires_at > now => Some(e.value.clone()),
            Some(_) => { self.map.remove(key); None }
            None => None,
        }
    }
}

// Route a key to its owning cluster node (consistent hashing in a real
// system; a mixed hash + modulo here keeps the illustration self-contained).
pub fn owner_index(key: &str, node_count: usize) -> usize {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in key.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h = (h ^ (h >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    (h as usize) % node_count
}
```

## When to use it

- The cached working set or request throughput exceeds what a single
  cache instance can hold or serve.
- Multiple application instances need a shared cache view rather than
  each maintaining its own inconsistent local cache.
- You can tolerate a key's cached value being unavailable (a miss, not
  stale) briefly after a node failure, in exchange for a simple
  coherence model.

## When not to use it

- A single cache instance still comfortably handles the working set and
  load — a cluster adds routing and coherence complexity for no benefit
  yet.
- The application only needs a local, per-instance cache and different
  instances seeing slightly different data is fine — an in-process cache
  is simpler and faster.
- The data must be durable and authoritative; a cache is best-effort by
  design, and using one as a system of record invites silent data loss
  on eviction or node failure.

## Use-case scenarios

**Session store fronting a user database.** A fleet of stateless API
servers shares session state through a Redis Cluster keyed by session
ID. Consistent hashing spreads sessions across nodes; a small in-process
L1 absorbs the same user's rapid-fire requests within a single page
load. A node loss drops that slice of sessions to a miss, which the API
transparently refills from the user database — degraded, not broken.

**Product-catalog cache for a flash sale.** An e-commerce site caches
rendered product data ahead of a sale. When one discounted SKU goes
viral, its key becomes a hot key on a single node; the team replicates
that key across several nodes and load-balances reads, and an L1 in each
web server catches the overwhelming majority of repeat hits before they
reach the cluster at all. Stampede prevention coalesces the inevitable
simultaneous misses when the entry's TTL lapses mid-sale.

**Computed-result cache for an analytics API.** Expensive aggregations
are memoized in a distributed cache with a short TTL. Because results are
recomputable, the one-copy-per-key model is ideal: a node failure just
means a few queries recompute rather than serve stale numbers. Cache-aside
population plus early recomputation keeps p99 latency low without ever
serving a wrong answer.

## Production libraries & getting started

Distributed caching is usually a Redis-compatible server (Redis, Valkey, Dragonfly) or Memcached fronted by a per-language client.

| Library / Tool | Language | What it gives you | Getting started |
| --- | --- | --- | --- |
| ioredis | JS/TS | Full-featured Redis client (cluster, sentinel) | [ioredis](https://github.com/redis/ioredis) |
| node-redis | JS/TS | Official Node Redis client | [node-redis](https://github.com/redis/node-redis) |
| redis-rs | Rust | Sync/async Redis client | [docs.rs/redis](https://docs.rs/redis/latest/redis/) |
| go-redis | Go | Idiomatic Redis client | [go-redis](https://github.com/redis/go-redis) |
| redis-py | Python | Official Redis client | [redis-py client docs](https://redis.io/docs/latest/develop/clients/redis-py/) |
| Memcached | Server | Simple in-memory key cache | [memcached.org](https://memcached.org/) |
| Valkey | Server | Open-source Redis-compatible fork | [Installation](https://valkey.io/topics/installation/) |
| Dragonfly | Server | Redis/Memcached-compatible, multi-threaded | [Getting started](https://www.dragonflydb.io/docs/getting-started) |
| Hazelcast | Server (Java) | Distributed in-memory data grid | [Get started](https://docs.hazelcast.com/hazelcast/latest/getting-started/get-started-binary) |

## Related patterns

- [Cache](/docs/concepts/cache) — the primer's treatment of caching
  strategies (cache-aside, write-through, write-behind, TTLs), which
  apply equally whether the cache is a single node or a cluster.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  standard technique for routing keys to cache nodes and minimizing
  cache-miss storms when the cluster scales.
- [Cache-Aside](/docs/patterns/caching/cache-aside) — the most common
  population strategy layered on top of a distributed cache.
- [Cache Stampede Prevention](/docs/patterns/caching/cache-stampede-prevention) —
  guards against many clients simultaneously missing the same expired
  key and stampeding the backing store.
- [Key-Value Store](/docs/patterns/building-blocks/key-value-store) — the
  durable cousin a distributed cache resembles structurally but inverts
  on durability, using the same consistent-hashing partitioning.

## Further reading

- [Distributed cache — Wikipedia](https://en.wikipedia.org/wiki/Distributed_cache)
- [Redis Cluster specification](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/)
- [Consistent hashing (ketama) in Memcached clients — GitHub wiki](https://github.com/memcached/memcached/wiki/ConfiguringClient)
- [Caching best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
