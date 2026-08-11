---
title: "Cache Stampede Prevention"
sidebar_position: 5
supplementary: true
---

Cache stampede prevention is a family of techniques for stopping many
concurrent requests for the same expired or missing cache key from all
falling through to the backing store at once — the "thundering herd"
that turns a single, ordinary cache miss into a synchronized burst of
redundant load capable of overwhelming the store the cache exists to
protect.

![Cache Stampede Prevention diagram](/img/patterns/cache-stampede-prevention.svg)

## Problem it solves

Any of the strategies covered elsewhere in this group — cache-aside,
read-through, even write-through's read side — share an assumption:
when a key isn't in the cache, exactly one request pays the cost of
loading it, and everyone else benefits from the cache afterward. That
assumption holds fine for a low-traffic key, but it breaks down
precisely for the keys that matter most: a hot key with thousands of
requests per second, all sharing the same TTL, expires at one instant —
and every one of those in-flight requests sees a miss at the same
moment, and every one of them independently goes to the store to
reload it. Instead of one load and thousands of cheap hits, the store
receives thousands of *simultaneous, identical* queries for data that a
single query would have sufficed to reload — often enough to overload
or take down the very store the cache was protecting, at exactly the
moment (a hot key going cold) when protection mattered most. Cache
stampede prevention exists to make sure a miss, however popular the
key, triggers at most a small, bounded number of actual loads — not one
per concurrent requester.

## Technical architecture & implementation

**Why a stampede happens mechanically.** The root cause is that a
cache miss is, by default, a stateless event with no memory of other
concurrent misses for the same key — cache-aside's `get_user`, for
instance, has no way of knowing that nine other threads are, at this
exact moment, also querying the store for the same ID it just missed
on. Every one of the three main patterns discussed elsewhere in this
group is equally exposed to this unless something extra is layered on:
write-through and write-behind don't prevent it either, since a
stampede is fundamentally a *read-miss* coordination problem, not a
write-path one. TTL-based expiry makes it worse than random misses
would, because a fixed TTL set at population time means every
concurrent reader of a hot key sees it expire at the *same instant* —
synchronizing the herd instead of spreading misses out over time.

**Request coalescing (single-flight).** The most direct fix: when a
miss occurs for key K, the first request to notice the miss acquires an
in-process or distributed lock for K and proceeds to load it from the
store; every other concurrent request for K, instead of independently
querying the store, waits on that same in-flight load and receives its
result once it completes. This collapses N concurrent misses into
exactly one store query, at the cost of the waiting requests seeing
slightly higher latency than a hit would (they wait for the one load to
finish) — a latency cost that is trivial compared to the alternative of
N requests competing for store capacity at once. This is precisely the
deduplication opportunity mentioned on the [Read-Through](/docs/patterns/caching/read-through)
page: because a read-through cache already centralizes the load path in
one component, it's a natural place to add single-flight coalescing;
cache-aside can do it too, but needs an explicit per-key lock managed
in application code since the loading logic isn't centralized there.

**Early / probabilistic refresh.** A different, complementary fix
attacks the *synchronization* rather than the coordination: instead of
letting every concurrent reader hit the exact same expiry instant, a
small percentage of requests for a key approaching its TTL
probabilistically trigger an early, single background refresh before
the entry actually expires — so by the time the real TTL is reached,
the value has already been quietly refreshed by one of the many
requests that "won" the early-refresh coin flip, and the herd never
materializes because there was no synchronized expiry moment for it to
form around. This trades a slightly higher rate of proactive store
queries (a small number of early refreshes that turn out to have been
unnecessary) for eliminating the failure mode entirely, and composes
well with jittered TTLs — adding a small random offset to each entry's
TTL at write time so that even keys populated at the same moment don't
expire in lockstep.

**Stale-while-revalidate.** A third approach changes what happens to
the *waiting* requests rather than what happens to the *loading*
request: instead of blocking every concurrent reader until a fresh
value is loaded, the cache continues serving the stale (just-expired)
value to readers while exactly one background request refreshes it,
and only starts serving the new value once that refresh completes.
This accepts a short window of intentionally-stale reads in exchange
for zero added latency on the waiting requests and zero extra store
load — a trade that's attractive whenever slightly-stale-but-fast is
preferable to correct-but-slow, which is often true for content that
changes gradually (a homepage feed, a leaderboard) but not for data
where staleness itself is the problem being avoided (an account
balance, for which [Write-Through](/docs/patterns/caching/write-through)
exists specifically to prevent that trade).

**Failure modes of the mitigations themselves.** A single-flight lock
that isn't correctly released on the loader crashing or timing out can
leave every waiting request stuck indefinitely — locks used for
coalescing need their own timeout, independent of the load itself, so
a stuck loader degrades to "everyone reloads independently" rather than
"everyone waits forever." Early refresh, if its probability is tuned
too high, can itself become a meaningful and wasteful source of store
load on very hot keys; tuned too low, it fails to prevent the
stampede it exists to avoid, since a low probability may still let a
significant fraction of near-simultaneous requests fall through
together.

## Code example

