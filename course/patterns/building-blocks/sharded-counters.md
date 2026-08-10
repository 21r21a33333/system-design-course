---
title: "Sharded Counters"
sidebar_position: 11
supplementary: true
---

A sharded counter splits a single hot counter into `N` independent
shard counters that absorb writes in parallel, summing them on read, so
no single row or key becomes a write-contention bottleneck under heavy
concurrent increments.

## Problem it solves

A naive counter — a single row or key holding a value that gets
incremented on every event — works fine at low write rates. Under heavy
concurrency, though, every increment has to serialize against every
other increment to the same row (to avoid lost updates), which caps
throughput at whatever rate a single row can be locked and updated, no
matter how much other capacity the database has. A "likes" counter on
a viral post, or a global page-view counter, can easily generate
concurrent write rates that overwhelm a single row long before any
other part of the system is under pressure. Sharding just that one
counter — not the whole dataset — fixes exactly this bottleneck without
requiring the rest of the schema to change.

## How it works

Instead of one counter row, the count is stored as `N` separate shard
rows (or keys), each holding a partial count. An increment picks one
shard — usually at random, or via `hash(some request attribute) % N` —
and increments only that shard, so concurrent increments to different
shards don't contend with each other at all; contention only occurs
between the (much smaller) subset of writes that happen to land on the
same shard at the same instant. Reading the total requires summing all
`N` shards, which is more expensive than reading a single value, so
this pattern trades read cost for write scalability — a reasonable
trade for counters that are written far more often than they're read
precisely (most UIs don't need an exact, up-to-the-millisecond like
count). Because summing all shards on every read can itself become
expensive at high read volume, the summed total is commonly cached
(see [Distributed Cache](/docs/patterns/building-blocks/distributed-cache)) and refreshed periodically rather than recomputed on
every request. The number of shards is a tunable: more shards reduce
write contention further but increase the cost of computing the sum, so
`N` is generally chosen based on expected peak concurrent write rate,
not maximized blindly.

## When to use it

- A single counter is written concurrently at a rate high enough to
  cause lock contention or throttling on that one row or key.
- Reads can tolerate either summing multiple shards on demand or
  reading a periodically refreshed cached total, rather than requiring
  a single always-exact read.
- The hot counter is identifiable in advance (likes, views, votes) —
  this pattern targets one specific bottleneck, not general write
  scaling.

## When not to use it

- Write volume to the counter is low enough that a single row never
  becomes a bottleneck — sharding adds read-side complexity for no
  benefit.
- The counter must always reflect an exact, immediately consistent
  value on every read, and the cost of summing all shards on every
  single read isn't acceptable.

## Real-world example

The sharded-counter pattern was popularized as a recipe for Google App
Engine's Datastore, specifically to work around the low sustained
write-rate limit on any single entity, by spreading increments across
multiple counter shard entities and summing them on read.

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — sharded counters apply
  the same "split to remove a single bottleneck" idea as database
  sharding, just applied to one hot counter instead of an entire
  dataset.

## Further reading

- [App Engine Application Platform — Google Cloud](https://cloud.google.com/appengine)
- [Sharding pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sharding)
