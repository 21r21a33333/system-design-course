---
title: "Write-Behind"
sidebar_position: 4
supplementary: true
---

Write-behind (also called write-back) accepts a write into the cache
and returns immediately, deferring the write to the backing store to
happen asynchronously afterward — often batched with other pending
writes — rather than making the writer wait for the store to durably
accept the value the way write-through does.

![Write-Behind diagram](/img/patterns/write-behind.svg)

## Problem it solves

Write-through guarantees the cache and store never diverge, but it pays
for that guarantee on every single write: the writer's latency is
bounded by the store's write latency, plus the cache's, every time.
For workloads with high write volume — telemetry ingestion, activity
logging, counters incremented on every request — paying the store's
full write cost synchronously on each one is often the actual
bottleneck, especially when many individual writes to the same or
nearby keys could be collapsed into one cheaper batched write instead.
Write-behind solves this by decoupling "the write is accepted" from
"the write is durable in the store": the cache takes the write
immediately and hands back control to the caller, while a background
process drains queued writes to the store on its own schedule — batching
them, coalescing repeated writes to the same key into one, and
generally trading a short window of eventual consistency between cache
and store for a write path that's as fast as the cache alone.

## Technical architecture & implementation

**Write path.** The application writes a value to the cache. The cache
stores it locally and, critically, appends the write to an internal
queue (or marks the entry "dirty") rather than forwarding it to the
store inline — then returns success to the caller immediately. A
separate process, running on its own cadence (a fixed interval, a queue
depth threshold, or both), drains that queue and flushes the pending
writes to the store, frequently combining what were several
independent application-level writes into fewer, larger store
operations. From the application's perspective, a write it just made is
instantly visible in the cache; whether that same write is visible in
the store yet is a separate question the application-level write path
never answers or waits for.

**The data-loss window — the mechanical crux.** Because the write is
considered "done" the moment the cache accepts it, there is a window,
bounded by the flush interval, during which a value exists only in the
cache and nowhere else. If the process holding that cache and its
pending-write queue crashes, is killed, or loses power before the next
flush runs, every write in that queue is lost — not stale, not
delayed, gone, with no record in the store that it was ever attempted.
This is fundamentally different from write-through's failure mode: a
failed write-through write fails loudly, synchronously, to the caller
who can retry; a lost write-behind write fails silently, after the
caller has already been told it succeeded. Bounding this window is the
central design lever of a write-behind implementation — a shorter flush
interval or a smaller batch-trigger threshold shrinks the amount of
data at risk at any instant, at the cost of losing more of the batching
efficiency that motivated write-behind in the first place; a longer
interval batches more efficiently but widens the loss window
proportionally.

**Ordering and coalescing.** Because writes accumulate in a queue
before being flushed, a write-behind implementation has to decide what
happens when the same key is written more than once before a flush —
the common and usually correct choice is to coalesce them, flushing
only the latest value per key rather than replaying every intermediate
write in order, since the store only needs to end up correct, not to
have witnessed every transient value. This is a meaningful behavior
difference from write-through, where every write reaches the store
individually and in order by construction (the write call blocks until
that specific value is committed) — a write-behind consumer of the
store that expects to see every intermediate value (an audit log, for
instance) will not get what it expects, because coalescing is an
optimization write-behind actively wants to apply.

**Write-behind vs. write-through — the composed picture.** The two
sit at opposite ends of the same trade-off, and the choice is really
about which failure mode is acceptable: write-through never lets the
cache get ahead of the store, at the cost of every write paying the
store's latency; write-behind lets writes run at cache speed, at the
cost of a real, bounded window where an acknowledged write can vanish
if the process dies before flushing. Neither is strictly better — a
system can even use both for different keys, write-through for data
where loss is unacceptable (balances, inventory) and write-behind for
data where a small loss window is a reasonable price for throughput
(metrics, view counts, non-critical activity logs).

## Code example

