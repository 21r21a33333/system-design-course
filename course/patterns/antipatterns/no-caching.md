---
title: "No Caching"
sidebar_position: 7
supplementary: true
---

No caching is failing to cache data that's expensive to compute or
fetch and doesn't change often — recomputing the same aggregate,
re-running the same expensive query, or re-fetching the same external
API response on every single request, when the underlying answer was
identical to the last request and will be identical to the next one.

![No Caching diagram](/img/patterns/no-caching.svg)

## How it manifests

The most direct symptom is a hot code path that performs an expensive
operation — a multi-table join with aggregation, a call to a slow
external API, a computation with real algorithmic cost — on every
single request, even though the inputs and therefore the output are
identical across a large fraction of those requests. A "trending
products" endpoint that recomputes the trending list from scratch,
scanning recent order history, on every page load is a common instance:
the underlying trending list realistically only changes meaningfully
every few minutes, but it's being recalculated dozens of times a
second, once per visitor.

Database load is often the most visible downstream effect: query logs
show the exact same query (same SQL text, same parameters) executed
repeatedly at high frequency, each execution doing full, real work
because there's no layer in front of the database remembering the
answer from the last identical request. This tends to correlate
directly with traffic — the more popular a piece of content or the more
requested a computation, the more redundant, identical work is being
done, which is the opposite of what you'd want, since popular content
is exactly what benefits most from being served from a cache instead of
recomputed. External API calls made without caching compound this with
real latency and often real dollar cost — a third-party pricing or
geocoding API charged per call, hit fresh for every request even when
the same lookup was made seconds ago, both slows down every request
that could've been served from a local cache and multiplies the API
bill for no additional value delivered.

The absence of caching infrastructure is also visible structurally:
no cache layer (in-memory, distributed, or CDN) sits anywhere between
the request handler and the expensive operation, and there's no
cache-hit-rate metric anywhere in the system's dashboards — not because
the hit rate is bad, but because there's no cache to have a hit rate at
all. Latency percentiles for the affected endpoint tend to be
uniformly high (p50 close to p99) rather than showing the bimodal
shape — most requests fast, a smaller tail slow — that's typical of a
system where a cache absorbs the common case and only misses fall
through to the expensive path. Distributed caches like Redis and
Memcached exist specifically to be that layer — a shared, low-latency
place to remember an already-computed answer — and a large share of
their operational value in a real deployment comes down to exactly
this: absorbing the repeat requests that no-caching would otherwise
send straight through to a database or an external API every time.
Skipping that layer entirely doesn't just cost throughput on a good
day — it also removes the one thing that would have absorbed a sudden
spike of identical requests (many clients asking for the same
now-expired or never-cached value at once, a failure mode generally
called a thundering herd) instead of letting all of them hit the
expensive path simultaneously.

## Why it happens

Skipping caching is often not a deliberate decision at all — the
straightforward, obviously-correct version of a feature is "compute the
answer and return it," and that version works completely correctly at
whatever traffic level exists when it's built. Caching adds real
complexity that has nothing to do with the feature's core logic:
picking a TTL, deciding what invalidates the cache, deciding whether
staleness is acceptable and for how long, handling the cache being
unavailable — none of that is needed to make the feature functionally
correct, only to make it fast and cheap at scale, so it's easy to defer
as a later optimization.

It's also easy to underestimate how repetitive real traffic is until
you look — a developer testing a feature locally makes each request
look unique (different test data, deliberate variety), which masks how
often production traffic actually asks the exact same question over
and over (the same popular product page, the same trending list, the
same exchange rate) from many different users. Without measuring actual
request patterns, "this could be cached" is a much less obvious
observation than it looks in hindsight once a query log makes the
repetition undeniable.

## Code example (the antipattern)

```rust
struct Order {
    product_id: u64,
    quantity: u32,
}

struct Db;
impl Db {
    // A real, expensive scan-and-aggregate query over recent orders —
    // run in full on every single call, no matter how recently the
    // same computation was already done.
    fn recent_orders(&self) -> Vec<Order> {
        vec![
            Order { product_id: 1, quantity: 5 },
            Order { product_id: 2, quantity: 9 },
            Order { product_id: 1, quantity: 3 },
        ]
    }
}

// Recomputes the full trending list from a database scan on every
// call, even though the underlying order data only changes slowly
// relative to how often this function is likely to be invoked.
fn trending_product_ids(db: &Db) -> Vec<u64> {
    let orders = db.recent_orders();
    let mut counts: std::collections::HashMap<u64, u32> = std::collections::HashMap::new();
    for order in orders {
        *counts.entry(order.product_id).or_insert(0) += order.quantity;
    }
    let mut ranked: Vec<(u64, u32)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1));
    ranked.into_iter().map(|(id, _)| id).collect()
}
```

