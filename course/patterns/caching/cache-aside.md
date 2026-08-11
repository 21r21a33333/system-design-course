---
title: "Cache-Aside"
sidebar_position: 1
supplementary: true
---

Cache-aside puts the application in direct control of the cache: on a
read, the application checks the cache itself and only falls back to
the backing store on a miss, populating the cache afterward; the cache
never talks to the store on its own. It's the strategy most systems
reach for first, because it asks nothing of the cache beyond get/set
and tolerates the cache disappearing entirely without taking the
system down with it.

![Cache-Aside diagram](/img/patterns/cache-aside.svg)

## Problem it solves

Reading from a primary data store on every request is the simplest
thing a system can do, and for a lot of workloads it's also the
slowest and most expensive: the same handful of rows get re-fetched,
re-joined, or re-computed thousands of times a second, and the store's
capacity gets spent on redundant work instead of the write traffic and
cold reads it actually needs to absorb. Cache-aside solves this without
requiring any change to the store itself or any new component sitting
between the application and the store — the application simply checks
a fast, separate cache first, and only pays the store's cost when the
cache doesn't yet have the answer. Because the application owns the
logic end to end, the cache can be introduced incrementally, one query
path at a time, and removed just as easily if it turns out not to be
worth the complexity.

## Technical architecture & implementation

**Read path.** The application receives a request for a key, checks the
cache, and one of two things happens. On a hit, the cached value is
returned directly and the store is never touched. On a miss, the
application queries the store itself, then writes the result into the
cache — usually with a TTL — before returning it, so the *next* reader
of that key gets a hit. The cache is entirely passive here: it doesn't
know what a "user" or a "product" is, it just holds whatever key-value
pairs the application decided to put in it, and a cold cache (empty,
just restarted, or missing a key it never happened to serve) degrades
to "read from the store," not to an error.

**Write path — and the race condition.** Cache-aside says nothing about
how writes reach the cache; the most common approach is to write to the
store and then delete (not update) the corresponding cache entry, so
the next read repopulates it from fresh data. This "write to store,
then invalidate cache" sequence has a well-known race: thread A reads
key K, gets a cache miss, and starts a query against the store; before
A's query returns, thread B writes a new value for K to the store and
deletes K from the cache; A's now-stale query result finally returns
and A writes *that* stale value into the cache, overwriting the
invalidation B just did. The cache now holds a stale value for K until
the next write happens to come along and evict it again, or until a
TTL expires — cache-aside on its own has no mechanism to prevent this,
it only bounds how long the staleness can last once a TTL is set. In
practice this is usually accepted as a low-probability, self-healing
inconsistency rather than something worth solving directly, because
closing it properly requires either short TTLs, versioned writes, or
locking the key during the read-repopulate window — real cost for what
is normally a narrow timing window.

**Failure modes.** If the cache is unavailable, cache-aside degrades
cleanly to "every read goes to the store," which is exactly the
system's behavior before the cache existed — slower, not broken. This
is the property that makes cache-aside the default choice: unlike
strategies where the cache sits *in front of* the store as the
authoritative write path, here the store is always the source of
truth and the cache is disposable. A cold cache after a restart or a
node loss produces a temporary spike in store load as entries get
repopulated one miss at a time (sometimes called a "cold start," and at
larger scale a contributor to the thundering-herd problem covered
separately), but it does not produce incorrect answers.