```rust
use std::collections::HashMap;

struct Store {
    committed: HashMap<u64, u64>,
}

impl Store {
    // A flush is one batched call, not N individual writes — this is
    // the throughput win write-behind is built to capture.
    fn flush_batch(&mut self, batch: &HashMap<u64, u64>) {
        for (&key, &value) in batch {
            self.committed.insert(key, value);
        }
    }
}

struct WriteBehindCache {
    entries: HashMap<u64, u64>,
    // Dirty writes not yet flushed to the store. Anything in here is
    // at risk of loss if the process dies before the next flush.
    pending: HashMap<u64, u64>,
}

impl WriteBehindCache {
    // Returns immediately — the store is never touched on the write path.
    // A repeated write to the same key overwrites the pending entry,
    // coalescing intermediate values rather than queuing each one.
    fn set(&mut self, key: u64, value: u64) {
        self.entries.insert(key, value);
        self.pending.insert(key, value);
    }

    fn get(&self, key: u64) -> Option<&u64> {
        self.entries.get(&key)
    }

    // Called on a timer or queue-depth trigger by a background process,
    // not by the application's write path.
    fn flush(&mut self, store: &mut Store) {
        store.flush_batch(&self.pending);
        self.pending.clear();
    }
}
```

`set` never touches `Store` — it only marks the key dirty in `pending`
and returns. `flush`, called separately and asynchronously, is the only
place the store is written, and it writes the whole coalesced batch at
once. Anything left in `pending` when the process dies before `flush`
runs is lost — that's the data-loss window made concrete.

## When to use it

- Write throughput is the binding constraint, and the workload can
  tolerate a bounded, well-understood window in which a very recent
  write might be lost if the process crashes.
- The same keys are written repeatedly in a short span, so coalescing
  multiple writes into one flush meaningfully reduces load on the
  store rather than just deferring the same number of writes.
- The data being written is recoverable or low-stakes enough that
  occasional loss of the most recent value is an acceptable trade for
  substantially faster writes — metrics, counters, non-critical logs.

## When not to use it

- Any acknowledged write must be guaranteed durable — financial
  transactions, inventory decrements, anything where "the system said
  this succeeded" has to actually be true even across a crash.
  Write-through is the correct strategy here, not write-behind.
- Downstream consumers of the store need to observe every intermediate
  value a key passed through, not just its latest state — write-
  behind's coalescing is specifically designed to skip intermediate
  values, which breaks that expectation.
- The team can't confidently bound or monitor the flush queue's depth
  and age — an unbounded or unmonitored write-behind queue can grow
  during a store outage and turn a brief store hiccup into a large,
  silent data-loss event when memory pressure eventually forces entries
  out.

## Use-case scenarios

**Page-view counters for a content platform.** A news site increments
a view counter on every article load. Writing each individual increment
through to the database synchronously would make the database the
bottleneck for every page view on the site. Write-behind lets the
cache absorb increments instantly and flush a single "add N views"
batched update per article every few seconds — losing a few seconds of
increments in the rare event of a crash is an acceptable trade against
not bottlenecking every page load on a database write.

**IoT telemetry ingestion.** A fleet of sensors reports readings every
few seconds to an ingestion service. The service writes each reading
into a write-behind cache keyed by device ID, coalescing rapid
repeated updates from the same device, and flushes batched readings to
the time-series store on a fixed interval. A brief loss window on
process crash is acceptable because the next reading a few seconds
later effectively supersedes the lost one for most monitoring purposes.

**Session activity tracking for a web application.** A web app tracks
"last active" timestamps for logged-in users, updated on nearly every
request. Writing that timestamp through to the primary database
synchronously on every single request would multiply write load far
beyond what the feature is worth. Write-behind batches and coalesces
these updates, flushing the latest timestamp per session periodically,
since losing the very latest few seconds of activity data on a crash
has no meaningful downstream impact.

## Related patterns

- [Write-Through](/docs/patterns/caching/write-through) — the
  synchronous counterpart this page is defined in direct contrast to;
  read together for the full write-side trade-off between latency and
  the data-loss window.
- [Cache-Aside](/docs/patterns/caching/cache-aside) — commonly handles
  the read side alongside write-behind, since write-behind alone only
  describes how writes reach the store, not how reads populate a cold
  cache.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  the clustered cache infrastructure a write-behind queue is typically
  built on top of at scale, where the queue itself may need to be
  replicated to survive a single node's failure.

## Further reading

- [Caching best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
- [Cache (computing) — Wikipedia](https://en.wikipedia.org/wiki/Cache_(computing))
