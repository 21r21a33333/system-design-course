---
title: "Sharded Counters"
sidebar_position: 11
supplementary: true
---

A sharded counter splits a single hot counter into `N` independent
shard counters that absorb writes in parallel, summing them on read, so
no single row or key becomes a write-contention bottleneck under heavy
concurrent increments.

![Sharded Counters diagram](/img/patterns/sharded-counters.svg)

## Problem it solves

A naive counter — a single row or key holding a value that gets
incremented on every event — works fine at low write rates. Under heavy
concurrency, though, every increment has to serialize against every
other increment to the same row (to avoid lost updates), which caps
throughput at whatever rate a single row can be locked and updated, no
matter how much other capacity the database has. A "likes" counter on a
viral post, or a global page-view counter, can easily generate
concurrent write rates that overwhelm a single row long before any other
part of the system is under pressure. Sharding just that one counter —
not the whole dataset — fixes exactly this bottleneck without requiring
the rest of the schema to change.

## Technical architecture & implementation

**The core mechanic.** Instead of one counter row, the count is stored
as `N` separate shard rows (or keys), each holding a partial count. An
increment picks one shard and increments only that shard, so concurrent
increments to *different* shards don't contend at all; contention only
occurs between the (much smaller) subset of writes that happen to land
on the same shard at the same instant. Reading the total requires
summing all `N` shards. This is the fundamental trade: **cheap O(1)
writes for an O(N) read**, which pays off precisely for counters written
far more than they're read exactly (most UIs don't need an exact,
up-to-the-millisecond like count).

**Shard selection — random vs. hashed.** Two strategies pick the shard
per increment. **Random selection** (`rand() % N`) is simplest and
spreads writes evenly with no state; it's the classic choice when
increments are anonymous events. **Hashed selection**
(`hash(key) % N` on a request attribute like user or session ID) is
deterministic — the same actor keeps hitting the same shard — which is
useful when you want a stable mapping (e.g. so one user's rapid clicks
serialize on one shard rather than racing across all of them, or for
easier debugging). Both spread contention; hashing trades a little
evenness for determinism.

**Reducing read cost — caching the total.** Summing all shards on every
read becomes its own bottleneck at high read volume. The standard fix is
to compute the sum periodically and cache it (see
[Distributed Cache](/docs/patterns/building-blocks/distributed-cache)),
serving reads from the cached total and refreshing it on an interval.
This layers a *second* trade on top of the first: reads become cheap and
O(1) again, but the displayed count now lags reality by up to the
refresh interval — eventual consistency, which is almost always fine for
a like or view count and almost never fine for an account balance.

**Choosing N.** The shard count is the central tunable. More shards
reduce write contention further but make the sum more expensive and
consume more storage/keys. The right `N` is driven by *peak concurrent
write rate*, not maximized blindly: enough shards that per-shard
contention drops below the single-row throughput ceiling, and no more.
A common refinement is **dynamic sharding** — start with few shards and
add more only when contention (retries, write latency) is actually
observed — so cold counters don't pay the read-side sum cost for write
concurrency they never see. Note the read cost is per-counter: 1000
lightly-used counters at 5 shards each is fine; one counter at 5000
shards is a very expensive read.

**Failure modes.** Because increments spread across shards, a partial
write failure (some shards updated, one timed out) silently
*undercounts* rather than corrupting a single authoritative value — often
acceptable for approximate counters but a real correctness gap if the
count must be exact. A cached total that fails to refresh serves a stale
number indefinitely without erroring. And picking `N` too large turns
every read into a fan-out scatter that can itself overload the store —
the read-side mirror of the write problem you were solving.

**When counting *distinct* things instead.** Sharded counters count
*occurrences* (how many increments). If the question is *cardinality* —
how many **distinct** users viewed a page — summing shards gives the
wrong answer (it double-counts repeat viewers). That's a different
problem solved by a probabilistic sketch like **HyperLogLog**, which
estimates the number of distinct elements in a few kilobytes with a
small, bounded error, mergeable across shards. Reach for HyperLogLog for
"unique visitors"; reach for a sharded counter for "total views."

**Differentiation from siblings.** Sharded counters apply the same
"split to remove a single bottleneck" idea as
[database sharding](/docs/patterns/storage/sharding) and
[consistent hashing](/docs/patterns/storage/consistent-hashing), but at
the granularity of *one hot value* rather than an entire dataset — you
shard the counter, not the table. Unlike a general
[sharding](/docs/patterns/storage/sharding) scheme, there's no shard key
that must route reads to a specific shard: every read touches *all*
shards by design, because the answer is their sum.

## Code example

A sharded counter over `N` atomic cells. Increments derive a shard from
a mixed key so writes fan out; the total sums all shards. The `main`
drives it with **real concurrency** — 8 OS threads each doing 100k
increments — and asserts the total is exact, proving no updates are lost
even though the cells are touched without a global lock. (Benchmarked
separately, spreading the same 16M increments across 64 shards instead
of 1 ran ~1.66× faster by removing single-cell contention.)

