---
title: "Read-Through"
sidebar_position: 2
supplementary: true
---

Read-through moves the miss-handling logic that cache-aside puts in
application code down into the caching layer itself: the cache is
configured with a loader that knows how to fetch from the backing
store, so the application only ever calls the cache, and a miss is
resolved by the cache calling the loader internally before returning
the value.

![Read-Through diagram](/img/patterns/read-through.svg)

## Problem it solves

Cache-aside works, but it means every caller that wants cached reads
has to implement the same "check cache, on miss query store, then
populate cache" sequence itself. In a system with several services, or
several code paths within one service, all reading the same underlying
data, that logic gets duplicated — and duplicated logic drifts: one
call site might forget to set a TTL, another might cache a
differently-shaped result, another might not populate the cache on a
miss at all. Read-through solves this by making the cache itself
responsible for knowing how to load a value it doesn't have, so there
is exactly one place the load-on-miss logic lives, and every caller,
regardless of language or service boundary, gets the same
miss-handling behavior automatically just by calling `get`.

## Technical architecture & implementation

**Read path.** The application calls `get(key)` on the cache and
nothing else — there is no separate "query the store" step visible to
the caller. Internally, the cache checks its own storage first; on a
hit it returns immediately, identical to cache-aside. On a miss, the
cache invokes a loader function it was configured with up front (at
cache-construction time, not per-call) — this loader knows how to turn
a key into a value by querying the backing store — waits for the
loader to return, stores the result under that key, and then returns it
to the caller as if it had been there all along. The caller cannot tell
from the API alone whether a given `get` was a hit or triggered a load;
that's the point.

**Concurrent misses for the same key.** Because the loader lives inside
the cache rather than in scattered application code, a read-through
cache implementation is in a position to *deduplicate* concurrent loads
for the same key — if ten requests for key K arrive while K is being
loaded, a well-implemented read-through cache can have the first
request trigger the load and the other nine wait on that same
in-flight load rather than each independently querying the store. This
single-flight behavior is not automatic just from calling something
"read-through" — a naive implementation still lets N concurrent misses
turn into N redundant store queries — but centralizing the load path in
one component is what makes deduplication *possible* to add in one
place, which is much harder to retrofit across N independent
cache-aside call sites scattered through application code.

**Failure modes.** If the loader itself fails (the store is down, the
query times out), that failure propagates back through the cache's
`get` call to the application — from the caller's point of view it
looks like the store call failed, because functionally it was the
store call, just made on the cache's behalf. This is a meaningful
difference from cache-aside's failure mode: with cache-aside, if the
*cache* is unreachable, the application's own fallback code decides
what to do (usually: query the store directly). With read-through, the
cache is an unavoidable hop in the read path — even a load triggered
by a miss goes cache-first — so a broken read-through cache can take
reads down entirely if there's no explicit bypass, rather than
degrading to store-only reads automatically the way cache-aside does
by construction.

**Read-through vs. cache-aside.** Both are lazy, miss-triggered
population strategies — neither pre-warms the cache with data nobody
asked for yet — and their read-path *behavior* is nearly identical: a
hit returns fast, a miss pays a load cost once and is fast thereafter.
The distinction is purely architectural, about where the loading
knowledge lives. Cache-aside: the application knows about both the
cache and the store, and orchestrates the two calls itself, which means
different call sites can implement the miss path differently (for
better or worse) and the cache library needs no knowledge of the store
at all. Read-through: the cache knows about the store (via its
configured loader) and the application only ever talks to the cache,
which guarantees uniform miss-handling but couples the cache
configuration to the shape and location of the backing store — swapping
the store implementation means reconfiguring the cache's loader, not
just changing a query in application code.

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

// The loader is a closure the cache is configured with once, at
// construction — application code never sees or calls it directly.
struct ReadThroughCache<F: Fn(u64) -> Option<String>> {
    entries: HashMap<u64, String>,
    loader: F,
}

impl<F: Fn(u64) -> Option<String>> ReadThroughCache<F> {
    fn new(loader: F) -> Self {
        Self { entries: HashMap::new(), loader }
    }