```rust
use std::collections::HashMap;

struct Store;

impl Store {
    fn expensive_query(&self, key: &str) -> String {
        format!("value-for-{key}") // stands in for a slow, costly query
    }
}

struct StampedeSafeCache {
    entries: HashMap<String, String>,
    // Keys currently being loaded by some in-flight request — acts as
    // the single-flight lock: presence in this set means "don't load,
    // wait for the entry to show up in `entries` instead."
    loading: HashMap<String, bool>,
}

impl StampedeSafeCache {
    // In a real implementation, a request that finds `loading` already
    // true for this key would block/poll until the entry appears rather
    // than returning immediately — simplified here to show the branch
    // that matters: only the first miss for a key actually queries the
    // store.
    fn get_or_load(&mut self, store: &Store, key: &str) -> String {
        if let Some(hit) = self.entries.get(key) {
            return hit.clone();
        }
        if *self.loading.get(key).unwrap_or(&false) {
            // Another request is already loading this key — a real
            // implementation waits here instead of loading again.
            return self.entries.get(key).cloned()
                .unwrap_or_else(|| "wait-for-in-flight-load".to_string());
        }
        self.loading.insert(key.to_string(), true);
        let value = store.expensive_query(key);
        self.entries.insert(key.to_string(), value.clone());
        self.loading.insert(key.to_string(), false);
        value
    }
}
```

The `loading` map is the coalescing mechanism: it marks a key as
"already being loaded" so a concurrent request checking the same key
takes the wait branch instead of the store-query branch — the store
only ever sees one `expensive_query` call per stampede, not one per
concurrent requester.

## When to use it

- A small number of cache keys receive a disproportionate share of
  traffic (hot keys) and their expiry or eviction is capable of
  generating enough simultaneous load to meaningfully stress the
  backing store.
- Cache entries are populated with a shared, fixed TTL, which
  synchronizes expiry across many concurrent readers of the same key
  rather than spreading reload cost out over time.
- The backing store's capacity is sized for steady-state load, not for
  absorbing a burst equal to the full concurrent request rate of a hot
  key all at once.

## When not to use it

- Traffic is spread evenly across many keys with no significant hot
  spots — the coordination overhead of locking or early-refresh logic
  protects against a failure mode that essentially never occurs for
  this workload.
- The backing store already comfortably absorbs a full burst of
  concurrent identical queries for one key (heavily overprovisioned, or
  the query itself is cheap) — the mitigation adds complexity to solve
  a problem that isn't actually threatening anything.
- Strong consistency between cache and store is required and
  stale-while-revalidate's brief serve-stale window specifically is
  unacceptable — early refresh or single-flight coalescing (which don't
  serve stale data) are the appropriate subset of these techniques
  instead.

## Use-case scenarios

**Flash-sale product page.** An e-commerce site runs a limited-time
sale, and the product page's cache entry — hit by tens of thousands of
concurrent shoppers — expires on its TTL mid-sale. Without protection,
that single expiry turns into tens of thousands of simultaneous
database queries competing with the checkout flow for the same
database connections, at the worst possible moment for that database to
be under extra load. Single-flight coalescing ensures only one of those
tens of thousands of requests actually queries the database; the rest
wait milliseconds for that one load to finish.

**News homepage during a breaking story.** A news site's homepage feed
is cached with a short TTL to keep it reasonably fresh, and it
normally receives moderate, steady traffic. During a breaking-news
spike, concurrent traffic to the homepage jumps by two orders of
magnitude right as the cached feed's TTL expires. Stale-while-
revalidate lets the site keep serving the slightly-stale (seconds old)
homepage to the flood of readers while one background request
refreshes it, rather than making all of them wait on — or worse,
all trigger — a fresh feed computation simultaneously.

**API gateway response cache for a public rate-limited endpoint.** An
API gateway caches responses for a popular public endpoint (say,
current exchange rates) that many downstream clients poll on a similar
interval. When the cached response expires, the gateway uses early
probabilistic refresh so that a small fraction of requests approaching
the TTL trigger a background refresh ahead of time — by the time the
entry's real TTL is reached, it has usually already been quietly
refreshed, and the origin service never sees a burst that lines up with
every client's polling interval converging on the same instant.

## Related patterns

- [Read-Through](/docs/patterns/caching/read-through) — centralizes the
  miss-loading path in the caching layer, which is the natural place to
  implement single-flight coalescing described above.
- [Cache-Aside](/docs/patterns/caching/cache-aside) — equally exposed to
  stampedes on its miss path; coalescing can be added, but requires
  explicit per-key locking in application code since the loading logic
  isn't centralized.
- [Write-Through](/docs/patterns/caching/write-through) — the
  alternative when staleness itself (not just load) is unacceptable,
  ruling out stale-while-revalidate as a mitigation for that data.
- [Distributed Cache](/docs/patterns/building-blocks/distributed-cache) —
  covers the hot-key problem at the cluster-routing level (a hot key
  overwhelming the one node that holds it); this page covers the
  related but distinct problem of a hot key's *expiry* overwhelming the
  backing store.

## Further reading

- [Caching best practices — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/best-practices/caching)
- [Cache stampede — Wikipedia](https://en.wikipedia.org/wiki/Cache_stampede)