**Cache-aside vs. read-through.** The two are easy to conflate because
both populate the cache lazily, on a miss, rather than eagerly on a
write. The distinction is *who* owns the miss-handling logic. In
cache-aside, the application contains the "check cache, on miss query
store, then populate cache" logic explicitly — the cache library is a
dumb key-value store the application calls twice. In read-through, that
same logic is pushed down into the caching layer itself, which is
configured with knowledge of how to load from the store, so the
application only ever calls the cache and the cache handles the miss
internally. Functionally the read path behaves almost identically;
architecturally, cache-aside keeps the loading logic in application
code (portable, but duplicated across every caller), while read-through
centralizes it in the cache (consistent, but couples the cache to the
store's schema and access pattern).

## Caching strategies compared

Cache-aside is one of five strategies in this group, and the fastest way
to place it is against the others on the axes that actually differ — who
populates the cache, how reads and writes flow, the consistency it
offers, and what happens when a component fails.

| Strategy | Who populates the cache | Read path | Write path | Consistency | Failure mode if cache is down |
|---|---|---|---|---|---|
| [Cache-aside](/docs/patterns/caching/cache-aside) | Application, lazily on a miss | App checks cache, on miss queries store and fills cache | App writes store, then invalidates the entry | Eventual; a narrow invalidate-race can leave a stale entry until TTL/next write | Degrades to store-only reads — slower, not broken |
| [Read-through](/docs/patterns/caching/read-through) | Cache's loader, lazily on a miss | App calls cache only; cache invokes its loader on a miss | Not defined by the pattern (pair with a write strategy) | Same as cache-aside on reads, but miss-handling is uniform across callers | Cache is a mandatory hop — reads can fail unless an explicit bypass exists |
| [Write-through](/docs/patterns/caching/write-through) | Cache, synchronously on every write | Warm cache read; pair with a lazy loader for keys that predate the cache | App writes cache, cache writes store synchronously before returning | Strong for written keys — cache never leads the store | Writes fail or must bypass; written keys can't be served stale |
| [Write-behind](/docs/patterns/caching/write-behind) | Cache, on write; store updated asynchronously | Warm cache read; pair with a lazy loader | App writes cache, returns immediately; background flush drains to store | Eventual; bounded window where an acknowledged write exists only in cache | Queued writes not yet flushed are lost if the process dies |

Read-through and write-through/write-behind are complementary rather than
mutually exclusive: the read column and write column are chosen
independently, which is why write-through and write-behind are so often
paired with a lazy read strategy (cache-aside or read-through) to cover
keys that predate the current cache instance.

## Code example

```rust
use std::collections::HashMap;

struct Store {
    rows: HashMap<u64, String>,
}

impl Store {
    fn query(&self, id: u64) -> Option<String> {
        self.rows.get(&id).cloned()
    }
}

struct Cache {
    entries: HashMap<u64, String>,
}

impl Cache {
    fn get(&self, id: u64) -> Option<&String> {
        self.entries.get(&id)
    }

    fn set(&mut self, id: u64, value: String) {
        self.entries.insert(id, value);
    }

    fn invalidate(&mut self, id: u64) {
        self.entries.remove(&id);
    }
}

// The application, not the cache, drives the miss-fill logic.
fn get_user(cache: &mut Cache, store: &Store, id: u64) -> Option<String> {
    if let Some(hit) = cache.get(id) {
        return Some(hit.clone());
    }
    let loaded = store.query(id)?;
    cache.set(id, loaded.clone());
    Some(loaded)
}

// Writes go to the store first, then invalidate — never update in place —
// so the next read repopulates from a fresh query rather than trusting
// the writer to have shaped the cached representation correctly.
fn update_user(cache: &mut Cache, store: &mut Store, id: u64, value: String) {
    store.rows.insert(id, value);
    cache.invalidate(id);
}
```

`get_user` shows the cache as a passive lookup the application checks
first and fills on a miss; `update_user` shows the accepted convention
of invalidating rather than updating the cache entry on write, since
writing a possibly-stale value directly into the cache is exactly the
race condition described above.

## When to use it

- Read-heavy workloads where the same keys are requested repeatedly and
  the backing store's query cost (latency, load, or both) is worth
  avoiding on repeat reads.
- The application should keep working, just slower, if the cache is
  unavailable — no other component's correctness should depend on the
  cache being up.
- Only a subset of the data is actually accessed often enough to be
  worth caching, and that subset isn't known in advance — cache-aside
  populates on demand rather than requiring a pre-load step.

## When not to use it

- Strict read-after-write consistency is required and the
  invalidate-race window described above is not acceptable at any
  probability — a strategy that keeps the cache synchronously in the
  write path (write-through) removes that window.
- The application shouldn't have to contain cache-loading logic at all
  — if centralizing that logic in the caching layer itself is
  preferred, read-through is the same idea with the responsibility
  moved.
- Nearly every key gets read at least once shortly after being written,
  in which case the first-read penalty cache-aside always pays (query
  the store, then populate) provides little benefit over just reading
  the store directly.

## Use-case scenarios

**Product catalog page for an e-commerce site.** Product detail pages
are read constantly but written rarely (price and stock changes are a
tiny fraction of traffic compared to page views). The application
checks the cache for a product ID on every page render; a miss costs
one store query and one cache write, and every subsequent view of that
product for the next few minutes is served from cache. When a price
changes, the write path invalidates just that product's entry rather
than touching anything else in the cache.

**User profile service behind a REST API.** A social app's profile
endpoint is called by dozens of internal services (feed ranking,
notifications, search) for the same small set of active users
repeatedly within a short window. Cache-aside lets the profile service
absorb that fan-in without every caller adding its own caching layer:
one shared cache-aside cache in front of the profile store handles the
repeated lookups, and if that cache is flushed or restarted, callers
just see a brief latency bump, not an outage.

**Internal analytics dashboard.** A dashboard aggregates data from a
slow reporting database that's expensive to query and not tuned for
low-latency reads. Because dashboard viewers tolerate slightly stale
numbers (a few minutes old is fine), cache-aside with a multi-minute
TTL is enough: most page loads hit the cache, and the store only sees
load from the occasional miss or TTL expiry, not from every viewer's
every refresh.

## Related patterns

- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  the underlying cache infrastructure cache-aside is typically
  implemented against once a single node's cache no longer has enough
  capacity.
- [Read-Through](/docs/patterns/caching/read-through) — the same
  lazy-population idea with the miss-handling logic moved from the
  application into the caching layer itself.
- [Write-Through](/docs/patterns/caching/write-through) — a stricter
  alternative for the write side that removes cache-aside's
  invalidation race by keeping the cache synchronously updated on every
  write.
- [Cache Stampede Prevention](/docs/patterns/caching/cache-stampede-prevention) —
  addresses what happens when many concurrent cache-aside misses for
  the same hot key all hit the store at once.

## Further reading

- [Cache-aside pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/cache-aside)
- [Caching best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
- [Cache (computing) — Wikipedia](https://en.wikipedia.org/wiki/Cache_(computing))