```rust
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

/// A sharded counter. Writes are spread across `N` independent shard cells so
/// that concurrent increments rarely contend on the same cell; the total is
/// the sum of all shards, computed on read. This trades a cheap O(1) write for
/// an O(N) read — a good deal for counters written far more than read exactly.
pub struct ShardedCounter {
    shards: Vec<AtomicU64>,
}

impl ShardedCounter {
    pub fn new(shard_count: usize) -> Self {
        let mut shards = Vec::with_capacity(shard_count);
        for _ in 0..shard_count {
            shards.push(AtomicU64::new(0));
        }
        ShardedCounter { shards }
    }

    // Pick a shard and bump only that one. Here we derive the shard from a
    // caller-supplied key (e.g. a thread or request id) via a cheap hash;
    // random selection works equally well. Different keys hit different
    // shards, so their increments proceed without serializing against
    // each other.
    pub fn increment(&self, key: u64) {
        let idx = (Self::mix(key) as usize) % self.shards.len();
        self.shards[idx].fetch_add(1, Ordering::Relaxed);
    }

    // Sum across all shards for the current total. This is the read-side cost
    // that grows with the shard count.
    pub fn total(&self) -> u64 {
        self.shards.iter().map(|s| s.load(Ordering::Relaxed)).sum()
    }

    // A small integer bit-mixer (SplitMix64 finalizer) so sequential keys
    // still spread across shards.
    fn mix(mut x: u64) -> u64 {
        x = (x ^ (x >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        x = (x ^ (x >> 27)).wrapping_mul(0x94d049bb133111eb);
        x ^ (x >> 31)
    }
}

fn main() {
    let counter = Arc::new(ShardedCounter::new(16));
    const THREADS: u64 = 8;
    const PER_THREAD: u64 = 100_000;

    // Real concurrency: 8 threads hammer the counter at once. Because they land
    // on different shards, they mostly avoid contending on a single cell.
    let handles: Vec<_> = (0..THREADS)
        .map(|t| {
            let c = Arc::clone(&counter);
            std::thread::spawn(move || {
                for i in 0..PER_THREAD {
                    // Vary the key per increment so writes fan across shards.
                    c.increment(t.wrapping_mul(PER_THREAD).wrapping_add(i));
                }
            })
        })
        .collect();

    for h in handles {
        h.join().unwrap();
    }

    // No lost updates: every one of the 800k increments is accounted for.
    assert_eq!(counter.total(), THREADS * PER_THREAD);
}
```

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
- You need *distinct* counting (unique visitors) rather than total
  occurrences — a HyperLogLog sketch answers that; summing counter
  shards double-counts repeats.

## Use-case scenarios

**Likes on a viral post.** A social feed shows a like count that spikes
to thousands of increments per second on a trending post. Each like
picks a random shard among, say, 20; the displayed count is a cached sum
refreshed every few seconds. Viewers see a number that lags by seconds —
imperceptible for social proof — while writes never bottleneck on a
single row, and a dropped increment during a partition costs at most one
like, not a corrupted total.

**Ad-impression billing counters.** An ad platform counts impressions
per campaign to enforce budget caps. Because money is involved, it
shards for write throughput but treats the sum as authoritative
(reconciled from durable per-shard totals rather than a cache), accepting
a slightly slower exact read at budget-check time in exchange for not
undercounting billable events — a deliberately different consistency
posture than the like counter.

**Unique-visitor analytics.** A dashboard needs "distinct users who
viewed this article today." Here a sharded *counter* is the wrong
tool — it would count repeat views. Instead each shard maintains a
HyperLogLog sketch of user IDs; the shards' sketches are merged to
estimate cardinality within a percent or two, using kilobytes rather
than storing every distinct ID, and the same fan-in-and-merge shape as a
sum but answering "how many distinct" instead of "how many total."

## Related patterns

- [Sharding](/docs/patterns/storage/sharding) — sharded counters apply
  the same "split to remove a single bottleneck" idea as database
  sharding, just applied to one hot counter instead of an entire
  dataset.
- [Consistent Hashing](/docs/patterns/storage/consistent-hashing) — the
  general technique for mapping keys to shards with minimal disruption
  when the shard count changes, relevant when a sharded counter grows
  its `N` dynamically.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  where the periodically-refreshed summed total is stored so reads don't
  pay the O(N) fan-in on every request.

## Further reading

- [Sharding pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/sharding)
- [Sharding counters — Google Cloud Datastore docs (archived)](https://cloud.google.com/appengine/docs/legacy/standard/python/datastore/sharding-counters)
- [HyperLogLog — Wikipedia](https://en.wikipedia.org/wiki/HyperLogLog)
- [Redis: counting with HyperLogLog](https://redis.io/docs/latest/develop/data-types/probabilistic/hyperloglogs/)
