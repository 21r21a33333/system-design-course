---
title: "Write-Through"
sidebar_position: 3
supplementary: true
---

Write-through makes the cache part of the synchronous write path: every
write goes to the cache first, and the cache itself — not the
application — writes the value on to the backing store before the
write is considered complete. The cache is never allowed to hold a
value the store hasn't also accepted, which is the property cache-aside
cannot guarantee on its own.

![Write-Through diagram](/img/patterns/write-through.svg)

## Problem it solves

Cache-aside's write path (write to the store, then invalidate the
cache entry) leaves a window — described in detail on the [Cache-Aside](/docs/patterns/caching/cache-aside)
page — where a concurrent read can repopulate the cache with a value
that's already stale by the time it lands. For most applications that
window is rare and self-healing enough to accept, but for data where a
reader seeing a stale value even briefly is unacceptable — an account
balance, an inventory count near zero, a permissions flag — that risk
isn't acceptable at any probability. Write-through solves this by
removing the gap between "store has the new value" and "cache has the
new value" entirely: the two updates happen as a single logical
operation from the writer's point of view, so there is no intermediate
state in which a reader can observe the cache holding anything other
than what was just written or what was there before.

## Technical architecture & implementation

**Write path.** The application writes a value to the cache, exactly as
it would with any cache. The cache, rather than just storing the value
locally and returning immediately, synchronously writes that same value
through to the backing store as part of handling the write call — the
application's write call does not return, and is not considered
successful, until the store has accepted the write. If the store write
fails, the cache write is expected to fail too (or be rolled back),
otherwise the cache would hold a value the store never actually
persisted, which reintroduces exactly the inconsistency write-through
exists to prevent. The mechanical consequence is that write latency is
now bounded below by the store's write latency, not the cache's — the
cache adds a hop and, in most implementations, no longer makes writes
faster, only reads.

**Read path.** Reads behave like any warm cache: check the cache, if
present return it. Because every write to the store also went through
the cache, the cache's copy of any key that has ever been written is
guaranteed current — write-through never leaves a stale value sitting
in the cache the way cache-aside's race can. The one gap is a key that
has *never* been written since the cache was last cold (a new node
after a failure, a fresh cache instance) — write-through says nothing
about how such a key gets into the cache on first read, which is why
write-through is very commonly paired with cache-aside or read-through
for the read side: write-through keeps written data fresh, and a
lazy-load strategy fills in reads for keys that predate the current
cache instance.

**Failure modes.** The core failure mode is a *partial* write: the
cache accepts and stores the value, but the downstream store write
fails or times out after the cache commit. If the implementation
doesn't handle this as a single atomic unit — rolling the cache entry
back on store failure — the cache ends up holding a value that was
never durably persisted, which is silently worse than a stale cache: a
reader gets a confident, "fresh-looking" answer that doesn't actually
exist in the source of truth, and if the cache is later lost (a
restart, an eviction), that value is gone with no record it ever
existed. Getting this right requires the cache-to-store write to be
treated as failable and its failure to be propagated back to whatever
initiated the write, not swallowed at the cache layer.

**Write-through vs. write-behind.** This is the central distinction
across two of the five caching-strategy pages in this group, and it
comes down to exactly one thing: does the write to the cache block on
the write to the store, or not. Write-through: the store write is
synchronous and part of the same operation — the write call to the
cache does not complete until the store has durably accepted the
value, which means the cache and store can never diverge for longer
than one in-flight write, at the direct cost of every write paying the
store's full write latency. [Write-Behind](/docs/patterns/caching/write-behind):
the cache accepts the write and returns immediately, queuing the store
write to happen asynchronously afterward — writes are fast because they
only pay the cache's latency, but there is now a window, however short,
during which the cache holds a value the store does not yet have, and
if the process holding that queued write crashes before the flush
happens, that write is lost entirely. Put mechanically: write-through
trades write latency for a durability guarantee that holds continuously;
write-behind trades that continuous guarantee for lower write latency,
accepting a bounded but real data-loss window in exchange.