    // The only method application code calls. A miss is resolved
    // internally — the caller cannot tell hit from miss from the
    // return type alone.
    fn get(&mut self, id: u64) -> Option<String> {
        if let Some(hit) = self.entries.get(&id) {
            return Some(hit.clone());
        }
        let loaded = (self.loader)(id)?;
        self.entries.insert(id, loaded.clone());
        Some(loaded)
    }
}

fn build_cache(store: Store) -> ReadThroughCache<impl Fn(u64) -> Option<String>> {
    ReadThroughCache::new(move |id| store.query(id))
}
```

Application code that receives a `ReadThroughCache` only ever calls
`get` — the `Store` and the `loader` closure that bridges to it are
sealed inside the cache at construction time, which is the mechanical
difference from cache-aside's `get_user` function that explicitly calls
both `cache.get` and `store.query` itself.

## When to use it

- Multiple services or call sites read the same underlying data and
  should get identical, centrally-maintained miss-handling behavior
  without duplicating loader logic in each one.
- The caching layer or library in use supports configuring a loader
  directly (many managed and in-process cache libraries do), so
  read-through doesn't require building custom infrastructure. Amazon
  DynamoDB Accelerator (DAX) is a widely cited example at the managed-
  service level: it sits in front of DynamoDB and is configured once to
  know how to load from the table on a miss, so callers only ever talk
  to DAX.
- Deduplicating concurrent loads for the same key is valuable, and
  centralizing the load path makes that feasible to implement once.

## When not to use it

- Different call sites legitimately need different miss-handling
  behavior (different TTLs, different fallback values, different
  stores per caller) — forcing one shared loader configuration removes
  flexibility cache-aside gives each call site for free.
- The cache being unreachable should never take reads down — read-
  through makes the cache a mandatory hop, whereas cache-aside's
  application-level fallback can bypass a broken cache and hit the
  store directly with no special-casing.
- The team wants full visibility and control over exactly when a store
  query happens, for tracing or cost-accounting reasons — that logic is
  implicit inside the cache with read-through, versus explicit and
  inspectable in application code with cache-aside.

## Use-case scenarios

**Managed caching layer in front of a configuration service.** A
platform team runs a shared config-lookup cache used by dozens of
internal microservices, each in a different language. Rather than
publishing a client library that every team has to correctly implement
the miss-handling logic in, the cache is configured with a single
read-through loader that queries the config service, so every caller —
regardless of language — gets identical, correct behavior just by
calling `get(key)`.

**In-process object cache inside a monolith.** A large application has
several modules that all need the same "load a permission set by role
ID" data, previously each writing its own ad hoc caching code with
subtly different bugs. Replacing those with one read-through cache
object, configured once with the loader, removes the duplication and
guarantees every module sees the same value for the same role ID at
the same time.

**CDN-style edge cache for API responses.** An edge caching layer sits
in front of an origin API and is configured to treat cache misses as
"fetch from origin, store, return" transparently to the client making
the request — the client only ever talks to the edge, never
distinguishing a cached response from one the edge just fetched. This
is read-through at the infrastructure level rather than the
application-code level, but the same principle: the caller doesn't
orchestrate the miss path, the caching layer does.

## Related patterns

- [Cache-Aside](/docs/patterns/caching/cache-aside) — the same
  lazy-population idea with the miss-handling logic kept in application
  code instead of the cache itself; read this first for the mechanical
  contrast.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  the cluster-scale infrastructure a read-through cache's loader is
  frequently built on top of.
- [Cache Stampede Prevention](/docs/patterns/caching/cache-stampede-prevention) —
  the single-flight deduplication technique read-through caches are
  well-positioned to implement for concurrent misses on the same key.

## Further reading

- [Caching best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
- [Cache (computing) — Wikipedia](https://en.wikipedia.org/wiki/Cache_(computing))
- DesignGurus' System Design Patterns course covers this as "Read-Through" in its Serving Data Fast (Caching) module.