## The fix

```rust
use std::time::{Duration, Instant};

struct Order {
    product_id: u64,
    quantity: u32,
}

struct Db;
impl Db {
    fn recent_orders(&self) -> Vec<Order> {
        vec![
            Order { product_id: 1, quantity: 5 },
            Order { product_id: 2, quantity: 9 },
            Order { product_id: 1, quantity: 3 },
        ]
    }
}

// A minimal cache holding the last computed result plus when it was
// computed, so repeated calls within the TTL skip recomputation
// entirely.
struct TrendingCache {
    value: Option<Vec<u64>>,
    computed_at: Option<Instant>,
    ttl: Duration,
}

impl TrendingCache {
    fn new(ttl: Duration) -> Self {
        TrendingCache { value: None, computed_at: None, ttl }
    }

    fn get_or_compute(&mut self, db: &Db) -> Vec<u64> {
        let is_fresh = match self.computed_at {
            Some(t) => t.elapsed() < self.ttl,
            None => false,
        };
        if is_fresh {
            if let Some(cached) = &self.value {
                // Cache hit: the expensive scan-and-aggregate below
                // never runs for this call.
                return cached.clone();
            }
        }
        let orders = db.recent_orders();
        let mut counts: std::collections::HashMap<u64, u32> = std::collections::HashMap::new();
        for order in orders {
            *counts.entry(order.product_id).or_insert(0) += order.quantity;
        }
        let mut ranked: Vec<(u64, u32)> = counts.into_iter().collect();
        ranked.sort_by(|a, b| b.1.cmp(&a.1));
        let result: Vec<u64> = ranked.into_iter().map(|(id, _)| id).collect();

        self.value = Some(result.clone());
        self.computed_at = Some(Instant::now());
        result
    }
}
```

The fix wraps the expensive computation with a TTL-bounded cache: the
first call (or the first call after the TTL expires) pays the real
cost and stores the result, and every call within the TTL window
returns the stored result directly. The TTL bounds how stale the
served data can be, trading a small, deliberately chosen amount of
staleness for avoiding redundant work on every request that asks the
same question the previous request already answered.

## How to detect it

Query logs showing the identical query (same text, same bound
parameters) executed at high frequency, with no cache layer anywhere
upstream of the database, is the most direct evidence — it means every
one of those identical requests is doing full, real work rather than
being served from something that remembers the last answer. Latency
percentiles that are flat across p50 through p99 (rather than showing a
fast common case and a slower tail) on an endpoint serving
predominantly repeat or popular requests suggests every request,
including ones asking an already-answered question, is paying the full
cost. Absence of any cache-hit-rate metric in observability dashboards
for a data-heavy read path is itself a signal worth investigating —
either there's no cache at all, or there is one and nobody's watching
whether it's actually helping.

## When it's actually fine

Data that changes on essentially every read — a live stock quote during
active trading, a real-time inventory count during a flash sale — gains
little or nothing from caching, since a cached value would already be
stale by the time it's served, and the added complexity of managing a
cache with a near-zero effective TTL isn't worth it. Cheap computations
— a lookup that's already an indexed point query returning in
sub-millisecond time — don't have enough cost to amortize; caching adds
overhead (cache lookup, invalidation logic, staleness reasoning) that
can exceed the cost of just doing the cheap thing directly. And for
data where staleness is unacceptable for correctness — a financial
balance immediately after a transaction that must reflect that
transaction on the very next read — skipping caching (or caching with
immediate, synchronous invalidation) is the deliberately correct choice.

## Related patterns

- [Cache-Aside](/docs/patterns/caching/cache-aside) — the standard,
  general-purpose fix for this antipattern: the application checks a
  cache before falling back to the expensive underlying computation or
  store, populating the cache on a miss.
- [Materialized View](/docs/patterns/storage/materialized-view) — a
  complementary fix for expensive aggregations specifically: precompute
  and store the result ahead of time on a schedule, rather than caching
  the result of an on-demand computation after the fact.

## Further reading

- [No Caching antipattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/antipatterns/no-caching/)
- [Cache (computing) — Wikipedia](https://en.wikipedia.org/wiki/Cache_(computing))
- [Thundering herd problem — Wikipedia](https://en.wikipedia.org/wiki/Thundering_herd_problem) — the specific failure mode a missing cache layer leaves fully exposed.
- [System Design roadmap — roadmap.sh](https://roadmap.sh/system-design) — includes No Caching as a named antipattern topic.