## Code example

```rust
struct Store {
    committed: Option<String>,
}

impl Store {
    // Simulates a store write that can fail — e.g. a constraint
    // violation, a timeout, a full disk.
    fn write(&mut self, value: &str) -> Result<(), &'static str> {
        if value.is_empty() {
            return Err("store rejected empty value");
        }
        self.committed = Some(value.to_string());
        Ok(())
    }
}

struct WriteThroughCache {
    entry: Option<String>,
}

impl WriteThroughCache {
    // The write does not complete, and the cache entry is not kept,
    // unless the store write also succeeds — the two are one operation.
    fn set(&mut self, store: &mut Store, value: &str) -> Result<(), &'static str> {
        store.write(value)?;
        self.entry = Some(value.to_string());
        Ok(())
    }

    fn get(&self) -> Option<&String> {
        self.entry.as_ref()
    }
}
```

`set` only updates `self.entry` after `store.write` has returned `Ok`
— if the store rejects the write, the `?` operator returns early and
the cache entry is left untouched, so the cache can never end up
holding a value the store refused to persist.

## When to use it

- The cache must never be observed holding a value more recent than
  what the store has durably accepted — financial balances, inventory
  counts, or any data where a stale-then-correct read sequence is
  unacceptable.
- Write volume is low enough, or write latency tolerant enough, that
  paying the store's full write cost on every cache write is
  acceptable.
- The system already pairs write-through with a lazy read strategy
  (cache-aside or read-through) to handle keys that predate the current
  cache instance, rather than expecting write-through alone to populate
  reads.

## When not to use it

- Write throughput or write latency is the binding constraint, and the
  workload can tolerate a short window of eventual consistency between
  cache and store — write-behind removes the synchronous store-write
  cost from the write path.
- Most written data is rarely or never read back before it's
  overwritten or expires — paying store-write latency on every cache
  write to keep entries fresh that are unlikely to be read wastes the
  latency budget for no benefit.
- The store itself is the bottleneck and adding a synchronous
  cache-to-store write on every application write doesn't reduce load
  on it at all — write-through does nothing to shield the store from
  write traffic, only reads.

## Use-case scenarios

**Bank account balance cache in front of a ledger database.** A banking
system caches account balances for fast reads on every transaction
check, but a balance shown even briefly stale after a debit could let a
second concurrent debit succeed when it shouldn't. Write-through
ensures the cached balance is updated as part of the same operation
that commits the debit to the ledger, so any read immediately after a
completed transaction sees the post-transaction balance, never a
stale pre-transaction one.

**Inventory count for a flash-sale item.** An e-commerce system tracks
remaining stock for a limited-quantity item in cache to avoid hammering
the database on every add-to-cart click. Because overselling (showing
stock that isn't really there) is a costly failure mode, decrements to
the stock count are written through synchronously — the cache is never
allowed to show a count the database hasn't also committed to, even
under heavy concurrent purchase attempts.

**Feature-flag / permission cache for an admin console.** An internal
admin tool caches per-user permission flags for fast authorization
checks on every request. When an administrator revokes a permission,
that revocation is written through the cache synchronously, so the very
next request from that user — potentially milliseconds later — is
evaluated against the updated permission set rather than a cached
"still allowed" value.

## Related patterns

- [Write-Behind](/docs/patterns/caching/write-behind) — the asynchronous
  counterpart that trades write-through's continuous consistency
  guarantee for lower write latency; read together, these two pages
  define the central write-side trade-off in caching.
- [Cache-Aside](/docs/patterns/caching/cache-aside) — commonly paired
  with write-through to handle the read side for keys that predate the
  current cache instance, since write-through alone only keeps written
  keys fresh.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  the underlying infrastructure a write-through cache is typically
  implemented against at scale.

## Further reading

- [Caching best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
- [Cache (computing) — Wikipedia](https://en.wikipedia.org/wiki/Cache_(computing))
